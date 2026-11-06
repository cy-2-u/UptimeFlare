import type { IncidentRecord, LatencyRecord } from './types'

// ---------------------------------------------------------------------------
// D1 row layout (table `uptimeflare`, columns key/value):
//   state:meta          -> MetaRow
//   state:inc:<id>      -> IncidentRow   (columnar incidents, written on change)
//   state:lat:<id>      -> LatencyRow    (per-monitor latency + last status)
//   admin_credentials   -> auth credentials JSON (see auth.ts)
// ---------------------------------------------------------------------------

export const META_KEY = 'state:meta'
export const incidentKey = (monitorId: string) => `state:inc:${monitorId}`
export const latencyKey = (monitorId: string) => `state:lat:${monitorId}`

export type MetaRow = {
  lastUpdate: number
  overallUp: number
  overallDown: number
}

export type IncidentRow = {
  start: number[][]
  end: (number | null)[]
  error: string[][]
}

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

export const INCIDENT_RETENTION_SEC = 90 * 24 * 60 * 60
export const LATENCY_RETENTION_SEC = 12 * 60 * 60

const HEX = '0123456789abcdef'

export function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 15]
  }
  return out
}

export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

export function emptyMeta(): MetaRow {
  return { lastUpdate: 0, overallUp: 0, overallDown: 0 }
}

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

// --- latency row operations -------------------------------------------------

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

// --- incident row operations ------------------------------------------------

export function emptyIncidentRow(): IncidentRow {
  return { start: [], end: [], error: [] }
}

export function incidentRowCount(row: IncidentRow): number {
  return row.start.length
}

export function getIncidentRecord(row: IncidentRow, index: number): IncidentRecord {
  if (index < 0 || index >= row.start.length) {
    throw new Error('Incident index out of bounds')
  }
  return { start: row.start[index], end: row.end[index], error: row.error[index] }
}

export function setIncidentRecord(row: IncidentRow, index: number, record: IncidentRecord): void {
  if (index < 0 || index >= row.start.length) {
    throw new Error('Incident index out of bounds')
  }
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
