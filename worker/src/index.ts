import { DurableObject } from 'cloudflare:workers'
import type { MonitorTarget } from '../../types/config'
import {
  META_KEY,
  incidentKey,
  latencyKey,
  type IncidentRow,
  type LatencyRow,
  type MetaRow,
} from '../../lib/state-format'
import { getEffectiveWorkerConfig, type RuntimeEnv } from '../../util/runtimeConfig'
import { SchedulerError } from '../../util/schedulerClient'
import { checkMonitor } from './checks'
import { migrateIfNeeded } from './migrate'
import { dispatchNotices } from './notify'
import { SchedulerState } from './scheduler'
import {
  changeFrom,
  commitChanges,
  parseIncidentRow,
  parseLatencyRow,
  readStateSnapshot,
  readValue,
  type RowChange,
} from './store'
import { applyRound, type CheckOutcome } from './stateops'
import { getWorkerLocation } from './util'

export interface Env extends RuntimeEnv {
  MONITOR_TRIGGER_SECRET?: string
}

const MONITOR_CHECK_CONCURRENCY = 4
const CHECK_INTERVAL_MS = 10 * 60 * 1000

function getScheduler(env: Env) {
  const namespace = env.MONITOR_SCHEDULER_DO
  if (!namespace) throw new Error('MONITOR_SCHEDULER_DO binding is missing')
  return namespace.get(namespace.idFromName('default'))
}

// One check round: read the row snapshot, check every monitor, apply the
// transitions, commit atomically, and only then dispatch notifications.
export async function runChecks(env: Env, authoritativeMonitors?: MonitorTarget[]): Promise<void> {
  const workerConfig = await getEffectiveWorkerConfig(env, authoritativeMonitors)
  if (workerConfig.monitors.length === 0) {
    console.log('No monitors configured, skipping scheduled check.')
    return
  }

  const workerLocation = (await getWorkerLocation()) || 'ERROR'
  const now = Math.round(Date.now() / 1000)
  console.log(`Running check round on ${workerLocation}...`)

  const snapshot = await readStateSnapshot(env)

  const latRows = new Map<string, LatencyRow>()
  for (const [id, row] of snapshot.lat) {
    const parsed = parseLatencyRow(row)
    if (parsed) latRows.set(id, parsed)
  }
  const incRows = new Map<string, IncidentRow>()
  for (const [id, row] of snapshot.inc) {
    const parsed = parseIncidentRow(row)
    if (parsed) incRows.set(id, parsed)
  }

  const outcomes: CheckOutcome[] = []
  for (let start = 0; start < workerConfig.monitors.length; start += MONITOR_CHECK_CONCURRENCY) {
    const results = await Promise.all(
      workerConfig.monitors
        .slice(start, start + MONITOR_CHECK_CONCURRENCY)
        .map((monitor) => checkMonitor(monitor, workerLocation))
    )
    outcomes.push(...results)
  }

  const { meta, latChanged, incChanged, notices } = applyRound({
    outcomes,
    latRows,
    incRows,
    notification: workerConfig.notification,
    now,
  })

  const changes: RowChange[] = [changeFrom(snapshot.meta, JSON.stringify(meta))]
  for (const [id, row] of latChanged) {
    changes.push(
      changeFrom(snapshot.lat.get(id) ?? { key: latencyKey(id), value: null }, JSON.stringify(row))
    )
  }
  for (const [id, row] of incChanged) {
    changes.push(
      changeFrom(snapshot.inc.get(id) ?? { key: incidentKey(id), value: null }, JSON.stringify(row))
    )
  }

  await commitChanges(env, changes)
  console.log(
    `Round committed: ${changes.length} row(s), up=${meta.overallUp}, down=${meta.overallDown}, notices=${notices.length}`
  )

  await dispatchNotices(notices, workerConfig.notification)
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers)
  headers.set('content-type', 'application/json;charset=UTF-8')
  return new Response(JSON.stringify(body), { ...init, headers })
}

function isAuthorizedTrigger(request: Request, env: Env): boolean {
  const secret = env.MONITOR_TRIGGER_SECRET
  if (!secret) return false
  const header = request.headers.get('authorization')
  if (header === `Bearer ${secret}`) return true
  const url = new URL(request.url)
  return url.searchParams.get('secret') === secret
}

const Worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const colo = await getWorkerLocation(request)

    if (url.pathname === '/trigger' || url.searchParams.get('trigger') === '1') {
      if (!['GET', 'POST'].includes(request.method)) {
        return jsonResponse({ error: 'method not allowed' }, { status: 405 })
      }
      if (!isAuthorizedTrigger(request, env)) {
        return jsonResponse({ error: 'unauthorized' }, { status: 401 })
      }
      ctx.waitUntil(getScheduler(env).runNow())
      return jsonResponse(
        { triggered: true, startedAt: Math.round(Date.now() / 1000) },
        { headers: { 'cache-control': 'no-store' } }
      )
    }

    if (request.method !== 'GET' || (url.pathname !== '/' && url.pathname !== '/health')) {
      return jsonResponse({ healthy: false, error: 'not found' }, { status: 404 })
    }

    let migrated = false
    try {
      migrated = await migrateIfNeeded(env)
    } catch (err) {
      console.log('Migration failed: ' + err)
    }

    let nextAlarm: number | null = null
    try {
      nextAlarm = (await getScheduler(env).ensureAlarm()).nextAlarm
    } catch (err) {
      console.log('Failed to arm monitor scheduler: ' + err)
    }

    let meta: MetaRow = { lastUpdate: 0, overallUp: 0, overallDown: 0 }
    try {
      const metaRaw = await readValue(env, META_KEY)
      if (metaRaw !== null) meta = JSON.parse(metaRaw) as MetaRow
    } catch (err) {
      console.log('Failed to read meta row: ' + err)
    }

    let monitorCount = 0
    try {
      monitorCount = (await getEffectiveWorkerConfig(env)).monitors.length
    } catch (err) {
      console.log('Failed to read monitors for health: ' + err)
    }

    const nowSec = Math.round(Date.now() / 1000)
    const nowMs = Date.now()

    return jsonResponse(
      {
        healthy: true,
        workerLocation: colo || null,
        lastUpdate: meta.lastUpdate,
        lastRunAgoSec: meta.lastUpdate ? nowSec - meta.lastUpdate : null,
        nextAlarm,
        nextAlarmInSec: nextAlarm ? Math.max(0, Math.round((nextAlarm - nowMs) / 1000)) : null,
        monitorCount,
        migrated: migrated || undefined,
        serverTime: nowSec,
      },
      { headers: { 'cache-control': 'no-store' } }
    )
  },

  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    // Cron is a supervisor only: migrate if needed, then make sure the DO
    // alarm is armed (and force-re-arm if rounds went stale).
    try {
      await migrateIfNeeded(env)
    } catch (err) {
      console.log('Migration failed in cron: ' + err)
    }
    try {
      const result = await getScheduler(env).healIfStale()
      if (result.healed) console.log('Cron healed the monitor scheduler alarm.')
    } catch (err) {
      console.log('Failed to heal monitor scheduler from cron: ' + err)
    }
  },
}

export default Worker

export class MonitorScheduler extends DurableObject {
  private scheduler: SchedulerState

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.scheduler = new SchedulerState(ctx.storage, env, (monitors) => runChecks(env, monitors))
  }

  async ensureAlarm(): Promise<{ nextAlarm: number }> {
    return this.scheduler.ensureAlarm()
  }

  async healIfStale(): Promise<{ healed: boolean }> {
    return this.scheduler.healIfStale()
  }

  async runNow(): Promise<void> {
    return this.scheduler.runNow()
  }

  async alarm(): Promise<void> {
    await this.scheduler.runNow()
  }

  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== '/monitors') {
      return jsonResponse({ error: 'not found' }, { status: 404 })
    }
    try {
      if (request.method === 'GET') return jsonResponse({ monitors: await this.listMonitors() })
      if (request.method === 'POST') {
        return jsonResponse({ monitors: await this.addMonitor(await request.json<MonitorTarget>()) })
      }
      if (request.method === 'PUT') {
        return jsonResponse({
          monitors: await this.updateMonitor(await request.json<MonitorTarget>()),
        })
      }
      if (request.method === 'DELETE') {
        const { id } = await request.json<{ id: string }>()
        return jsonResponse({ monitors: await this.deleteMonitor(id) })
      }
      return jsonResponse({ error: 'method not allowed' }, { status: 405 })
    } catch (error) {
      return jsonResponse(
        { error: error instanceof Error ? error.message : 'Scheduler request failed' },
        { status: error instanceof SchedulerError ? error.status : 500 }
      )
    }
  }

  async addMonitor(monitor: MonitorTarget): Promise<MonitorTarget[]> {
    return this.scheduler.addMonitor(monitor)
  }

  async updateMonitor(monitor: MonitorTarget): Promise<MonitorTarget[]> {
    return this.scheduler.updateMonitor(monitor)
  }

  async listMonitors(): Promise<MonitorTarget[]> {
    return this.scheduler.listMonitors()
  }

  async deleteMonitor(id: string): Promise<MonitorTarget[]> {
    return this.scheduler.deleteMonitor(id)
  }
}
