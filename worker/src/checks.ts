import type { MonitorTarget } from '../../types/config'
import type { CheckOutcome } from './stateops'
import { fetchTimeout, withTimeout } from './util'

const DEFAULT_MONITOR_TIMEOUT_MS = 4500

// A single failed check must be confirmed before it opens an incident,
// so a one-off network blip does not page the user.
const FAILURE_CONFIRMATION_ATTEMPTS = 2
const FAILURE_RETRY_DELAY_MS = 3000

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function httpResponseBasicCheck(
  monitor: MonitorTarget,
  code: number,
  bodyReader: () => Promise<string>
): Promise<string | null> {
  if (monitor.expectedCodes) {
    if (!monitor.expectedCodes.includes(code)) {
      return `Expected codes: ${JSON.stringify(monitor.expectedCodes)}, Got: ${code}`
    }
  } else {
    if (code < 200 || code > 299) {
      return `Expected codes: 2xx, Got: ${code}`
    }
  }

  if (monitor.responseKeyword || monitor.responseForbiddenKeyword) {
    // Only read the response body if we have a keyword to check
    const responseBody = await bodyReader()

    if (monitor.responseKeyword && !responseBody.includes(monitor.responseKeyword)) {
      console.log(
        `${monitor.name} expected keyword ${
          monitor.responseKeyword
        }, not found in response (truncated to 100 chars): ${responseBody.slice(0, 100)}`
      )
      return "HTTP response doesn't contain the configured keyword"
    }

    if (monitor.responseForbiddenKeyword && responseBody.includes(monitor.responseForbiddenKeyword)) {
      console.log(
        `${monitor.name} forbidden keyword ${
          monitor.responseForbiddenKeyword
        }, found in response (truncated to 100 chars): ${responseBody.slice(0, 100)}`
      )
      return 'HTTP response contains the configured forbidden keyword'
    }
  }

  return null
}

export async function getStatus(
  monitor: MonitorTarget
): Promise<{ ping: number; up: boolean; err: string }> {
  let status = {
    ping: 0,
    up: false,
    err: 'Unknown',
  }

  const startTime = Date.now()

  if (monitor.method === 'TCP_PING') {
    // TCP port endpoint monitor
    try {
      const connect = await import(/* webpackIgnore: true */ 'cloudflare:sockets').then(
        (sockets) => sockets.connect
      )
      // This is not a real https connection, but we need a dummy `https://` to parse hostname & port
      const parsed = new URL('https://' + monitor.target)
      const socket = connect({ hostname: parsed.hostname, port: Number(parsed.port) })

      await withTimeout(monitor.timeout || DEFAULT_MONITOR_TIMEOUT_MS, socket.opened)
      await socket.close()

      console.log(`${monitor.name} connected to ${monitor.target}`)

      status.ping = Date.now() - startTime
      status.up = true
      status.err = ''
    } catch (e: Error | any) {
      console.log(`${monitor.name} errored with ${e.name}: ${e.message}`)
      if (e.message.includes('timed out')) {
        status.ping = monitor.timeout || DEFAULT_MONITOR_TIMEOUT_MS
      }
      status.up = false
      status.err = e.name + ': ' + e.message
    }
  } else {
    // HTTP endpoint monitor
    try {
      let headers = new Headers(monitor.headers as any)
      if (!headers.has('user-agent')) {
        headers.set('user-agent', 'ServiceStatus/1.0')
      }

      const response = await fetchTimeout(
        monitor.target,
        monitor.timeout || DEFAULT_MONITOR_TIMEOUT_MS,
        {
          method: monitor.method,
          headers: headers,
          body: monitor.body,
          cf: {
            // Never let Cloudflare cache a monitored endpoint
            cacheTtlByStatus: { '100-599': -1 },
          },
        }
      )

      console.log(`${monitor.name} responded with ${response.status}`)
      status.ping = Date.now() - startTime

      const err = await httpResponseBasicCheck(monitor, response.status, response.text.bind(response))
      try {
        await response.body?.cancel()
      } catch (e) {} // Always try to cancel the body, see upstream issue #166

      if (err !== null) {
        console.log(`${monitor.name} didn't pass response check: ${err}`)
      }
      status.up = err === null
      status.err = err ?? ''
    } catch (e: any) {
      console.log(`${monitor.name} errored with ${e.name}: ${e.message}`)
      if (e.name === 'AbortError') {
        status.ping = monitor.timeout || DEFAULT_MONITOR_TIMEOUT_MS
        status.up = false
        status.err = `Timeout after ${status.ping}ms`
      } else {
        status.up = false
        status.err = e.name + ': ' + e.message
      }
    }
  }

  return status
}

// Run one confirmed check. `checkLocation` describes where the check ran and
// is kept per data point so latency charts can show it.
export async function checkMonitor(
  monitor: MonitorTarget,
  workerLocation: string
): Promise<CheckOutcome> {
  let lastResult: { ping: number; up: boolean; err: string } | null = null

  for (let attempt = 1; attempt <= FAILURE_CONFIRMATION_ATTEMPTS; attempt += 1) {
    console.log(`[${workerLocation}] Checking ${monitor.name} (attempt ${attempt})...`)
    const status = await getStatus(monitor)
    if (status.up) {
      lastResult = status
      break
    }

    lastResult = status
    if (attempt < FAILURE_CONFIRMATION_ATTEMPTS) {
      console.log(
        `[${workerLocation}] ${monitor.name} failed check ${attempt}/${FAILURE_CONFIRMATION_ATTEMPTS}, retrying in ${FAILURE_RETRY_DELAY_MS}ms...`
      )
      await wait(FAILURE_RETRY_DELAY_MS)
    }
  }

  return {
    monitor,
    checkLocation: workerLocation,
    checkedAt: Math.round(Date.now() / 1000),
    status: lastResult!,
  }
}
