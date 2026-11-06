import test from 'node:test'
import assert from 'node:assert/strict'
import { applyRound, isMonitorDue, type CheckOutcome } from '../src/stateops'
import { decodeLatency, type IncidentRow, type LatencyRow } from '../src/state'
import type { MonitorTarget } from '../src/types'

const T0 = 1_700_000_000

type RoundState = { lat: Map<string, LatencyRow>; inc: Map<string, IncidentRow> }

function monitor(partial: Partial<MonitorTarget> = {}): MonitorTarget {
  return {
    id: 'example-com',
    name: 'Example',
    target: 'https://example.com',
    timeout: 4500,
    ...partial,
  }
}

function outcome(
  mon: MonitorTarget,
  at: number,
  status: { up: boolean; err?: string; ping?: number; loc?: string }
): CheckOutcome {
  return {
    monitor: mon,
    checkLocation: status.loc ?? 'TEST',
    checkedAt: at,
    status: { ping: status.ping ?? 42, up: status.up, err: status.err ?? '' },
  }
}

function runRound(
  state: RoundState,
  mon: MonitorTarget[],
  outcomes: CheckOutcome[],
  notification?: Parameters<typeof applyRound>[0]['notification'],
  now = T0
) {
  const dueOutcomes = new Map(outcomes.map((o) => [o.monitor.id, o]))
  const result = applyRound({
    monitors: mon,
    dueOutcomes,
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
  const mon = monitor()
  const state = freshState()
  const result = runRound(state, [mon], [outcome(mon, T0, { up: true })])

  const row = state.lat.get(mon.id)!
  assert.equal(row.lastStatus, 'up')
  assert.equal(row.startedAt, T0)
  assert.equal(decodeLatency(row).length, 1)
  assert.equal(state.inc.has(mon.id), false)
  assert.equal(result.notices.length, 0)
  assert.deepEqual(result.meta, { lastUpdate: T0, overallUp: 1, overallDown: 0 })
})

test('first failed check opens an incident and notifies immediately', () => {
  const mon = monitor()
  const state = freshState()
  const result = runRound(state, [mon], [outcome(mon, T0, { up: false, err: 'boom' })])

  const row = state.lat.get(mon.id)!
  assert.equal(row.lastStatus, 'down')
  assert.equal(row.downNotifiedAt, T0)
  const inc = state.inc.get(mon.id)!
  assert.equal(inc.end[0], null)
  assert.deepEqual(inc.error[0], ['boom'])
  assert.equal(result.notices.length, 1)
})

test('down to up closes the incident and notifies recovery', () => {
  const mon = monitor()
  const state = freshState()
  runRound(state, [mon], [outcome(mon, T0, { up: false, err: 'boom' })])

  const result = runRound(
    state,
    [mon],
    [outcome(mon, T0 + 600, { up: true })],
    undefined,
    T0 + 600
  )

  assert.equal(state.inc.get(mon.id)!.end[0], T0 + 600)
  assert.equal(result.notices.length, 1)
  assert.equal(result.notices[0].isUp, true)
  assert.equal(result.notices[0].reason, 'OK')
})

test('continuous down with the same error appends no incident and sends no notice', () => {
  const mon = monitor()
  const state = freshState()
  runRound(state, [mon], [outcome(mon, T0, { up: false, err: 'boom' })])
  const before = JSON.stringify(state.inc.get(mon.id))

  const result = runRound(
    state,
    [mon],
    [outcome(mon, T0 + 600, { up: false, err: 'boom' })],
    undefined,
    T0 + 600
  )

  assert.equal(JSON.stringify(state.inc.get(mon.id)), before)
  assert.equal(result.incChanged.has(mon.id), false)
  assert.equal(result.notices.length, 0)
})

test('error reason change appends a segment and notifies unless suppressed', () => {
  const mon = monitor()
  const state = freshState()
  runRound(state, [mon], [outcome(mon, T0, { up: false, err: 'first' })])

  const result = runRound(
    state,
    [mon],
    [outcome(mon, T0 + 600, { up: false, err: 'second' })],
    undefined,
    T0 + 600
  )
  assert.deepEqual(state.inc.get(mon.id)!.error[0], ['first', 'second'])
  assert.equal(result.notices.length, 1)
  assert.equal(result.notices[0].reason, 'second')

  const quiet = freshState()
  runRound(quiet, [mon], [outcome(mon, T0, { up: false, err: 'first' })])
  const quietResult = runRound(
    quiet,
    [mon],
    [outcome(mon, T0 + 600, { up: false, err: 'second' })],
    { skipErrorChangeNotification: true },
    T0 + 600
  )
  assert.equal(quietResult.notices.length, 0)
})

test('gracePeriod delays the first DOWN notification exactly once', () => {
  const mon = monitor()
  const state = freshState()
  const config = { gracePeriod: 5 }

  const first = runRound(state, [mon], [outcome(mon, T0, { up: false, err: 'boom' })], config, T0)
  assert.equal(first.notices.length, 0)
  assert.equal(first.incChanged.has(mon.id), true) // fresh incident opened

  const second = runRound(
    state,
    [mon],
    [outcome(mon, T0 + 120, { up: false, err: 'boom' })],
    config,
    T0 + 120
  )
  assert.equal(second.notices.length, 0)
  assert.equal(second.incChanged.has(mon.id), false) // waiting round: loaded but unmutated

  const third = runRound(
    state,
    [mon],
    [outcome(mon, T0 + 360, { up: false, err: 'boom' })],
    config,
    T0 + 360
  )
  assert.equal(third.notices.length, 1)
  assert.equal(state.lat.get(mon.id)!.downNotifiedAt, T0 + 360)

  const fourth = runRound(
    state,
    [mon],
    [outcome(mon, T0 + 420, { up: false, err: 'boom' })],
    config,
    T0 + 420
  )
  assert.equal(fourth.notices.length, 0)
})

test('skipped monitors keep their rows untouched but count toward overall', () => {
  const mon = monitor()
  const state = freshState()
  runRound(state, [mon], [outcome(mon, T0, { up: true })])

  const result = runRound(state, [mon], [], undefined, T0 + 600)

  assert.equal(result.latChanged.size, 0)
  assert.deepEqual(result.meta, { lastUpdate: T0 + 600, overallUp: 1, overallDown: 0 })
})

test('isMonitorDue honours the interval with jitter tolerance', () => {
  const mon = monitor({ intervalMinutes: 20 })
  const state = freshState()
  runRound(state, [mon], [outcome(mon, T0, { up: true })])
  const lat = state.lat.get(mon.id)!

  assert.equal(isMonitorDue(lat, 20, T0 + 600), false) // 10min < 20min
  assert.equal(isMonitorDue(lat, 20, T0 + 1170), true) // 19.5min, within tolerance
  assert.equal(isMonitorDue(lat, 20, T0 + 1200), true) // 20min elapsed
  assert.equal(isMonitorDue(undefined, 10, T0), true) // new monitors are due
})

test('closed incidents older than 90 days are pruned when the row is touched', () => {
  const mon = monitor()
  const state = freshState()
  const longAgo = T0 - 91 * 24 * 60 * 60
  state.inc.set(mon.id, {
    start: [[longAgo]],
    end: [longAgo + 60],
    error: [['old outage']],
  })

  runRound(state, [mon], [outcome(mon, T0, { up: false, err: 'boom' })], undefined, T0)

  const inc = state.inc.get(mon.id)!
  assert.equal(inc.start.length, 1)
  assert.deepEqual(inc.error[0], ['boom'])
})

test('duplicate outcomes for the same monitor are processed once', () => {
  const mon = monitor()
  const state = freshState()
  const result = runRound(
    state,
    [mon],
    [outcome(mon, T0, { up: true }), outcome(mon, T0, { up: true })],
    undefined,
    T0
  )
  assert.equal(decodeLatency(state.lat.get(mon.id)!).length, 1)
  assert.equal(result.meta.overallUp, 1)
})
