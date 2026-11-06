import type { MonitorTarget } from './types'
import { fetchTimeout } from './util'

const DEFAULT_MONITOR_TIMEOUT_MS = 4500

// A single failed check must be confirmed before it opens an incident,
// so a one-off network blip does not page the user.
const FAILURE_CONFIRMATION_ATTEMPTS = 2
const FAILURE_RETRY_DELAY_MS = 3000

// Error strings land in incidents, notifications and the public status page;
// cap them so a chatty exception (TLS/DNS dumps) cannot bloat stored state.
const MAX_ERROR_LENGTH = 300

export type CheckOutcome = {
  monitor: MonitorTarget
  checkLocation: string
  checkedAt: number
  status: { ping: number; up: boolean; err: string }
}

function httpResponseBasicCheck(code: number): string | null {
  if (code < 200 || code > 299) {
    return `Expected codes: 2xx, Got: ${code}`
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

  try {
    const headers = new Headers()
    headers.set('user-agent', 'ServiceStatus/1.0')

    const response = await fetchTimeout(
      monitor.target,
      monitor.timeout || DEFAULT_MONITOR_TIMEOUT_MS,
      {
        method: 'GET',
        headers: headers,
        cf: {
          // Never let Cloudflare cache a monitored endpoint
          cacheTtlByStatus: { '100-599': -1 },
        },
      }
    )

    console.log(`${monitor.name} responded with ${response.status}`)
    status.ping = Date.now() - startTime

    const err = httpResponseBasicCheck(response.status)
    try {
      await response.body?.cancel()
    } catch (e) {} // Always try to cancel the body (upstream issue #166)

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
      status.err = (e.name + ': ' + e.message).slice(0, MAX_ERROR_LENGTH)
    }
  }

  return status
}

// Run one confirmed check. `checkLocation` describes where the check ran and
// is kept per data point so latency charts can show it.
export async function checkMonitor(
  monitor: MonitorTarget,
  workerLocation: string
): Promise<{ monitor: MonitorTarget; checkLocation: string; checkedAt: number; status: { ping: number; up: boolean; err: string } }> {
  let lastResult: { ping: number; up: boolean; err: string } | null = null

  for (let attempt = 1; attempt <= FAILURE_CONFIRMATION_ATTEMPTS; attempt += 1) {
    console.log(`[${workerLocation}] Checking ${monitor.name} (attempt ${attempt})...`)
    const status = await getStatus(monitor)
    if (status.up) return { monitor, checkLocation: workerLocation, checkedAt: Math.round(Date.now() / 1000), status }
    lastResult = status
    if (attempt < FAILURE_CONFIRMATION_ATTEMPTS) {
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

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
