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

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function getStatus(monitor: MonitorTarget): Promise<CheckOutcome['status']> {
  const startTime = Date.now()
  try {
    const headers = new Headers({ 'user-agent': 'ServiceStatus/1.0' })
    const response = await fetchTimeout(monitor.target, monitor.timeout || DEFAULT_MONITOR_TIMEOUT_MS, {
      method: 'GET',
      headers,
      cf: { cacheTtlByStatus: { '100-599': -1 } }, // never let CF cache a monitored endpoint
    })

    console.log(`${monitor.name} responded with ${response.status}`)
    const ping = Date.now() - startTime
    const err = response.status < 200 || response.status > 299 ? `Expected codes: 2xx, Got: ${response.status}` : null
    try {
      await response.body?.cancel() // upstream issue #166
    } catch {}

    if (err) console.log(`${monitor.name} didn't pass response check: ${err}`)
    return { ping, up: err === null, err: err ?? '' }
  } catch (e: any) {
    console.log(`${monitor.name} errored with ${e.name}: ${e.message}`)
    if (e.name === 'AbortError') {
      const ping = monitor.timeout || DEFAULT_MONITOR_TIMEOUT_MS
      return { ping, up: false, err: `Timeout after ${ping}ms` }
    }
    return { ping: Date.now() - startTime, up: false, err: (e.name + ': ' + e.message).slice(0, MAX_ERROR_LENGTH) }
  }
}

// Run one confirmed check. `checkLocation` describes where the check ran and
// is kept per data point so latency charts can show it.
export async function checkMonitor(
  monitor: MonitorTarget,
  workerLocation: string
): Promise<CheckOutcome> {
  let lastStatus: CheckOutcome['status'] | null = null

  for (let attempt = 1; attempt <= FAILURE_CONFIRMATION_ATTEMPTS; attempt += 1) {
    console.log(`[${workerLocation}] Checking ${monitor.name} (attempt ${attempt})...`)
    const status = await getStatus(monitor)
    if (status.up) {
      return { monitor, checkLocation: workerLocation, checkedAt: now(), status }
    }
    lastStatus = status
    if (attempt < FAILURE_CONFIRMATION_ATTEMPTS) await wait(FAILURE_RETRY_DELAY_MS)
  }

  return { monitor, checkLocation: workerLocation, checkedAt: now(), status: lastStatus! }
}

const now = () => Math.round(Date.now() / 1000)
