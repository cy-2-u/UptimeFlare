import { MonitorTarget } from '../../types/config'
import { maintenances, workerConfig } from '../../uptime.config'
import { sendNotification } from './notification'

let cachedColo: string | undefined

function coloFromRequest(request?: Request): string | undefined {
  const colo = request?.cf?.colo
  return typeof colo === 'string' && colo ? colo : undefined
}

async function getWorkerLocation(request?: Request) {
  const fromRequest = coloFromRequest(request)
  if (fromRequest) {
    cachedColo = fromRequest
    return fromRequest
  }
  if (cachedColo) return cachedColo

  const res = await fetch('https://cloudflare.com/cdn-cgi/trace')
  const text = await res.text()
  const colo = /^colo=(.*)$/m.exec(text)?.[1]
  if (colo) cachedColo = colo
  return colo
}

const fetchTimeout = (
  url: string,
  ms: number,
  { signal, ...options }: RequestInit<RequestInitCfProperties> | undefined = {}
): Promise<Response> => {
  const controller = new AbortController()
  const promise = fetch(url, { signal: controller.signal, ...options })
  if (signal) signal.addEventListener('abort', () => controller.abort())
  const timeout = setTimeout(() => controller.abort(), ms)
  return promise.finally(() => clearTimeout(timeout))
}

function withTimeout<T>(millis: number, promise: Promise<T>): Promise<T> {
  const timeout = new Promise<T>((resolve, reject) =>
    setTimeout(() => reject(new Error(`Promise timed out after ${millis}ms`)), millis)
  )

  return Promise.race([promise, timeout])
}

const formatAndNotify = async (
  monitor: MonitorTarget,
  isUp: boolean,
  timeIncidentStart: number,
  timeNow: number,
  reason: string
) => {
  // Skip notification if monitor is in the skip list
  const skipList = workerConfig.notification?.skipNotificationIds
  if (skipList && skipList.includes(monitor.id)) {
    console.log(`Skipping notification for ${monitor.name} (${monitor.id} in skipNotificationIds)`)
    return
  }

  // Skip notification if monitor is in maintenance
  const maintenanceList = maintenances
    .filter(
      (m) =>
        new Date(timeNow * 1000) >= new Date(m.start) &&
        (!m.end || new Date(timeNow * 1000) <= new Date(m.end))
    )
    .map((e) => e.monitors || [])
    .flat()

  if (maintenanceList.includes(monitor.id)) {
    console.log(`Skipping notification for ${monitor.name} (in maintenance)`)
    return
  }

  await sendNotification({
    monitor,
    isUp,
    timeIncidentStart,
    timeNow,
    reason,
    timeZone: workerConfig.notification?.timeZone ?? 'Etc/GMT',
  })
}

export {
  getWorkerLocation,
  fetchTimeout,
  withTimeout,
  formatAndNotify,
}
