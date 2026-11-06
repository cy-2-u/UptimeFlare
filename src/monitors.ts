import type { MonitorTarget, RuntimeBindings } from './types'

export class SchedulerError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message)
  }
}

// Fetch the page-managed monitor list from the MonitorScheduler Durable
// Object. Used by the web routes of this same Worker through the DO binding.
export async function schedulerMonitors(
  env: RuntimeBindings,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET',
  body?: MonitorTarget | { id: string }
): Promise<MonitorTarget[]> {
  const namespace = env.MONITOR_SCHEDULER_DO
  if (!namespace) throw new Error('MONITOR_SCHEDULER_DO binding is missing')
  const response = await namespace
    .get(namespace.idFromName('default'))
    .fetch('https://scheduler/monitors', {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  const result = await response.json<{ monitors?: MonitorTarget[]; error?: string }>()
  if (!response.ok || !result.monitors) {
    throw new SchedulerError(
      result.error || 'Scheduler request failed',
      response.ok ? 502 : response.status
    )
  }
  return result.monitors
}

// Monitor list with a short isolate-local cache (60s): the list changes
// rarely but is read on every page render. Writes bypass and clear it.
type MonitorsCache = { at: number; monitors: MonitorTarget[] }
const cacheStore = globalThis as unknown as { __uptimeMonitorsCache?: MonitorsCache }
const MONITORS_CACHE_TTL_MS = 60_000

export async function getStoredMonitors(
  env: RuntimeBindings,
  options?: { fresh?: boolean }
): Promise<MonitorTarget[]> {
  if (!env.MONITOR_SCHEDULER_DO) return []
  const cached = cacheStore.__uptimeMonitorsCache
  if (!options?.fresh && cached && Date.now() - cached.at < MONITORS_CACHE_TTL_MS) {
    return cached.monitors.slice()
  }
  const monitors = await schedulerMonitors(env)
  cacheStore.__uptimeMonitorsCache = { at: Date.now(), monitors }
  return monitors.slice()
}

export function clearMonitorsCache() {
  cacheStore.__uptimeMonitorsCache = undefined
}

// --- validation ---------------------------------------------------------------

export function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/https?:\/\//, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

function readString(data: Record<string, unknown>, key: string) {
  return String(data[key] ?? '').trim()
}

function validateTarget(target: string): URL {
  if (!target) throw new Error('请输入网站地址')
  let url: URL
  try {
    url = new URL(target)
  } catch {
    throw new Error('网站地址格式无效')
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('网站地址需要使用 http 或 https')
  }
  return url
}

function validateTimeout(timeout: number) {
  if (!Number.isFinite(timeout) || timeout < 1000 || timeout > 60000) {
    throw new Error('超时时间需要在 1 到 60 秒之间')
  }
  return timeout
}

// Check interval must be a whole multiple of the 10-minute scheduler tick.
function validateInterval(minutes: number) {
  if (!Number.isFinite(minutes) || minutes < 10 || minutes > 1440 || minutes % 10 !== 0) {
    throw new Error('检查间隔需要是 10 的倍数（10-1440 分钟）')
  }
  return minutes
}

function validatePreview(preview: string) {
  if (!preview) return undefined
  try {
    const previewUrl = new URL(preview)
    if (!['http:', 'https:'].includes(previewUrl.protocol)) throw new Error('invalid preview')
  } catch {
    throw new Error('封面图地址格式无效')
  }
  return preview
}

function validateStatusPageLink(statusPageLink: string) {
  if (!statusPageLink) return undefined
  try {
    const linkUrl = new URL(statusPageLink)
    if (!['http:', 'https:'].includes(linkUrl.protocol)) throw new Error('invalid link')
  } catch {
    throw new Error('访问链接格式无效')
  }
  return statusPageLink
}

function validateName(name: string) {
  if (!name) throw new Error('请输入网站名称')
  if (name.length > 80) throw new Error('网站名称最多 80 个字符')
  return name
}

// Validate and build a brand-new page-managed monitor.
export function parseNewMonitor(input: unknown): MonitorTarget {
  const data = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const name = validateName(readString(data, 'name'))
  const group = readString(data, 'group') || '核心服务'
  const preview = readString(data, 'preview')
  const statusPageLink = readString(data, 'statusPageLink')
  const timeout = validateTimeout(Number(data.timeout ?? 4500))
  const intervalMinutes = validateInterval(Number(data.intervalMinutes ?? 10))

  const url = validateTarget(readString(data, 'target'))
  const validatedPreview = validatePreview(preview)
  const validatedLink = validateStatusPageLink(statusPageLink)

  const id = slugify(readString(data, 'id') || `${url.hostname}-${name}`)
  if (!id) throw new Error('无法生成监测 ID')

  return {
    id,
    name,
    target: url.toString(),
    statusPageLink: validatedLink ?? url.toString(),
    preview: validatedPreview,
    group,
    timeout,
    intervalMinutes,
  }
}

// Merge validated edits into an existing monitor. The id is immutable — it is
// the history key for incidents and latency.
export function mergeMonitorUpdate(existing: MonitorTarget, input: unknown): MonitorTarget {
  const data = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const next: MonitorTarget = { ...existing }

  if (data.name !== undefined) {
    next.name = validateName(readString(data, 'name'))
  }

  if (data.target !== undefined && readString(data, 'target') !== '') {
    next.target = validateTarget(readString(data, 'target')).toString()
  }

  if (data.group !== undefined) {
    next.group = readString(data, 'group') || '核心服务'
  }

  if (data.preview !== undefined) {
    next.preview = validatePreview(readString(data, 'preview'))
  }

  if (data.statusPageLink !== undefined) {
    const link = readString(data, 'statusPageLink')
    next.statusPageLink = link ? validateStatusPageLink(link) : next.target
  }

  if (data.timeout !== undefined) {
    next.timeout = validateTimeout(Number(data.timeout))
  }

  if (data.intervalMinutes !== undefined) {
    next.intervalMinutes = validateInterval(Number(data.intervalMinutes))
  }

  return next
}
