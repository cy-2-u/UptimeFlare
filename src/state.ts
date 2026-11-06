// ---------------------------------------------------------------------------
// D1 state layer: row layout, codec, and row-level access in one module.
// Table `uptimeflare` (columns key/value):
//   state:meta      -> MetaRow
//   state:inc:<id>  -> IncidentRow  (columnar incidents, written on change)
//   state:lat:<id>  -> LatencyRow   (per-monitor latency + last status)
//   admin_credentials -> auth credentials JSON
// ---------------------------------------------------------------------------

import type { IncidentRecord, LatencyRecord, RuntimeEnv } from './types'

export type MetaRow = { lastUpdate: number; overallUp: number; overallDown: number }
export type IncidentRow = { start: number[][]; end: (number | null)[]; error: string[][] }
export type LatencyRow = {
  startedAt: number
  lastStatus: 'up' | 'down' | null
  lastErr: string
  // When the first DOWN notification was sent; implements gracePeriod via a
  // persistent flag instead of a ±30s delivery window that could be missed.
  downNotifiedAt: number | null
  time: string // hex encoded little-endian Uint32Array
  ping: string // hex encoded little-endian Uint16Array
  loc: { v: string[]; c: number[] } // run-length encoded locations
}

export const META_KEY = 'state:meta'
export const incidentKey = (monitorId: string) => `state:inc:${monitorId}`
export const latencyKey = (monitorId: string) => `state:lat:${monitorId}`

export const INCIDENT_RETENTION_SEC = 90 * 24 * 60 * 60
export const LATENCY_RETENTION_SEC = 12 * 60 * 60

// --- hex codec -----------------------------------------------------------------

const HEX = '0123456789abcdef'

export function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 15]
  return out
}

export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16)
  return bytes
}

// --- latency row ----------------------------------------------------------------

export function emptyLatencyRow(now: number): LatencyRow {
  return {
    startedAt: now,
    lastStatus: null,
    lastErr: '',
    downNotifiedAt: null,
    time: '',
    ping: '',
    loc: { v: [], c: [] },
  }
}

export function appendLatencyPoint(
  row: LatencyRow,
  point: { time: number; ping: number; loc: string }
): void {
  row.time += bytesToHex(new Uint8Array(new Uint32Array([point.time >>> 0]).buffer))
  row.ping += bytesToHex(new Uint8Array(new Uint16Array([point.ping & 0xffff]).buffer))

  if (row.loc.v[row.loc.v.length - 1] !== point.loc) {
    row.loc.v.push(point.loc)
    row.loc.c.push(1)
  } else {
    row.loc.c[row.loc.c.length - 1] += 1
  }
}

export function lastLatencyPoint(row: LatencyRow): LatencyRecord | null {
  if (!row.time || !row.ping || row.loc.v.length === 0) return null
  return {
    time: new Uint32Array(hexToBytes(row.time.slice(-8)).buffer)[0],
    ping: new Uint16Array(hexToBytes(row.ping.slice(-4)).buffer)[0],
    loc: row.loc.v[row.loc.v.length - 1],
  }
}

export function trimLatency(row: LatencyRow, before: number): void {
  while (row.time.length >= 8) {
    const head = new Uint32Array(hexToBytes(row.time.slice(0, 8)).buffer)[0]
    if (head >= before) break
    row.time = row.time.slice(8)
    row.ping = row.ping.slice(4)
    row.loc.c[0] -= 1
    if (row.loc.c[0] === 0) {
      row.loc.c.shift()
      row.loc.v.shift()
    }
  }
}

export function decodeLatency(row: {
  time: string
  ping: string
  loc: { v: string[]; c: number[] }
}): LatencyRecord[] {
  const times = new Uint32Array(hexToBytes(row.time).buffer)
  const pings = new Uint16Array(hexToBytes(row.ping).buffer)
  const locs: string[] = []
  row.loc.c.forEach((count, index) => {
    for (let i = 0; i < count; i++) locs.push(row.loc.v[index])
  })

  if (times.length !== pings.length || times.length !== locs.length) {
    throw new Error('Inconsistent latency data lengths.')
  }

  const records: LatencyRecord[] = []
  for (let i = 0; i < times.length; i++) {
    records.push({ time: times[i], ping: pings[i], loc: locs[i] })
  }
  return records
}

// --- incident row ----------------------------------------------------------------

export function emptyIncidentRow(): IncidentRow {
  return { start: [], end: [], error: [] }
}

export function incidentRowCount(row: IncidentRow): number {
  return row.start.length
}

export function getIncidentRecord(row: IncidentRow, index: number): IncidentRecord {
  if (index < 0 || index >= row.start.length) throw new Error('Incident index out of bounds')
  return { start: row.start[index], end: row.end[index], error: row.error[index] }
}

export function setIncidentRecord(row: IncidentRow, index: number, record: IncidentRecord): void {
  if (index < 0 || index >= row.start.length) throw new Error('Incident index out of bounds')
  row.start[index] = record.start
  row.end[index] = record.end
  row.error[index] = record.error
}

export function appendIncidentRecord(row: IncidentRow, record: IncidentRecord): void {
  row.start.push(record.start)
  row.end.push(record.end)
  row.error.push(record.error)
}

export function lastIncidentRecord(row: IncidentRow): IncidentRecord {
  return getIncidentRecord(row, row.start.length - 1)
}

// Drop closed incidents that ended before `before`. Returns true if changed.
export function pruneIncidents(row: IncidentRow, before: number): boolean {
  let changed = false
  while (row.start.length > 0 && row.end[0] !== null && (row.end[0] as number) < before) {
    row.start.shift()
    row.end.shift()
    row.error.shift()
    changed = true
  }
  return changed
}

// Columnar -> record conversion for page payloads (done once, server-side).
export function incidentsToRecords(row: IncidentRow): IncidentRecord[] {
  return row.start.map((starts, i) => ({ start: starts, end: row.end[i], error: row.error[i] }))
}

// --- D1 row access -----------------------------------------------------------------

const TABLE = 'uptimeflare'
const BIND_CHUNK = 50

export type RowSnapshot = { key: string; value: string | null }
export type RowChange = { key: string; expected: string | null; next: string }

function requireD1(env: { UPTIMEFLARE_D1?: D1Database }): D1Database {
  const db = env.UPTIMEFLARE_D1
  if (!db) throw new Error('UPTIMEFLARE_D1 binding is missing')
  return db
}

export async function readValue(env: { UPTIMEFLARE_D1?: D1Database }, key: string): Promise<string | null> {
  const result = await requireD1(env)
    .prepare(`SELECT value FROM ${TABLE} WHERE key = ?`)
    .bind(key)
    .first<{ value: string }>()
  return result?.value ?? null
}

export async function setRuntimeValue(
  env: { UPTIMEFLARE_D1?: D1Database },
  key: string,
  value: string
): Promise<void> {
  const db = requireD1(env)
  await db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (key VARCHAR(255) PRIMARY KEY, value BLOB NOT NULL);`)
  await db
    .prepare(
      `INSERT INTO ${TABLE} (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;`
    )
    .bind(key, value)
    .run()
}

export async function readStateSnapshot(env: { UPTIMEFLARE_D1?: D1Database }): Promise<{
  meta: RowSnapshot
  lat: Map<string, RowSnapshot>
  inc: Map<string, RowSnapshot>
}> {
  const { results } = await requireD1(env)
    .prepare(
      `SELECT key, value FROM ${TABLE} WHERE key = ? OR key LIKE 'state:lat:%' OR key LIKE 'state:inc:%'`
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
  env: { UPTIMEFLARE_D1?: D1Database }
): Promise<{ meta: RowSnapshot; lat: Map<string, RowSnapshot> }> {
  const { results } = await requireD1(env)
    .prepare(`SELECT key, value FROM ${TABLE} WHERE key = ? OR key LIKE 'state:lat:%'`)
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
export async function commitChanges(
  env: { UPTIMEFLARE_D1?: D1Database },
  changes: RowChange[]
): Promise<void> {
  if (changes.length === 0) return
  const db = requireD1(env)

  const statements = changes.map((change) =>
    change.expected === null
      ? db
          .prepare(`INSERT INTO ${TABLE} (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING`)
          .bind(change.key, change.next)
      : db
          .prepare(`UPDATE ${TABLE} SET value = ? WHERE key = ? AND value = ?`)
          .bind(change.next, change.key, change.expected)
  )

  await db.batch(statements)

  for (const chunk of chunked(changes, BIND_CHUNK)) {
    const placeholders = chunk.map(() => '?').join(', ')
    const { results } = await db
      .prepare(`SELECT key, value FROM ${TABLE} WHERE key IN (${placeholders})`)
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

export async function deleteRows(
  env: { UPTIMEFLARE_D1?: D1Database },
  keys: string[]
): Promise<void> {
  if (keys.length === 0) return
  const db = requireD1(env)

  for (const chunk of chunked(keys, BIND_CHUNK)) {
    const placeholders = chunk.map(() => '?').join(', ')
    await db.prepare(`DELETE FROM ${TABLE} WHERE key IN (${placeholders})`).bind(...chunk).run()
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

export function emptyMeta(): MetaRow {
  return { lastUpdate: 0, overallUp: 0, overallDown: 0 }
}

function chunked<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let start = 0; start < items.length; start += size) chunks.push(items.slice(start, start + size))
  return chunks
}
