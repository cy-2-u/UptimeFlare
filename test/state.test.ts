import test from 'node:test'
import assert from 'node:assert/strict'
import {
  META_KEY,
  incidentKey,
  latencyKey,
  appendLatencyPoint,
  emptyLatencyRow,
} from '../src/state'
import {
  changeFrom,
  commitChanges,
  deleteRows,
  readLatencySnapshot,
  readStateSnapshot,
  readValue,
  setRuntimeValue,
} from '../src/state'
import { FakeD1 } from './fakes'

function fixture() {
  const db = new FakeD1()
  return { env: { UPTIMEFLARE_D1: db } as unknown as Record<string, unknown>, db }
}

test('readValue requires the D1 binding', async () => {
  await assert.rejects(readValue({}, 'any'), /binding/)
})

test('setRuntimeValue creates the table and upserts', async () => {
  const { env, db } = fixture()
  await setRuntimeValue(env, 'k', 'v1')
  await setRuntimeValue(env, 'k', 'v2')
  assert.equal(await readValue(env, 'k'), 'v2')
  assert.equal(db.rows.get('k'), 'v2')
})

test('commitChanges writes fresh rows atomically and verifies them', async () => {
  const { env, db } = fixture()
  await commitChanges(env, [{ key: META_KEY, expected: null, next: '{"a":1}' }])
  assert.equal(db.rows.get(META_KEY), '{"a":1}')
})

test('compare-and-set rejects stale expectations without touching data', async () => {
  const { env, db } = fixture()
  db.rows.set(META_KEY, 'original')

  await assert.rejects(
    commitChanges(env, [{ key: META_KEY, expected: 'tampered', next: 'next' }]),
    /Concurrent state update/
  )
  assert.equal(db.rows.get(META_KEY), 'original')

  await commitChanges(env, [{ key: META_KEY, expected: 'original', next: 'updated' }])
  assert.equal(db.rows.get(META_KEY), 'updated')
})

test('batch commits are atomic: a failed write leaves every row untouched', async () => {
  const { env, db } = fixture()
  db.rows.set(META_KEY, 'original')
  db.failWrites = true

  await assert.rejects(
    commitChanges(env, [
      { key: META_KEY, expected: 'original', next: 'updated' },
      { key: latencyKey('m'), expected: null, next: '{}' },
    ]),
    /write unavailable/
  )
  assert.equal(db.rows.get(META_KEY), 'original')
  assert.equal(db.rows.has(latencyKey('m')), false)
})

test('readStateSnapshot groups meta, latency and incident rows', async () => {
  const { env, db } = fixture()
  db.rows.set(META_KEY, '{"lastUpdate":1}')
  db.rows.set(latencyKey('a'), '{"lastStatus":"up"}')
  db.rows.set(incidentKey('a'), '{"start":[]}')
  db.rows.set('admin_credentials', 'secret')

  const snapshot = await readStateSnapshot(env)
  assert.equal(snapshot.meta.value, '{"lastUpdate":1}')
  assert.equal(snapshot.lat.get('a')?.value, '{"lastStatus":"up"}')
  assert.equal(snapshot.inc.get('a')?.value, '{"start":[]}')
  assert.equal(snapshot.lat.has('admin_credentials'), false)
})

test('deleteRows removes exactly the requested keys', async () => {
  const { env, db } = fixture()
  db.rows.set(latencyKey('a'), '{}')
  db.rows.set(incidentKey('a'), '{}')
  db.rows.set(latencyKey('b'), '{}')

  await deleteRows(env, [latencyKey('a'), incidentKey('a')])

  assert.equal(db.rows.has(latencyKey('a')), false)
  assert.equal(db.rows.has(latencyKey('b')), true)
})

const T0 = 1_700_000_000
