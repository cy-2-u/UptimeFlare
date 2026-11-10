import test from 'node:test'
import assert from 'node:assert/strict'
import { SchedulerState } from '../src/scheduler'
import { META_KEY, latencyKey, incidentKey } from '../src/state'
import type { RuntimeEnv } from '../src/types'
import { FakeD1, FakeStorage, makeFakeD1, makeMonitor } from './fakes'

const monitor = makeMonitor()

function fixture(db?: FakeD1) {
  const storage = new FakeStorage()
  const d1 = db ?? makeFakeD1()
  const env = { UPTIMEFLARE_D1: d1 } as unknown as RuntimeEnv
  return { storage, env, db: d1 }
}

test('overlapping manual and alarm requests share one run and rearm', async () => {
  const { storage, env } = fixture()
  let calls = 0
  const scheduler = new SchedulerState(storage, env, async () => {
    calls += 1
  })

  await Promise.all([scheduler.runNow(), scheduler.runNow(), scheduler.runNow()])
  assert.equal(calls, 1)
  assert.ok(storage.currentAlarm! > Date.now())
})

test('failed checks rearm and do not block subsequent runs or mutations', async () => {
  const { storage, env } = fixture()
  let fail = true
  const scheduler = new SchedulerState(storage, env, async () => {
    if (fail) throw new Error('check failed')
  })

  await assert.rejects(scheduler.runNow(), /check failed/)
  assert.ok(storage.currentAlarm! > Date.now())

  fail = false
  await scheduler.runNow()
  await scheduler.addMonitor(monitor)
  await scheduler.deleteMonitor(monitor.id)
})

test('addMonitor rejects duplicate ids and records page-managed monitors', async () => {
  const { storage, env } = fixture()
  const scheduler = new SchedulerState(storage, env, async () => {})

  await scheduler.addMonitor(monitor)
  await assert.rejects(scheduler.addMonitor(monitor), /监测 ID 已存在/)
  assert.deepEqual(await scheduler.listMonitors(), [monitor])
})

test('updateMonitor edits in place, keeps the id and rejects unknown ids', async () => {
  const { storage, env } = fixture()
  const scheduler = new SchedulerState(storage, env, async () => {})
  await scheduler.addMonitor(monitor)

  const renamed = await scheduler.updateMonitor({ ...monitor, name: 'Renamed' })
  assert.equal(renamed.length, 1)
  assert.equal(renamed[0].name, 'Renamed')
  assert.equal(renamed[0].id, monitor.id)

  await assert.rejects(
    scheduler.updateMonitor({ ...monitor, id: 'unknown-id' }),
    /只能编辑在页面中添加的监测项/
  )
})

test('deletion waits for an in-flight run and removes history rows', async () => {
  const { storage, env, db } = fixture()
  db.rows.set(META_KEY, '{"lastUpdate":1,"overallUp":0,"overallDown":0}')
  db.rows.set(latencyKey(monitor.id), '{"lastStatus":"up"}')
  db.rows.set(incidentKey(monitor.id), '{"start":[],"end":[],"error":[]}')

  await new SchedulerState(storage, env, async () => {}).addMonitor(monitor)

  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let calls = 0
  const scheduler = new SchedulerState(storage, env, async () => {
    calls += 1
    await gate
  })

  const run = scheduler.runNow()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const deletion = scheduler.deleteMonitor(monitor.id)
  release()
  await Promise.all([run, deletion])

  assert.equal(calls, 1)
  assert.deepEqual(await scheduler.listMonitors(), [])
  assert.equal(db.rows.has(latencyKey(monitor.id)), false)
  assert.equal(db.rows.has(incidentKey(monitor.id)), false)
})

test('failed D1 reads abort deletion without changing configuration', async () => {
  const { storage, env, db } = fixture()
  const scheduler = new SchedulerState(storage, env, async () => {})
  await scheduler.addMonitor(monitor)

  db.failReads = true
  await assert.rejects(scheduler.deleteMonitor(monitor.id), /read unavailable/)
  db.failReads = false

  assert.deepEqual(await scheduler.listMonitors(), [monitor])
  assert.equal(storage.records.has('pendingDeletes'), false)
})

test('interrupted deletion resumes before the next run', async () => {
  const { storage, env, db } = fixture()
  db.rows.set(META_KEY, '{"lastUpdate":1,"overallUp":0,"overallDown":0}')
  const scheduler = new SchedulerState(storage, env, async () => {})
  await scheduler.addMonitor(monitor)
  db.rows.set(latencyKey(monitor.id), '{}')
  db.rows.set(incidentKey(monitor.id), '{}')

  db.failWrites = true
  await assert.rejects(scheduler.deleteMonitor(monitor.id), /write unavailable/)
  db.failWrites = false
  assert.deepEqual(storage.records.get('pendingDeletes'), [monitor.id])

  const restarted = new SchedulerState(storage, env, async () => {})
  await restarted.runNow()
  assert.equal(storage.records.has('pendingDeletes'), false)
  assert.equal(db.rows.has(latencyKey(monitor.id)), false)
  assert.equal(db.rows.has(incidentKey(monitor.id)), false)
})

test('ensureAlarm arms when missing and keeps a future alarm', async () => {
  const { storage, env } = fixture()
  const scheduler = new SchedulerState(storage, env, async () => {})

  const first = await scheduler.ensureAlarm()
  assert.ok(first.nextAlarm > Date.now())
  const armed = storage.currentAlarm!

  const second = await scheduler.ensureAlarm()
  assert.equal(second.nextAlarm, armed)
})

test('healIfStale re-arms only when the alarm is missing, expired or the data is stale', async () => {
  const { storage, env, db } = fixture()
  const scheduler = new SchedulerState(storage, env, async () => {})

  assert.equal((await scheduler.healIfStale()).healed, true)
  assert.ok(storage.currentAlarm! > Date.now())

  db.rows.set(META_KEY, JSON.stringify({ lastUpdate: Math.floor(Date.now() / 1000) - 60 }))
  const armed = storage.currentAlarm!
  assert.equal((await scheduler.healIfStale()).healed, false)
  assert.equal(storage.currentAlarm, armed)

  await new Promise((resolve) => setTimeout(resolve, 5))
  db.rows.set(META_KEY, JSON.stringify({ lastUpdate: Math.floor(Date.now() / 1000) - 3600 }))
  assert.equal((await scheduler.healIfStale()).healed, true)
  assert.ok(storage.currentAlarm! > armed)

  db.rows.delete(META_KEY)
  const before = storage.currentAlarm!
  assert.equal((await scheduler.healIfStale()).healed, false)
  assert.equal(storage.currentAlarm, before)
})

test('a corrupt meta row must not silence the supervisor', async () => {
  const { storage, env, db } = fixture()
  const scheduler = new SchedulerState(storage, env, async () => {})
  await scheduler.ensureAlarm()

  db.rows.set(META_KEY, 'not-json{')
  assert.equal((await scheduler.healIfStale()).healed, true)
  assert.ok(storage.currentAlarm! > Date.now())
})
