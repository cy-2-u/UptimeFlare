import { MonitorTarget, RuntimeBindings, WorkerConfig } from '../types/config'
import { workerConfig } from '../uptime.config'
import { schedulerMonitors } from './schedulerClient'

export type RuntimeEnv = RuntimeBindings & Record<string, unknown>
const STORED_MONITORS_KEY = 'runtime_monitors'
const STORE_TABLE = 'uptimeflare'

export async function getRuntimeValue(env: RuntimeEnv | undefined, key: string): Promise<string | null> {
  const kv = env?.UPTIMEFLARE_CONFIG
  if (kv) return await kv.get(key)

  const db = env?.UPTIMEFLARE_D1 as D1Database | undefined
  if (!db) throw new Error('KV or D1 binding is missing')

  const result = await db
    .prepare(`SELECT value FROM ${STORE_TABLE} WHERE key = ?`)
    .bind(key)
    .first<{ value: string }>()
  return result?.value ?? null
}

export async function setRuntimeValue(env: RuntimeEnv, key: string, value: string): Promise<void> {
  const kv = env.UPTIMEFLARE_CONFIG
  if (kv) {
    await kv.put(key, value)
    return
  }

  const db = env.UPTIMEFLARE_D1 as D1Database | undefined
  if (!db) throw new Error('KV or D1 binding is missing')

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

export async function getStoredMonitors(env?: RuntimeEnv): Promise<MonitorTarget[]> {
  if (env?.MONITOR_SCHEDULER_DO) {
    return schedulerMonitors(env)
  }
  const value = await getRuntimeValue(env, STORED_MONITORS_KEY)
  if (value === null) return []
  const monitors = JSON.parse(value) as MonitorTarget[]
  if (!Array.isArray(monitors)) throw new Error('Invalid stored monitors')
  return monitors
}

export async function getEffectiveWorkerConfig(env?: RuntimeEnv, monitors?: MonitorTarget[]): Promise<WorkerConfig> {
  const storedMonitors = monitors ?? await getStoredMonitors(env)

  return {
    ...workerConfig,
    monitors: workerConfig.monitors.concat(storedMonitors),
  }
}
