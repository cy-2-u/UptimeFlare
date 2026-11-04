import {
  META_KEY,
  incidentKey,
  latencyKey,
  type IncidentRow,
  type LatencyRow,
} from './state-format'
import type { RuntimeEnv } from './types'

// Row-level D1 access with atomic compare-and-set commits. The table only
// holds this app's rows, so LIKE scans read no more than the rows we own.

type StoreEnv = { UPTIMEFLARE_D1?: D1Database }

const STORE_TABLE = 'uptimeflare'
const BIND_CHUNK = 50

export type RowSnapshot = {
  key: string
  value: string | null
}

export type RowChange = {
  key: string
  expected: string | null
  next: string
}

function requireD1(env: StoreEnv): D1Database {
  const db = env.UPTIMEFLARE_D1
  if (!db) throw new Error('UPTIMEFLARE_D1 binding is missing')
  return db
}

export async function readValue(env: StoreEnv, key: string): Promise<string | null> {
  const result = await requireD1(env)
    .prepare(`SELECT value FROM ${STORE_TABLE} WHERE key = ?`)
    .bind(key)
    .first<{ value: string }>()
  return result?.value ?? null
}

export async function setRuntimeValue(env: StoreEnv, key: string, value: string): Promise<void> {
  const db = requireD1(env)
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

export async function readStateSnapshot(env: StoreEnv): Promise<{
  meta: RowSnapshot
  lat: Map<string, RowSnapshot>
  inc: Map<string, RowSnapshot>
}> {
  const { results } = await requireD1(env)
    .prepare(
      `SELECT key, value FROM ${STORE_TABLE} WHERE key = ? OR key LIKE 'state:lat:%' OR key LIKE 'state:inc:%'`
    )
    .bind(META_KEY)
    .all<{ key: string; value: string }>()

  const meta: RowSnapshot = { key: META_KEY, value: null }
  const lat = new Map<string, RowSnapshot>()
  const inc = new Map<string, RowSnapshot>()

  for (const row of results ?? []) {
    if (row.key === META_KEY) {
      meta.value = row.value
    } else if (row.key.startsWith('state:lat:')) {
      lat.set(row.key.slice('state:lat:'.length), { key: row.key, value: row.value })
    } else if (row.key.startsWith('state:inc:')) {
      inc.set(row.key.slice('state:inc:'.length), { key: row.key, value: row.value })
    }
  }

  return { meta, lat, inc }
}

export async function readLatencySnapshot(
  env: StoreEnv
): Promise<{ meta: RowSnapshot; lat: Map<string, RowSnapshot> }> {
  const { results } = await requireD1(env)
    .prepare(`SELECT key, value FROM ${STORE_TABLE} WHERE key = ? OR key LIKE 'state:lat:%'`)
    .bind(META_KEY)
    .all<{ key: string; value: string }>()

  const meta: RowSnapshot = { key: META_KEY, value: null }
  const lat = new Map<string, RowSnapshot>()

  for (const row of results ?? []) {
    if (row.key === META_KEY) {
      meta.value = row.value
    } else if (row.key.startsWith('state:lat:')) {
      lat.set(row.key.slice('state:lat:'.length), { key: row.key, value: row.value })
    }
  }

  return { meta, lat }
}

// Build a CAS change against a snapshot read earlier in the same run.
export function changeFrom(snapshot: RowSnapshot, next: string): RowChange {
  return { key: snapshot.key, expected: snapshot.value, next }
}

// Commit all changes in one atomic batch. Every write is a compare-and-set
// against the snapshot, so a concurrent writer makes the whole batch a no-op
// (INSERT ... DO NOTHING / UPDATE ... WHERE value = ?), which the post-verify
// turns into a loud error instead of silent data loss.
export async function commitChanges(env: StoreEnv, changes: RowChange[]): Promise<void> {
  if (changes.length === 0) return
  const db = requireD1(env)

  const statements = changes.map((change) =>
    change.expected === null
      ? db
          .prepare(
            `INSERT INTO ${STORE_TABLE} (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING`
          )
          .bind(change.key, change.next)
      : db
          .prepare(`UPDATE ${STORE_TABLE} SET value = ? WHERE key = ? AND value = ?`)
          .bind(change.next, change.key, change.expected)
  )

  await db.batch(statements)

  for (const chunk of chunked(changes, BIND_CHUNK)) {
    const placeholders = chunk.map(() => '?').join(', ')
    const { results } = await db
      .prepare(`SELECT key, value FROM ${STORE_TABLE} WHERE key IN (${placeholders})`)
      .bind(...chunk.map((change) => change.key))
      .all<{ key: string; value: string }>()

    const stored = new Map((results ?? []).map((row) => [row.key, row.value]))
    for (const change of chunk) {
      if (stored.get(change.key) !== change.next) {
        throw new Error(`Concurrent state update for ${change.key}`)
      }
    }
  }
}

export async function deleteRows(env: StoreEnv, keys: string[]): Promise<void> {
  if (keys.length === 0) return
  const db = requireD1(env)

  for (const chunk of chunked(keys, BIND_CHUNK)) {
    const placeholders = chunk.map(() => '?').join(', ')
    await db.prepare(`DELETE FROM ${STORE_TABLE} WHERE key IN (${placeholders})`).bind(...chunk).run()
  }
}

export function parseLatencyRow(snapshot: RowSnapshot | undefined | null): LatencyRow | null {
  if (!snapshot || snapshot.value === null) return null
  return JSON.parse(snapshot.value) as LatencyRow
}

export function parseIncidentRow(snapshot: RowSnapshot | undefined | null): IncidentRow | null {
  if (!snapshot || snapshot.value === null) return null
  return JSON.parse(snapshot.value) as IncidentRow
}

function chunked<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size))
  }
  return chunks
}
