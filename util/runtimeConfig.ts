import type { MonitorTarget, RuntimeBindings, WorkerConfig } from '../types/config'
import { workerConfig } from '../uptime.config'
import { schedulerMonitors } from './schedulerClient'

export type RuntimeEnv = RuntimeBindings & Record<string, unknown>

// Legacy one-time monitor list (pre-DO era). Read only as a migration source;
// the scheduler deletes this row once its own storage list is authoritative.
export const STORED_MONITORS_KEY = 'runtime_monitors'
const STORE_TABLE = 'uptimeflare'
const MONITORS_CACHE_TTL_MS = 60_000

// The monitor list changes rarely but is read on every page render and API
// call. A short isolate-local cache keeps the DO fetch at most once a minute
// per isolate without weakening correctness (writes bypass and clear it).
type MonitorsCache = { at: number; monitors: MonitorTarget[] }
const cacheStore = globalThis as unknown as { __uptimeMonitorsCache?: MonitorsCache }

export async function getRuntimeValue(env: RuntimeEnv | undefined, key: string): Promise<string | null> {
  const db = env?.UPTIMEFLARE_D1 as D1Database | undefined
  if (!db) throw new Error('UPTIMEFLARE_D1 binding is missing')

  const result = await db
    .prepare(`SELECT value FROM ${STORE_TABLE} WHERE key = ?`)
    .bind(key)
    .first<{ value: string }>()
  return result?.value ?? null
}

export async function setRuntimeValue(env: RuntimeEnv, key: string, value: string): Promise<void> {
  const db = env.UPTIMEFLARE_D1 as D1Database | undefined
  if (!db) throw new Error('UPTIMEFLARE_D1 binding is missing')

  await db.exec(
    `CREATE TABLE IF NOT EXISTS ${STORE_TABLE} (key VARCHAR(255) PRIMARY KEY, value BLOB NOT NULL);`
  )

  await db
    .prepare(
      `INSERT INTO ${STORE_TABLE} (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;`
    )
    .bind(key, value)
    .run()
}

export function clearMonitorsCache() {
  cacheStore.__uptimeMonitorsCache = undefined
}

export async function getStoredMonitors(
  env?: RuntimeEnv,
  options?: { fresh?: boolean }
): Promise<MonitorTarget[]> {
  if (env?.MONITOR_SCHEDULER_DO) {
    const cached = cacheStore.__uptimeMonitorsCache
    if (!options?.fresh && cached && Date.now() - cached.at < MONITORS_CACHE_TTL_MS) {
      return cached.monitors.slice()
    }
    const monitors = await schedulerMonitors(env)
    cacheStore.__uptimeMonitorsCache = { at: Date.now(), monitors }
    return monitors.slice()
  }

  // Fallback used by local dev (no DO binding) and by the scheduler itself
  // during one-time migration: read the legacy D1 monitor list.
  const value = await getRuntimeValue(env, STORED_MONITORS_KEY)
  if (value === null) return []
  const monitors = JSON.parse(value) as MonitorTarget[]
  if (!Array.isArray(monitors)) throw new Error('Invalid stored monitors')
  return monitors
}

export async function getEffectiveWorkerConfig(
  env?: RuntimeEnv,
  monitors?: MonitorTarget[]
): Promise<WorkerConfig> {
  const storedMonitors = monitors ?? (await getStoredMonitors(env))

  return {
    ...workerConfig,
    monitors: workerConfig.monitors.concat(storedMonitors),
  }
}
