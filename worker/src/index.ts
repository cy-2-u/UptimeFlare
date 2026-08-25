import { DurableObject } from 'cloudflare:workers'
import { MonitorTarget } from '../../types/config'
import { getStatus, getStatusWithGlobalPing } from './monitor'
import { formatAndNotify, getWorkerLocation } from './util'
import { CompactedMonitorStateWrapper, getFromStore, setToStore } from './store'
import { getEffectiveWorkerConfig } from '../../util/runtimeConfig'

export interface Env {
  UPTIMEFLARE_STATE: KVNamespace
  UPTIMEFLARE_CONFIG: KVNamespace
  REMOTE_CHECKER_DO: DurableObjectNamespace<RemoteChecker>
  UPTIMEFLARE_D1: D1Database
  [key: string]: any
}

const MONITOR_CHECK_CONCURRENCY = 4
const MONITOR_FAILURE_CONFIRMATION_ATTEMPTS = 3
const MONITOR_FAILURE_RETRY_DELAY_MS = 5000

type MonitorCheckResult = {
  monitor: MonitorTarget
  checkLocation: string
  checkedAt: number
  status: {
    ping: number
    up: boolean
    err: string
  }
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function checkMonitorOnce(
  env: Env,
  monitor: MonitorTarget,
  workerLocation: string
): Promise<MonitorCheckResult> {
  console.log(`[${workerLocation}] Checking ${monitor.name}...`)

  let checkLocation = workerLocation
  let status: MonitorCheckResult['status']

  if (monitor.checkProxy) {
    try {
      console.log('Calling check proxy: ' + monitor.checkProxy)
      let resp
      if (monitor.checkProxy.startsWith('worker://')) {
        const doLoc = monitor.checkProxy.replace('worker://', '')
        const doId = env.REMOTE_CHECKER_DO.idFromName(doLoc)
        const doStub = env.REMOTE_CHECKER_DO.get(doId, {
          locationHint: doLoc as DurableObjectLocationHint,
        })
        resp = await doStub.getLocationAndStatus(monitor)
        try {
          // Kill the DO instance after use, to avoid extra resource usage
          await doStub.kill()
        } catch (err) {
          // An error here is expected, ignore it
        }
      } else if (monitor.checkProxy.startsWith('globalping://')) {
        resp = await getStatusWithGlobalPing(monitor)
      } else {
        resp = await (
          await fetch(monitor.checkProxy, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(monitor),
          })
        ).json<{ location: string; status: { ping: number; up: boolean; err: string } }>()
      }
      checkLocation = resp.location
      status = resp.status
    } catch (err) {
      console.log('Error calling proxy: ' + err)
      if (monitor.checkProxyFallback) {
        console.log('Falling back to local check...')
        status = await getStatus(monitor)
      } else {
        status = { ping: 0, up: false, err: 'Unknown check proxy error' }
      }
    }
  } else {
    status = await getStatus(monitor)
  }

  return {
    monitor,
    checkLocation,
    checkedAt: Math.round(Date.now() / 1000),
    status,
  }
}

async function checkMonitor(
  env: Env,
  monitor: MonitorTarget,
  workerLocation: string
): Promise<MonitorCheckResult> {
  let lastResult: MonitorCheckResult | null = null

  for (let attempt = 1; attempt <= MONITOR_FAILURE_CONFIRMATION_ATTEMPTS; attempt += 1) {
    const result = await checkMonitorOnce(env, monitor, workerLocation)
    if (result.status.up) return result

    lastResult = result
    if (attempt < MONITOR_FAILURE_CONFIRMATION_ATTEMPTS) {
      console.log(
        `[${workerLocation}] ${monitor.name} failed check ${attempt}/${MONITOR_FAILURE_CONFIRMATION_ATTEMPTS}, retrying in ${MONITOR_FAILURE_RETRY_DELAY_MS}ms...`
      )
      await wait(MONITOR_FAILURE_RETRY_DELAY_MS)
    }
  }

  return lastResult!
}

async function runChecks(env: Env): Promise<void> {
    const workerConfig = await getEffectiveWorkerConfig(env)
    if (workerConfig.monitors.length === 0) {
      console.log('No monitors configured, skipping scheduled check.')
      return
    }

    const workerLocation = (await getWorkerLocation()) || 'ERROR'
    console.log(`Running scheduled event on ${workerLocation}...`)

    // Create a wrapped MonitorState from stored compacted state
    const state = new CompactedMonitorStateWrapper(await getFromStore(env, 'state'))
    state.data.overallDown = 0
    state.data.overallUp = 0

    let statusChanged = false
    const currentTimeSecond = Math.round(Date.now() / 1000)

    for (let start = 0; start < workerConfig.monitors.length; start += MONITOR_CHECK_CONCURRENCY) {
      const results = await Promise.all(
        workerConfig.monitors
          .slice(start, start + MONITOR_CHECK_CONCURRENCY)
          .map((monitor) => checkMonitor(env, monitor, workerLocation))
      )

      for (const { monitor, checkLocation, checkedAt: currentTimeSecond, status } of results) {
        let monitorStatusChanged = false

        // Update counters
        status.up ? state.data.overallUp++ : state.data.overallDown++

        // Update incidents
        // Create a dummy incident to store the start time of the monitoring and simplify logic
        if (state.incidentLen(monitor.id) === 0) {
          state.appendIncident(monitor.id, {
            start: [currentTimeSecond],
            end: currentTimeSecond,
            error: ['dummy'],
          })
        }

        // Then lastIncident here must not be null
        let lastIncident = state.getIncident(monitor.id, state.incidentLen(monitor.id) - 1)

        if (status.up) {
          // Current status is up
          // close existing incident if any
          if (lastIncident.end === null) {
            lastIncident.end = currentTimeSecond
            // write back the modified last incident
            state.setIncident(monitor.id, state.incidentLen(monitor.id) - 1, lastIncident)

            monitorStatusChanged = true
            try {
              await formatAndNotify(monitor, true, lastIncident.start[0], currentTimeSecond, 'OK')

              console.log('Calling config onStatusChange callback...')
              await workerConfig.callbacks?.onStatusChange?.(
                env,
                monitor,
                true,
                lastIncident.start[0],
                currentTimeSecond,
                'OK'
              )
            } catch (e) {
              console.log('Error calling callback: ')
              console.log(e)
            }
          }
        } else {
          // Current status is down
          // open new incident if not already open
          if (lastIncident.end !== null) {
            state.appendIncident(monitor.id, {
              start: [currentTimeSecond],
              end: null,
              error: [status.err],
            })
            monitorStatusChanged = true
          } else if (lastIncident.end === null && lastIncident.error.slice(-1)[0] !== status.err) {
            // append if the error message changes
            lastIncident.start.push(currentTimeSecond)
            lastIncident.error.push(status.err)

            // write back the modified last incident
            state.setIncident(monitor.id, state.incidentLen(monitor.id) - 1, lastIncident)
            monitorStatusChanged = true
          }

          const currentIncident = state.getIncident(monitor.id, state.incidentLen(monitor.id) - 1)
          try {
            if (
              // monitor status changed AND...
              (monitorStatusChanged &&
                // grace period not set OR ...
                (workerConfig.notification?.gracePeriod === undefined ||
                  // have sent a notification for DOWN status
                  currentTimeSecond - currentIncident.start[0] >=
                    (workerConfig.notification.gracePeriod + 1) * 60 - 30)) ||
              // grace period is set AND...
              (workerConfig.notification?.gracePeriod !== undefined &&
                // grace period is met
                currentTimeSecond - currentIncident.start[0] >=
                  workerConfig.notification.gracePeriod * 60 - 30 &&
                currentTimeSecond - currentIncident.start[0] <
                  workerConfig.notification.gracePeriod * 60 + 30)
            ) {
              if (
                currentIncident.start[0] !== currentTimeSecond &&
                workerConfig.notification?.skipErrorChangeNotification
              ) {
                console.log('Skipping notification for following error reason change due to user config')
              } else {
                await formatAndNotify(
                  monitor,
                  false,
                  currentIncident.start[0],
                  currentTimeSecond,
                  status.err
                )
              }
            } else {
              console.log(
                `Grace period (${workerConfig.notification
                  ?.gracePeriod}m) not met or no change (currently down for ${
                  currentTimeSecond - currentIncident.start[0]
                }s, changed ${monitorStatusChanged}), skipping webhook DOWN notification for ${
                  monitor.name
                }`
              )
            }

            if (monitorStatusChanged) {
              console.log('Calling config onStatusChange callback...')
              await workerConfig.callbacks?.onStatusChange?.(
                env,
                monitor,
                false,
                currentIncident.start[0],
                currentTimeSecond,
                status.err
              )
            }
          } catch (e) {
            console.log('Error calling callback: ')
            console.log(e)
          }

          try {
            console.log('Calling config onIncident callback...')
            await workerConfig.callbacks?.onIncident?.(
              env,
              monitor,
              currentIncident.start[0],
              currentTimeSecond,
              status.err
            )
          } catch (e) {
            console.log('Error calling callback: ')
            console.log(e)
          }
        }

        // append to latency data
        state.appendLatency(monitor.id, {
          loc: checkLocation,
          ping: status.ping,
          time: currentTimeSecond,
        })

        // discard old data
        while (state.getFirstLatency(monitor.id).time < currentTimeSecond - 12 * 60 * 60) {
          state.unshiftLatency(monitor.id)
        }

        // discard old incidents
        while (
          state.incidentLen(monitor.id) > 0 &&
          state.getIncident(monitor.id, 0).end &&
          state.getIncident(monitor.id, 0).end! < currentTimeSecond - 90 * 24 * 60 * 60
        ) {
          state.shiftIncident(monitor.id)
        }

        if (
          state.incidentLen(monitor.id) === 0 ||
          (state.getIncident(monitor.id, 0).start[0] > currentTimeSecond - 90 * 24 * 60 * 60 &&
            state.getIncident(monitor.id, 0).error[0] != 'dummy')
        ) {
          // put the dummy incident back
          state.unshiftIncident(monitor.id, {
            start: [currentTimeSecond - 90 * 24 * 60 * 60],
            end: currentTimeSecond - 90 * 24 * 60 * 60,
            error: ['dummy'],
          })
        }

        statusChanged ||= monitorStatusChanged
      }
    }

    console.log(
      `statusChanged: ${statusChanged}, lastUpdate: ${state.data.lastUpdate}, currentTime: ${currentTimeSecond}`
    )
    // Update state
    // Allow for a cooldown period before writing to storage
    if (
      statusChanged ||
      currentTimeSecond - state.data.lastUpdate >=
        (workerConfig.kvWriteCooldownMinutes ?? 3) * 60 - 10 // Allow for 10 seconds of clock drift
    ) {
      console.log('Updating state...')
      state.data.lastUpdate = currentTimeSecond
      await setToStore(env, 'state', state.getCompactedStateStr())
    } else {
      console.log('Skipping state update due to cooldown period.')
    }
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers)
  headers.set('content-type', 'application/json;charset=UTF-8')
  return new Response(JSON.stringify(body), { ...init, headers })
}

const Worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/trigger' || url.searchParams.get('trigger') === '1') {
      if (!['GET', 'POST'].includes(request.method)) {
        return jsonResponse({ error: 'method not allowed' }, { status: 405 })
      }
      ctx.waitUntil(runChecks(env))
      return jsonResponse({ triggered: true, startedAt: Math.round(Date.now() / 1000) })
    }

    if (request.method !== 'GET' || (url.pathname !== '/' && url.pathname !== '/health')) {
      return jsonResponse({ healthy: false, error: 'not found' }, { status: 404 })
    }

    const state = new CompactedMonitorStateWrapper(await getFromStore(env, 'state'))
    const workerConfig = await getEffectiveWorkerConfig(env)
    const lastUpdate = state.data.lastUpdate
    const nowSec = Math.round(Date.now() / 1000)

    return jsonResponse(
      {
        healthy: true,
        workerLocation: (await getWorkerLocation()) || null,
        lastUpdate,
        lastRunAgoSec: lastUpdate ? nowSec - lastUpdate : null,
        monitorCount: workerConfig.monitors.length,
        stateBytes: new TextEncoder().encode(state.getCompactedStateStr()).byteLength,
        serverTime: nowSec,
      },
      { headers: { 'cache-control': 'public, s-maxage=15' } }
    )
  },

  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    await runChecks(env)
  },
}

export default Worker

export class RemoteChecker extends DurableObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
  }

  async getLocationAndStatus(
    monitor: MonitorTarget
  ): Promise<{ location: string; status: { ping: number; up: boolean; err: string } }> {
    const colo = (await getWorkerLocation()) as string
    console.log(`Running remote checker (DurableObject) at ${colo}...`)
    const status = await getStatus(monitor)
    return {
      location: colo,
      status: status,
    }
  }

  async kill() {
    // Throwing an error in `blockConcurrencyWhile` will terminate the Durable Object instance
    // https://developers.cloudflare.com/durable-objects/api/state/#blockconcurrencywhile
    this.ctx.blockConcurrencyWhile(async () => {
      throw 'killed'
    })
  }
}
