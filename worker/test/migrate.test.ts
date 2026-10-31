import test from 'node:test'
import assert from 'node:assert/strict'
import {
  META_KEY,
  LEGACY_STATE_KEY,
  bytesToHex,
  incidentKey,
  latencyKey,
} from '../../lib/state-format'
import { migrateIfNeeded } from '../src/migrate'
import { makeFakeD1 } from './fakes'

const T0 = 1_700_000_000

function hexU32(values: number[]) {
  return bytesToHex(new Uint8Array(new Uint32Array(values).buffer))
}

function hexU16(values: number[]) {
  return bytesToHex(new Uint8Array(new Uint16Array(values).buffer))
}

const legacyState = JSON.stringify({
  lastUpdate: T0,
  overallUp: 1,
  overallDown: 1,
  incident: {
    up: { start: [[100]], end: [200], error: [['blip']] },
    down: { start: [[150]], end: [null], error: [['down err']] },
  },
  latency: {
    up: {
      time: hexU32([100, 200]),
      ping: hexU16([10, 20]),
      loc: { v: ['HKG'], c: [2] },
    },
  },
})

function fixture(kv?: { value: string | null }) {
  const db = makeFakeD1()
  const env: Record<string, unknown> = {
    UPTIMEFLARE_D1: db,
    ...(kv ? { UPTIMEFLARE_CONFIG: { get: async () => kv.value } } : {}),
  }
  return { env: env as unknown as Parameters<typeof migrateIfNeeded>[0], db }
}

test('legacy single-row state is split into per-monitor rows', async () => {
  const { env, db } = fixture()
  db.rows.set(LEGACY_STATE_KEY, legacyState)

  assert.equal(await migrateIfNeeded(env), true)

  const meta = JSON.parse(db.rows.get(META_KEY)!)
  assert.equal(meta.lastUpdate, T0)
  assert.equal(meta.overallUp, 1)
  assert.equal(meta.overallDown, 1)

  // Incident rows pass through unchanged.
  assert.equal(
    db.rows.get(incidentKey('up')),
    JSON.stringify({ start: [[100]], end: [200], error: [['blip']] })
  )
  assert.equal(
    db.rows.get(incidentKey('down')),
    JSON.stringify({ start: [[150]], end: [null], error: [['down err']] })
  )
  // The up monitor derives its row from latency + closed incident.
  const upRow = JSON.parse(db.rows.get(latencyKey('up'))!) as Record<string, unknown>
  assert.equal(upRow.startedAt, 100)
  assert.equal(upRow.lastStatus, 'up')
  assert.equal(upRow.lastErr, '')
  assert.equal(upRow.downNotifiedAt, null)
  assert.equal(upRow.time, hexU32([100, 200]))

  // The down monitor keeps its open incident flagged as already notified, so
  // the first post-migration round does not re-page for an old incident.
  const downRow = JSON.parse(db.rows.get(latencyKey('down'))!) as Record<string, unknown>
  assert.equal(downRow.startedAt, 150)
  assert.equal(downRow.lastStatus, 'down')
  assert.equal(downRow.lastErr, 'down err')
  assert.equal(downRow.downNotifiedAt, T0)

  // Legacy row removed in the same atomic batch, migration idempotent.
  assert.equal(db.rows.get(LEGACY_STATE_KEY), undefined)
  assert.equal(await migrateIfNeeded(env), false)
})

test('fresh installs get an empty meta row marking migration as done', async () => {
  const { env, db } = fixture()

  assert.equal(await migrateIfNeeded(env), true)
  assert.deepEqual(JSON.parse(db.rows.get(META_KEY)!), {
    lastUpdate: 0,
    overallUp: 0,
    overallDown: 0,
  })
  assert.equal(await migrateIfNeeded(env), false)
})

test('admin credentials are copied from KV when D1 has none', async () => {
  const credentials = JSON.stringify({ username: 'admin', salt: 's', passwordHash: 'h' })
  const { env, db } = fixture({ value: credentials })

  await migrateIfNeeded(env)
  assert.equal(db.rows.get('admin_credentials'), credentials)
})

test('existing D1 credentials are never overwritten from KV', async () => {
  const { env, db } = fixture({ value: '{"username":"kv","salt":"s","passwordHash":"h"}' })
  db.rows.set('admin_credentials', '{"username":"d1","salt":"s","passwordHash":"h"}')

  await migrateIfNeeded(env)
  assert.equal(db.rows.get('admin_credentials'), '{"username":"d1","salt":"s","passwordHash":"h"}')
})
