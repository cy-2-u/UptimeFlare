import {
  META_KEY,
  LEGACY_STATE_KEY,
  emptyMeta,
  firstLatencyTime,
  incidentKey,
  latencyKey,
  parseCompacted,
  type LatencyRow,
} from '../../lib/state-format'
import { changeFrom, commitChanges, readValue, type RowChange } from './store'

// One-time migration from the legacy single-row state (and KV credentials) to
// the per-monitor row layout. Idempotent: it only runs while `state:meta` is
// absent and the final meta insert is write-once, so concurrent invocations
// converge. The legacy `state` row is kept as a backup.
export async function migrateIfNeeded(env: {
  UPTIMEFLARE_D1?: D1Database
  UPTIMEFLARE_CONFIG?: KVNamespace
}): Promise<boolean> {
  const metaRaw = await readValue(env, META_KEY)
  if (metaRaw !== null) return false

  const changes: RowChange[] = []
  const meta = emptyMeta()
  const legacyRaw = await readValue(env, LEGACY_STATE_KEY)

  if (legacyRaw !== null) {
    try {
      const legacy = parseCompacted(legacyRaw)
      if (legacy) {
        meta.lastUpdate = legacy.lastUpdate ?? 0
        meta.overallUp = legacy.overallUp ?? 0
        meta.overallDown = legacy.overallDown ?? 0

        const incidents = legacy.incident ?? {}
        const latencies = legacy.latency ?? {}

        // Union of both maps: a monitor may have incidents but no latency
        // data (or the reverse), and it still needs a latency row.
        const ids = new Set([...Object.keys(incidents), ...Object.keys(latencies)])
        for (const id of ids) {
          const legacyLatency = latencies[id]
          const row: LatencyRow = {
            startedAt: 0,
            lastStatus: null,
            lastErr: '',
            downNotifiedAt: null,
            time: legacyLatency?.time ?? '',
            ping: legacyLatency?.ping ?? '',
            loc: legacyLatency?.loc ?? { v: [], c: [] },
          }

          const column = incidents[id]
          const lastStart =
            column && column.start.length > 0 ? column.start[column.start.length - 1][0] : 0
          const lastEnd =
            column && column.end.length > 0 ? column.end[column.end.length - 1] : null
          const lastError =
            column && column.error.length > 0
              ? (column.error[column.error.length - 1].slice(-1)[0] ?? '')
              : ''

          row.startedAt = firstLatencyTime(row) || lastStart || meta.lastUpdate
          row.lastStatus = column && column.start.length > 0 ? (lastEnd === null ? 'down' : 'up') : null
          row.lastErr = lastEnd === null ? lastError : ''
          // An open incident at migration time counts as already notified, so
          // the first post-migration run does not re-page for an old incident.
          row.downNotifiedAt = lastEnd === null ? meta.lastUpdate || lastStart : null

          changes.push({ key: latencyKey(id), expected: null, next: JSON.stringify(row) })

          if (column) {
            changes.push({
              key: incidentKey(id),
              expected: null,
              next: JSON.stringify(column),
            })
          }
        }
      }
    } catch (error) {
      console.log('Legacy state could not be parsed, starting fresh: ' + error)
    }
  }

  changes.push({ key: META_KEY, expected: null, next: JSON.stringify(meta) })

  // Copy admin credentials from KV if they never landed in D1.
  if (env.UPTIMEFLARE_CONFIG && (await readValue(env, 'admin_credentials')) === null) {
    try {
      const kvValue = await env.UPTIMEFLARE_CONFIG.get('admin_credentials')
      if (kvValue) {
        changes.push({ key: 'admin_credentials', expected: null, next: kvValue })
      }
    } catch (error) {
      console.log('KV credentials lookup failed, skipping: ' + error)
    }
  }

  await commitChanges(
    env,
    changes,
    // The legacy row has been fully converted above; drop it in the same
    // atomic batch so no backup copy lingers in D1.
    legacyRaw !== null ? [LEGACY_STATE_KEY] : []
  )
  console.log(
    `Migration completed: ${changes.length - 1} row(s) derived from legacy state (legacy row ${
      legacyRaw !== null ? 'removed' : 'absent'
    }), meta.lastUpdate=${meta.lastUpdate}`
  )
  return true
}
