import type { MonitorTarget, Notification } from './types'
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
  lastLatencyPoint,
  pruneIncidents,
  setIncidentRecord,
  trimLatency,
  type IncidentRow,
  type LatencyRow,
  type MetaRow,
} from './state'
import type { CheckOutcome } from './checks'

export type { CheckOutcome }

export type PendingNotice = {
  monitor: MonitorTarget
  isUp: boolean
  timeIncidentStart: number
  timeNow: number
  reason: string
}

export type RoundResult = {
  meta: MetaRow
  // Rows that must be persisted this round. Latency rows change only for
  // monitors that were actually checked; incident rows only when mutated.
  latChanged: Map<string, LatencyRow>
  incChanged: Map<string, IncidentRow>
  notices: PendingNotice[]
}

type RoundParams = {
  monitors: MonitorTarget[]
  // Monitors whose interval elapsed this round (id -> outcome). Skipped
  // monitors contribute nothing to the write set — their rows stay untouched.
  dueOutcomes: Map<string, CheckOutcome>
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
  monitors,
  dueOutcomes,
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

  for (const monitor of monitors) {
    const id = monitor.id
    if (processed.has(id)) continue
    processed.add(id)

    const outcome = dueOutcomes.get(id)

    // Skipped (interval not elapsed): count the stored status, touch nothing.
    if (!outcome) {
      const stored = latRows.get(id)
      if (stored?.lastStatus === 'up') overallUp += 1
      else if (stored?.lastStatus === 'down') overallDown += 1
      continue
    }

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
    let incMutated = false
    // Load (never marks the row dirty by itself); mutations opt in below.
    const needInc = () => {
      if (!inc) inc = incRows.get(id) ?? emptyIncidentRow()
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
            incMutated = true
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
          incMutated = true
          lat.lastErr = status.err

          if (!notification?.skipErrorChangeNotification && lat.downNotifiedAt !== null) {
            const last = lastIncidentRecord(needInc())
            notices.push({
              monitor,
              isUp: false,
              timeIncidentStart: last.start[0],
              timeNow: checkedAt,
              reason: status.err,
            })
          }
        }

        // First DOWN notification respecting the grace period. A persistent
        // flag fires on the first round after the grace period elapsed even
        // if a round was skipped in between.
        const grace = notification?.gracePeriod
        if (grace !== undefined && lat.downNotifiedAt === null) {
          const row = needInc()
          const start = incidentRowCount(row) > 0 ? lastIncidentRecord(row).start[0] : checkedAt
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
        incMutated = true
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

    // Only persist the incident row when it actually changed: a loaded-but-
    // unmutated row (e.g. the grace-period wait) must not cause a no-op write
    // every round. Pruning counts as a change.
    if (inc) {
      const pruned = pruneIncidents(inc, checkedAt - INCIDENT_RETENTION_SEC)
      if (incMutated || pruned) incChanged.set(id, inc)
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

// A monitor is due when its interval elapsed since the last stored check
// (30s tolerance absorbs alarm-timing jitter between rounds).
export function isMonitorDue(
  lat: LatencyRow | undefined,
  intervalMinutes: number,
  now: number
): boolean {
  if (!lat || lat.time === '') return true
  const last = lastLatencyPoint(lat)
  if (!last) return true
  return now - last.time >= intervalMinutes * 60 - 30
}
