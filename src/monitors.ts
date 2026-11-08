import type { MonitorTarget, RuntimeBindings } from './types'
import type { MonitorScheduler } from './index'

export class SchedulerError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message)
  }
}

// The scheduler DO is the single source of truth for page-managed monitors.
// The Worker talks to it via Durable Object RPC (typed stub methods):
// no URL routing, no JSON re-encoding, full type safety.
export function schedulerStub(env: RuntimeBindings) {
  const namespace = env.MONITOR_SCHEDULER_DO
  if (!namespace) throw new Error('MONITOR_SCHEDULER_DO binding is missing')
  return namespace.get(namespace.idFromName('default'))
}

export async function schedulerMonitors(
  env: RuntimeBindings,
  action: 'list' | 'add' | 'update' | 'delete',
  monitor?: MonitorTarget | { id: string }
): Promise<MonitorTarget[]> {
  const stub = schedulerStub(env)

  try {
    switch (action) {
      case 'list':
        return await stub.listMonitors()
      case 'add':
        return await stub.addMonitor(monitor as MonitorTarget)
      case 'update':
        return await stub.updateMonitor(monitor as MonitorTarget)
      case 'delete':
        return await stub.deleteMonitor((monitor as { id: string }).id)
    }
  } catch (error) {
    throw new SchedulerError(
      error instanceof Error ? error.message : 'Scheduler request failed',
      502
    )
  }
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
  const monitors = await schedulerMonitors(env, 'list')
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

const readString = (data: Record<string, unknown>, key: string) => String(data[key] ?? '').trim()

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

function validateUrl(value: string, message: string): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error(message)
  } catch {
    throw new Error(message)
  }
  return value
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
  const timeout = validateTimeout(Number(data.timeout ?? 4500))
  const intervalMinutes = validateInterval(Number(data.intervalMinutes ?? 10))

  const url = validateTarget(readString(data, 'target'))
  const id = slugify(readString(data, 'id') || `${url.hostname}-${name}`)
  if (!id) throw new Error('无法生成监测 ID')

  return {
    id,
    name,
    target: url.toString(),
    statusPageLink: validateUrl(readString(data, 'statusPageLink'), '访问链接格式无效') ?? url.toString(),
    preview: validateUrl(readString(data, 'preview'), '封面图地址格式无效'),
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

  if (data.name !== undefined) next.name = validateName(readString(data, 'name'))

  if (data.target !== undefined && readString(data, 'target') !== '') {
    next.target = validateTarget(readString(data, 'target')).toString()
  }

  if (data.group !== undefined) next.group = readString(data, 'group') || '核心服务'

  if (data.preview !== undefined) {
    next.preview = validateUrl(readString(data, 'preview'), '封面图地址格式无效')
  }

  if (data.statusPageLink !== undefined) {
    const link = readString(data, 'statusPageLink')
    next.statusPageLink = link ? validateUrl(link, '访问链接格式无效') : next.target
  }

  if (data.timeout !== undefined) next.timeout = validateTimeout(Number(data.timeout))

  if (data.intervalMinutes !== undefined) {
    next.intervalMinutes = validateInterval(Number(data.intervalMinutes))
  }

  return next
}
