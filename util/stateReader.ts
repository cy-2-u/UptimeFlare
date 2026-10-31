import {
  assembleCompactedState,
  emptyMeta,
  lastLatencyPoint,
  type IncidentRow,
  type LatencyRow,
  type MetaRow,
} from '../lib/state-format'
import {
  parseIncidentRow,
  parseLatencyRow,
  readLatencySnapshot,
  readStateSnapshot,
} from '../worker/src/store'

type RuntimeEnvLike = { UPTIMEFLARE_D1?: D1Database }

// Assemble the whole compacted state string from per-monitor rows. Used by the
// SSR page and /api/status; both cache the result at the edge (s-maxage).
export async function readCompactedStateStr(env: RuntimeEnvLike): Promise<string | null> {
  const snapshot = await readStateSnapshot(env)

  let meta: MetaRow = emptyMeta()
  if (snapshot.meta.value !== null) {
    try {
      meta = JSON.parse(snapshot.meta.value) as MetaRow
    } catch {
      meta = emptyMeta()
    }
  }

  const latencies: Record<string, LatencyRow> = {}
  for (const [id, row] of snapshot.lat) {
    const parsed = parseLatencyRow(row)
    if (parsed) latencies[id] = parsed
  }

  const incidents: Record<string, IncidentRow> = {}
  for (const [id, row] of snapshot.inc) {
    const parsed = parseIncidentRow(row)
    if (parsed) incidents[id] = parsed
  }

  return assembleCompactedState(meta, incidents, latencies)
}

export type MonitorSummary = {
  up: boolean | null
  latency: number | null
  location: string | null
  message: string
}

// Lightweight summary for /api/data (no incident rows needed).
export async function readStateSummary(env: RuntimeEnvLike): Promise<{
  meta: MetaRow
  summaries: Record<string, MonitorSummary>
} | null> {
  const snapshot = await readLatencySnapshot(env)
  if (snapshot.meta.value === null) return null

  let meta: MetaRow = emptyMeta()
  try {
    meta = JSON.parse(snapshot.meta.value) as MetaRow
  } catch {
    return null
  }

  const summaries: Record<string, MonitorSummary> = {}
  for (const [id, row] of snapshot.lat) {
    const parsed = parseLatencyRow(row)
    if (!parsed) continue

    const last = lastLatencyPoint(parsed)

    summaries[id] = {
      up: parsed.lastStatus === null ? null : parsed.lastStatus === 'up',
      latency: last?.ping ?? null,
      location: last?.loc ?? null,
      message: parsed.lastStatus === 'down' ? parsed.lastErr || 'DOWN' : 'OK',
    }
  }

  return { meta, summaries }
}
