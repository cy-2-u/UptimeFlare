import type { MonitorTarget, RuntimeEnv } from './types'
import { workerConfig } from './config'
import { checkMonitor, type CheckOutcome } from './checks'
import { dispatchNotices } from './notify'
import { applyRound, isMonitorDue } from './stateops'
import {
  changeFrom,
  commitChanges,
  incidentKey,
  latencyKey,
  parseRow,
  readStateSnapshot,
  type IncidentRow,
  type LatencyRow,
} from './state'
import { getStoredMonitors } from './monitors'
import { getWorkerLocation } from './util'

const MONITOR_CHECK_CONCURRENCY = 4

// One check round: read the row snapshot, determine which monitors are due,
// check them (concurrency 4, failures confirmed twice), apply the
// transitions, commit atomically, and only then dispatch notifications.
// Monitors whose per-monitor interval has not elapsed are skipped entirely —
// their rows stay untouched and cost zero writes.
export async function runChecks(env: RuntimeEnv, authoritativeMonitors?: MonitorTarget[]): Promise<void> {
  const monitors = authoritativeMonitors ?? (await getStoredMonitors(env))
  if (monitors.length === 0) {
    console.log('No monitors configured, skipping scheduled check.')
    return
  }

  const workerLocation = (await getWorkerLocation()) || 'ERROR'
  const now = Math.round(Date.now() / 1000)
  console.log(`Running check round on ${workerLocation}...`)

  const snapshot = await readStateSnapshot(env)

  const latRows = new Map<string, LatencyRow>()
  for (const [id, row] of snapshot.lat) {
    const parsed = parseRow<LatencyRow>(row.value)
    if (parsed) latRows.set(id, parsed)
  }
  const incRows = new Map<string, IncidentRow>()
  for (const [id, row] of snapshot.inc) {
    const parsed = parseRow<IncidentRow>(row.value)
    if (parsed) incRows.set(id, parsed)
  }

  // Due filter: interval elapsed since the last stored check (new monitors
  // without data are always due).
  const due = monitors.filter((monitor) =>
    isMonitorDue(latRows.get(monitor.id), monitor.intervalMinutes ?? 10, now)
  )
  console.log(`Due monitors: ${due.length}/${monitors.length}`)

  const outcomes: CheckOutcome[] = []
  for (let start = 0; start < due.length; start += MONITOR_CHECK_CONCURRENCY) {
    const results = await Promise.all(
      due.slice(start, start + MONITOR_CHECK_CONCURRENCY).map((monitor) =>
        checkMonitor(monitor, workerLocation)
      )
    )
    outcomes.push(...results)
  }
  const dueOutcomes = new Map(outcomes.map((outcome) => [outcome.monitor.id, outcome]))

  const { meta, latChanged, incChanged, notices } = applyRound({
    monitors,
    dueOutcomes,
    latRows,
    incRows,
    notification: workerConfig.notification,
    now,
  })

  const changes = [changeFrom(snapshot.meta, JSON.stringify(meta))]
  for (const [id, row] of latChanged) {
    changes.push(
      changeFrom(snapshot.lat.get(id) ?? { key: latencyKey(id), value: null }, JSON.stringify(row))
    )
  }
  for (const [id, row] of incChanged) {
    changes.push(
      changeFrom(snapshot.inc.get(id) ?? { key: incidentKey(id), value: null }, JSON.stringify(row))
    )
  }

  await commitChanges(env, changes)
  console.log(
    `Round committed: ${changes.length} row(s), up=${meta.overallUp}, down=${meta.overallDown}, notices=${notices.length}`
  )

  await dispatchNotices(notices, workerConfig.notification)
}
