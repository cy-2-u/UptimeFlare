/// <reference types="node" />
import test from 'node:test'
import assert from 'node:assert/strict'
import { SchedulerState } from './scheduler'
import { compareAndSetStore, getFromStore } from './store'
import type { MonitorTarget } from '../../types/config'

const monitor: MonitorTarget = {
  id: 'one',
  name: 'One',
  target: 'https://example.com',
  method: 'GET',
}
const initialState = JSON.stringify({
  lastUpdate: 100,
  overallUp: 1,
  overallDown: 0,
  incident: { one: { start: [[100]], end: [100], error: [['dummy']] } },
  latency: {},
})

function fixture() {
  const records = new Map<string, unknown>()
  let raw: string | null = initialState
  let readError = false
  let writeError = false
  let writes = 0
  let alarm: number | null = null
  const db = {
    withSession: () => db,
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => {
          if (readError) throw new Error('read unavailable')
          return raw === null ? null : { value: raw }
        },
        run: async () => {
          if (writeError) throw new Error('write unavailable')
          const matches = sql.startsWith('INSERT') ? raw === null : raw === args[2]
          if (matches) {
            raw = String(sql.startsWith('INSERT') ? args[1] : args[0])
            writes++
          }
          return { meta: { changes: matches ? 1 : 0 } }
        },
      }),
    }),
  }
  const storage = {
    get: async (key: string) => structuredClone(records.get(key)),
    put: async (key: string, value: unknown) => {
      records.set(key, structuredClone(value))
    },
    delete: async (key: string) => records.delete(key),
    getAlarm: async () => alarm,
    setAlarm: async (value: number) => {
      alarm = value
    },
    transaction: async (
      fn: (txn: { put: (key: string, value: unknown) => Promise<void> }) => Promise<void>
    ) => fn(storage),
  }
  const env = {
    UPTIMEFLARE_D1: db as unknown as D1Database,
    UPTIMEFLARE_CONFIG: { get: async () => JSON.stringify([monitor]) } as unknown as KVNamespace,
  }
  return {
    env,
    storage: storage as unknown as DurableObjectStorage,
    records,
    raw: () => raw,
    writes: () => writes,
    alarm: () => alarm,
    setRaw: (value: string | null) => {
      raw = value
    },
    failRead: (value: boolean) => {
      readError = value
    },
    failWrite: (value: boolean) => {
      writeError = value
    },
  }
}

test('read failures and missing bindings throw; only a missing row returns null', async () => {
  const f = fixture()
  f.failRead(true)
  await assert.rejects(getFromStore(f.env, 'state'), /read unavailable/)
  await assert.rejects(getFromStore({}, 'state'), /binding/)
  assert.equal(f.writes(), 0)
  f.failRead(false)
  f.setRaw(null)
  assert.equal(await getFromStore(f.env, 'state'), null)
})

test('atomic compare-and-set rejects stale snapshots and competing first writers', async () => {
  const f = fixture()
  const before = await getFromStore(f.env, 'state')
  await compareAndSetStore(f.env, 'state', before, 'newer')
  await assert.rejects(compareAndSetStore(f.env, 'state', before, 'older'), /Concurrent/)
  assert.equal(f.raw(), 'newer')
  f.setRaw(null)
  await compareAndSetStore(f.env, 'state', null, 'first')
  await assert.rejects(compareAndSetStore(f.env, 'state', null, 'second'), /Concurrent/)
  assert.equal(f.raw(), 'first')
})

test('overlapping manual and alarm requests share one run and rearm', async () => {
  const f = fixture()
  let calls = 0
  const scheduler = new SchedulerState(f.storage, f.env, async () => {
    calls++
  })
  await Promise.all([scheduler.runNow(), scheduler.runNow(), scheduler.runNow()])
  assert.equal(calls, 1)
  assert.ok(f.alarm()! > Date.now())
})

test('deletion waits for an in-flight check and survives restart with stale KV', async () => {
  const f = fixture()
  let release!: () => void
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const scheduler = new SchedulerState(f.storage, f.env, async () => {
    const before = await getFromStore(f.env, 'state')
    started()
    await gate
    await compareAndSetStore(f.env, 'state', before, initialState)
  })
  const run = scheduler.runNow()
  await ready
  const deletion = scheduler.deleteMonitor('one')
  release()
  await Promise.all([run, deletion])
  assert.equal(JSON.parse(f.raw()!).incident.one, undefined)
  assert.equal(JSON.parse(f.raw()!).overallUp, 0)
  const restarted = new SchedulerState(f.storage, f.env, async (monitors) => {
    assert.deepEqual(monitors, [])
  })
  await restarted.runNow()
  assert.deepEqual(await restarted.listMonitors(), [])
})

test('failed reads abort deletion without changing existing state or configuration', async () => {
  const f = fixture()
  const scheduler = new SchedulerState(f.storage, f.env, async () => {})
  await scheduler.listMonitors()
  f.failRead(true)
  await assert.rejects(scheduler.deleteMonitor('one'), /read unavailable/)
  assert.equal(f.writes(), 0)
  assert.deepEqual(await scheduler.listMonitors(), [monitor])
  assert.equal(f.records.has('pendingDeletes'), false)
})

test('interrupted deletion resumes before the next check and allows re-adding the ID', async () => {
  const f = fixture()
  const scheduler = new SchedulerState(f.storage, f.env, async () => {})
  f.failWrite(true)
  await assert.rejects(scheduler.deleteMonitor('one'), /write unavailable/)
  assert.deepEqual(f.records.get('pendingDeletes'), ['one'])
  f.failWrite(false)
  const restarted = new SchedulerState(f.storage, f.env, async () => {
    assert.equal(JSON.parse(f.raw()!).incident.one, undefined)
  })
  await restarted.runNow()
  assert.equal(f.records.has('pendingDeletes'), false)
  assert.deepEqual(await restarted.addMonitor(monitor), [monitor])
})

test('failed checks rearm and do not block subsequent runs or mutations', async () => {
  const f = fixture()
  let fail = true
  const scheduler = new SchedulerState(f.storage, f.env, async () => {
    if (fail) throw new Error('check failed')
  })
  await assert.rejects(scheduler.runNow(), /check failed/)
  assert.ok(f.alarm()! > Date.now())
  fail = false
  await scheduler.runNow()
  await scheduler.deleteMonitor('one')
})
