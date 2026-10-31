import type { MonitorTarget, Notification } from '../../types/config'
import {
  INCIDENT_RETENTION_SEC,
  LATENCY_RETENTION_SEC,
  appendIncidentRecord,
  appendLatencyPoint,
  emptyIncidentRow,
  emptyLatencyRow,
  getIncidentRecord,
  incidentRowCount,
  lastIncidentRecord,
  pruneIncidents,
  setIncidentRecord,
  trimLatency,
  type IncidentRow,
  type LatencyRow,
  type MetaRow,
} from '../../lib/state-format'

export type CheckOutcome = {
  monitor: MonitorTarget
  checkLocation: string
  checkedAt: number
  status: { ping: number; up: boolean; err: string }
}

export type PendingNotice = {
  monitor: MonitorTarget
  isUp: boolean
  timeIncidentStart: number
  timeNow: number
  reason: string
}

export type RoundResult = {
  meta: MetaRow
  // Rows that must be persisted this round. Latency rows change every round
  // (a new point is appended); incident rows only when incidents mutated.
  latChanged: Map<string, LatencyRow>
  incChanged: Map<string, IncidentRow>
  notices: PendingNotice[]
}

type RoundParams = {
  outcomes: CheckOutcome[]
  latRows: Map<string, LatencyRow>
  incRows: Map<string, IncidentRow>
  notification?: Notification
  now: number
}

// Pure transition logic for one check round. The caller owns persistence and
// only sends the returned notices AFTER the state commit succeeded, so a
// failed commit can never produce a notification the status page disagrees
// with (and the next round re-detects the incident instead).
export function applyRound({
  outcomes,
  latRows,
  incRows,
  notification,
  now,
}: RoundParams): RoundResult {
  const latChanged = new Map<string, LatencyRow>()
  const incChanged = new Map<string, IncidentRow>()
  const notices: PendingNotice[] = []
  const processed = new Set<string>()

  let overallUp = 0
  let overallDown = 0

  for (const outcome of outcomes) {
    const monitor = outcome.monitor
    const id = monitor.id
    if (processed.has(id)) continue
    processed.add(id)

    const checkedAt = outcome.checkedAt
    const status = outcome.status

    let lat = latRows.get(id) ?? emptyLatencyRow(checkedAt)
    if (!lat.startedAt) lat.startedAt = checkedAt

    appendLatencyPoint(lat, {
      time: checkedAt,
      ping: status.ping,
      loc: outcome.checkLocation || 'ERROR',
    })
    trimLatency(lat, checkedAt - LATENCY_RETENTION_SEC)

    const prevStatus = lat.lastStatus
    let inc: IncidentRow | null = null
    let incTouched = false
    const needInc = () => {
      if (!inc) {
        inc = incRows.get(id) ?? emptyIncidentRow()
        incTouched = true
      }
      return inc
    }

    if (status.up) {
      overallUp += 1

      if (prevStatus === 'down') {
        const row = needInc()
        if (incidentRowCount(row) > 0) {
          const last = lastIncidentRecord(row)
          if (last.end === null) {
            last.end = checkedAt
            setIncidentRecord(row, incidentRowCount(row) - 1, last)
            notices.push({
              monitor,
              isUp: true,
              timeIncidentStart: last.start[0],
              timeNow: checkedAt,
              reason: 'OK',
            })
          }
        }
      }

      lat.lastStatus = 'up'
      lat.lastErr = ''
      lat.downNotifiedAt = null
    } else {
      overallDown += 1

      if (prevStatus === 'down') {
        // Still down. Record error-reason changes as a new incident segment.
        if (status.err !== lat.lastErr) {
          const row = needInc()
          if (incidentRowCount(row) > 0) {
            const last = lastIncidentRecord(row)
            if (last.end === null) {
              last.start.push(checkedAt)
              last.error.push(status.err)
              setIncidentRecord(row, incidentRowCount(row) - 1, last)
            } else {
              // Repair an incident row that lost its open tail.
              appendIncidentRecord(row, { start: [checkedAt], end: null, error: [status.err] })
            }
          } else {
            appendIncidentRecord(row, { start: [checkedAt], end: null, error: [status.err] })
          }
          lat.lastErr = status.err

          if (!notification?.skipErrorChangeNotification && lat.downNotifiedAt !== null) {
            const current = needInc()
            const last = lastIncidentRecord(current)
            notices.push({
              monitor,
              isUp: false,
              timeIncidentStart: last.start[0],
              timeNow: checkedAt,
              reason: status.err,
            })
          }
        }

        // First DOWN notification respecting the grace period. Unlike the old
        // ±30s delivery window, a persistent flag makes this fire on the first
        // round after the grace period elapsed even if a round was skipped.
        const grace = notification?.gracePeriod
        if (grace !== undefined && lat.downNotifiedAt === null) {
          const row = needInc()
          const start =
            incidentRowCount(row) > 0 ? lastIncidentRecord(row).start[0] : checkedAt
          if (checkedAt - start >= grace * 60) {
            lat.downNotifiedAt = checkedAt
            notices.push({
              monitor,
              isUp: false,
              timeIncidentStart: start,
              timeNow: checkedAt,
              reason: lat.lastErr || status.err,
            })
          }
        }
      } else {
        // Fresh incident (previous check was up or had no data yet).
        const row = needInc()
        appendIncidentRecord(row, { start: [checkedAt], end: null, error: [status.err] })
        lat.lastStatus = 'down'
        lat.lastErr = status.err

        const grace = notification?.gracePeriod
        if (grace === undefined) {
          lat.downNotifiedAt = checkedAt
          notices.push({
            monitor,
            isUp: false,
            timeIncidentStart: checkedAt,
            timeNow: checkedAt,
            reason: status.err,
          })
        } else {
          lat.downNotifiedAt = null
        }
      }
    }

    if (incTouched && inc) {
      pruneIncidents(inc, checkedAt - INCIDENT_RETENTION_SEC)
      incChanged.set(id, inc)
    }
    latChanged.set(id, lat)
  }

  return {
    meta: { lastUpdate: now, overallUp, overallDown },
    latChanged,
    incChanged,
    notices,
  }
}
