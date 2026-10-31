import test from 'node:test'
import assert from 'node:assert/strict'
import {
  META_KEY,
  incidentKey,
  latencyKey,
  type IncidentRow,
  type LatencyRow,
} from '../../lib/state-format'
import {
  changeFrom,
  commitChanges,
  deleteRows,
  readLatencySnapshot,
  readStateSnapshot,
  readValue,
} from '../src/store'
import { makeFakeD1 } from './fakes'

function fixture() {
  const db = makeFakeD1()
  const env = { UPTIMEFLARE_D1: db }
  return { env, db }
}

test('readValue requires the D1 binding', async () => {
  await assert.rejects(readValue({}, 'any'), /binding/)
})

test('commitChanges writes fresh rows and verifies them', async () => {
  const { env, db } = fixture()

  await commitChanges(env, [{ key: META_KEY, expected: null, next: '{"a":1}' }])
  assert.equal(db.rows.get(META_KEY), '{"a":1}')
})

test('commitChanges compare-and-set rejects stale expectations without touching data', async () => {
  const { env, db } = fixture()
  db.rows.set(META_KEY, 'original')

  // CAS against the wrong snapshot is a no-op that the verify step turns into
  // a loud error.
  await assert.rejects(
    commitChanges(env, [{ key: META_KEY, expected: 'tampered', next: 'next' }]),
    /Concurrent state update/
  )
  assert.equal(db.rows.get(META_KEY), 'original')

  // CAS against the right snapshot succeeds.
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
  // Unrelated keys are never returned.
  assert.equal(snapshot.lat.has('admin_credentials'), false)
})

test('readLatencySnapshot loads only meta and latency rows', async () => {
  const { env, db } = fixture()
  db.rows.set(META_KEY, '{"lastUpdate":1}')
  db.rows.set(latencyKey('a'), '{"lastStatus":"up"}')
  db.rows.set(incidentKey('a'), '{"start":[]}')

  const snapshot = await readLatencySnapshot(env)
  assert.equal(snapshot.lat.size, 1)
  assert.equal(snapshot.meta.value, '{"lastUpdate":1}')
})

test('deleteRows removes exactly the requested keys', async () => {
  const { env, db } = fixture()
  db.rows.set(latencyKey('a'), '{}')
  db.rows.set(incidentKey('a'), '{}')
  db.rows.set(latencyKey('b'), '{}')

  await deleteRows(env, [latencyKey('a'), incidentKey('a')])

  assert.equal(db.rows.has(latencyKey('a')), false)
  assert.equal(db.rows.has(incidentKey('a')), false)
  assert.equal(db.rows.has(latencyKey('b')), true)
})

test('changeFrom carries the snapshot key and expected value', () => {
  const change = changeFrom({ key: 'k', value: 'v' }, 'next')
  assert.deepEqual(change, { key: 'k', expected: 'v', next: 'next' })
})

test('typed row helpers round-trip through JSON', async () => {
  const { env, db } = fixture()
  const latency: LatencyRow = {
    startedAt: 1,
    lastStatus: 'down',
    lastErr: 'e',
    downNotifiedAt: 2,
    time: '',
    ping: '',
    loc: { v: ['HKG'], c: [1] },
  }
  const incident: IncidentRow = { start: [[1]], end: [null], error: [['x']] }
  db.rows.set(latencyKey('m'), JSON.stringify(latency))
  db.rows.set(incidentKey('m'), JSON.stringify(incident))

  const snapshot = await readStateSnapshot(env)
  assert.deepEqual(JSON.parse(snapshot.lat.get('m')!.value!), latency)
  assert.deepEqual(JSON.parse(snapshot.inc.get('m')!.value!), incident)
})
