import test from 'node:test'
import assert from 'node:assert/strict'
import { applyRound, type CheckOutcome } from '../src/stateops'
import { decodeLatency, type IncidentRow, type LatencyRow } from '../../lib/state-format'
import { makeMonitor } from './fakes'

const T0 = 1_700_000_000

type RoundState = {
  lat: Map<string, LatencyRow>
  inc: Map<string, IncidentRow>
}

function outcome(
  monitor: ReturnType<typeof makeMonitor>,
  at: number,
  status: { up: boolean; err?: string; ping?: number; loc?: string }
): CheckOutcome {
  return {
    monitor,
    checkLocation: status.loc ?? 'TEST',
    checkedAt: at,
    status: { ping: status.ping ?? 42, up: status.up, err: status.err ?? '' },
  }
}

function runRound(
  state: RoundState,
  outcomes: CheckOutcome[],
  notification?: Parameters<typeof applyRound>[0]['notification'],
  now = T0
) {
  const result = applyRound({
    outcomes,
    latRows: state.lat,
    incRows: state.inc,
    notification,
    now,
  })
  for (const [id, row] of result.latChanged) state.lat.set(id, row)
  for (const [id, row] of result.incChanged) state.inc.set(id, row)
  return result
}

function freshState(): RoundState {
  return { lat: new Map(), inc: new Map() }
}

test('first successful check creates a latency row without incidents or notices', () => {
  const monitor = makeMonitor()
  const state = freshState()

  const result = runRound(state, [outcome(monitor, T0, { up: true })])

  const row = state.lat.get(monitor.id)!
  assert.equal(row.lastStatus, 'up')
  assert.equal(row.startedAt, T0)
  assert.equal(row.downNotifiedAt, null)
  const points = decodeLatency(row)
  assert.equal(points.length, 1)
  assert.equal(points[0].ping, 42)
  assert.equal(points[0].loc, 'TEST')
  assert.equal(state.inc.has(monitor.id), false)
  assert.equal(result.notices.length, 0)
  assert.deepEqual(result.meta, { lastUpdate: T0, overallUp: 1, overallDown: 0 })
})

test('first failed check opens an incident and notifies immediately', () => {
  const monitor = makeMonitor()
  const state = freshState()

  const result = runRound(state, [outcome(monitor, T0, { up: false, err: 'boom' })])

  const row = state.lat.get(monitor.id)!
  assert.equal(row.lastStatus, 'down')
  assert.equal(row.lastErr, 'boom')
  assert.equal(row.downNotifiedAt, T0)

  const inc = state.inc.get(monitor.id)!
  assert.equal(inc.start.length, 1)
  assert.deepEqual(inc.start[0], [T0])
  assert.equal(inc.end[0], null)
  assert.deepEqual(inc.error[0], ['boom'])

  assert.equal(result.notices.length, 1)
  assert.equal(result.notices[0].isUp, false)
  assert.equal(result.notices[0].reason, 'boom')
  assert.equal(result.meta.overallDown, 1)
})

test('up to down transition opens a new incident and notifies', () => {
  const monitor = makeMonitor()
  const state = freshState()
  runRound(state, [outcome(monitor, T0, { up: true })])

  const result = runRound(state, [outcome(monitor, T0 + 600, { up: false, err: 'down now' })], undefined, T0 + 600)

  const inc = state.inc.get(monitor.id)!
  assert.equal(inc.start.length, 1)
  assert.equal(inc.end[0], null)
  assert.equal(result.notices.length, 1)
  assert.equal(result.notices[0].timeIncidentStart, T0 + 600)
})

test('down to up closes the incident and notifies recovery', () => {
  const monitor = makeMonitor()
  const state = freshState()
  runRound(state, [outcome(monitor, T0, { up: true })])
  runRound(state, [outcome(monitor, T0 + 600, { up: false, err: 'boom' })], undefined, T0 + 600)

  const result = runRound(state, [outcome(monitor, T0 + 1200, { up: true })], undefined, T0 + 1200)

  const inc = state.inc.get(monitor.id)!
  assert.equal(inc.end[0], T0 + 1200)
  const row = state.lat.get(monitor.id)!
  assert.equal(row.lastStatus, 'up')
  assert.equal(row.lastErr, '')
  assert.equal(row.downNotifiedAt, null)

  assert.equal(result.notices.length, 1)
  assert.equal(result.notices[0].isUp, true)
  assert.equal(result.notices[0].timeIncidentStart, T0 + 600)
  assert.equal(result.notices[0].reason, 'OK')
})

test('continuous down with the same error appends no incident and sends no notice', () => {
  const monitor = makeMonitor()
  const state = freshState()
  runRound(state, [outcome(monitor, T0, { up: false, err: 'boom' })])
  const incBefore = JSON.stringify(state.inc.get(monitor.id))

  const result = runRound(
    state,
    [outcome(monitor, T0 + 600, { up: false, err: 'boom' })],
    undefined,
    T0 + 600
  )

  assert.equal(JSON.stringify(state.inc.get(monitor.id)), incBefore)
  assert.equal(result.incChanged.has(monitor.id), false)
  assert.equal(result.notices.length, 0)
  // Latency still appended every round.
  assert.equal(decodeLatency(state.lat.get(monitor.id)!).length, 2)
})

test('error reason change appends a segment and notifies unless suppressed', () => {
  const monitor = makeMonitor()
  const state = freshState()
  runRound(state, [outcome(monitor, T0, { up: false, err: 'first error' })])

  // Default: error-change follow-ups are enabled once the first notice went out.
  const result = runRound(
    state,
    [outcome(monitor, T0 + 600, { up: false, err: 'second error' })],
    undefined,
    T0 + 600
  )
  const inc = state.inc.get(monitor.id)!
  assert.equal(inc.start[0].length, 2)
  assert.deepEqual(inc.error[0], ['first error', 'second error'])
  assert.equal(result.notices.length, 1)
  assert.equal(result.notices[0].reason, 'second error')

  // skipErrorChangeNotification suppresses the follow-up only.
  const quietState = freshState()
  runRound(quietState, [outcome(monitor, T0, { up: false, err: 'first error' })])
  const quiet = runRound(
    quietState,
    [outcome(monitor, T0 + 600, { up: false, err: 'second error' })],
    { skipErrorChangeNotification: true },
    T0 + 600
  )
  assert.equal(quiet.notices.length, 0)
  assert.equal(quietState.inc.get(monitor.id)!.error[0].length, 2)
})

test('no error-change follow-up before the first DOWN notice was sent', () => {
  const monitor = makeMonitor()
  const state = freshState()

  // gracePeriod configured, first notice still pending.
  runRound(state, [outcome(monitor, T0, { up: false, err: 'first error' })], { gracePeriod: 5 }, T0)
  const result = runRound(
    state,
    [outcome(monitor, T0 + 120, { up: false, err: 'second error' })],
    { gracePeriod: 5 },
    T0 + 120
  )

  assert.equal(state.inc.get(monitor.id)!.error[0].length, 2)
  assert.equal(result.notices.length, 0)
})

test('gracePeriod delays the first DOWN notification and sends it exactly once', () => {
  const monitor = makeMonitor()
  const state = freshState()
  const config = { gracePeriod: 5 } as const

  // Fresh down: no notice yet (grace period pending).
  const first = runRound(state, [outcome(monitor, T0, { up: false, err: 'boom' })], config, T0)
  assert.equal(first.notices.length, 0)
  assert.equal(state.lat.get(monitor.id)!.downNotifiedAt, null)

  // 2 minutes in, still within the 5-minute grace period.
  const second = runRound(
    state,
    [outcome(monitor, T0 + 120, { up: false, err: 'boom' })],
    config,
    T0 + 120
  )
  assert.equal(second.notices.length, 0)

  // 6 minutes in: the first round past the grace period sends exactly once.
  const third = runRound(
    state,
    [outcome(monitor, T0 + 360, { up: false, err: 'boom' })],
    config,
    T0 + 360
  )
  assert.equal(third.notices.length, 1)
  assert.equal(state.lat.get(monitor.id)!.downNotifiedAt, T0 + 360)
  // Waiting rounds only loaded the incident row; the unchanged row is not
  // written back.
  assert.equal(third.incChanged.has(monitor.id), false)

  // Subsequent rounds stay quiet.
  const fourth = runRound(
    state,
    [outcome(monitor, T0 + 420, { up: false, err: 'boom' })],
    config,
    T0 + 420
  )
  assert.equal(fourth.notices.length, 0)
})

test('latency rows keep only the most recent 12 hours of points', () => {
  const monitor = makeMonitor()
  const state = freshState()
  runRound(state, [outcome(monitor, T0, { up: true })])

  const later = T0 + 12 * 60 * 60 + 600
  runRound(state, [outcome(monitor, later, { up: true, ping: 55 })], undefined, later)

  const points = decodeLatency(state.lat.get(monitor.id)!)
  assert.equal(points.length, 1)
  assert.equal(points[0].time, later)
  assert.equal(points[0].ping, 55)
})

test('closed incidents older than 90 days are pruned when the row is touched', () => {
  const monitor = makeMonitor()
  const state = freshState()

  const longAgo = T0 - 91 * 24 * 60 * 60
  state.inc.set(monitor.id, {
    start: [[longAgo]],
    end: [longAgo + 60],
    error: [['old outage']],
  })
  state.lat.set('other', emptyRowForTest(longAgo))

  runRound(state, [outcome(monitor, T0, { up: false, err: 'boom' })], undefined, T0)

  const inc = state.inc.get(monitor.id)!
  assert.equal(inc.start.length, 1)
  assert.deepEqual(inc.error[0], ['boom'])
})

test('duplicate monitor outcomes are processed once', () => {
  const monitor = makeMonitor()
  const state = freshState()

  const result = runRound(
    state,
    [outcome(monitor, T0, { up: true }), outcome(monitor, T0, { up: true })],
    undefined,
    T0
  )

  assert.equal(decodeLatency(state.lat.get(monitor.id)!).length, 1)
  assert.equal(result.meta.overallUp, 1)
})

function emptyRowForTest(now: number): LatencyRow {
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
