import test from 'node:test'
import assert from 'node:assert/strict'
import { Engine } from '../src/engine'
import { settings } from '../src/config'
import { stateKey, type State } from '../src/types'
import { Kernel, Network } from './kernel'

const monitor = { id: 'site', name: '站点', target: 'https://example.com', group: '核心服务', timeout: 3000, intervalMinutes: 10 }

test('a redirected endpoint spends the budget per hop and retries on HTTP failure', async t => {
  const storage = new Kernel(); t.after(() => storage.close())
  const network = new Network()
  const requests: string[] = []
  network.fetch = async input => {
    requests.push(String(input))
    return String(input).endsWith('/ok') ? new Response('ok') : new Response(null, { status: 302, headers: { location: '/ok' } })
  }
  await storage.put({ monitors: [monitor] })
  const engine = new Engine(storage, network, settings)
  await engine.run()
  assert.deepEqual(requests, ['https://example.com', 'https://example.com/ok'])
  assert.equal((await storage.get<State>(stateKey('site')))!.up, true)
})

test('budget exhaustion defers work instead of manufacturing an outage', async t => {
  const storage = new Kernel(); t.after(() => storage.close())
  const network = new Network()
  await storage.put({ monitors: Array.from({ length: 45 }, (_, i) => ({ ...monitor, id: `m${i}` })) })
  const engine = new Engine(storage, network, settings)
  await engine.run()
  assert.equal(network.checks.length, 40)
  assert.equal((await engine.snapshot()).monitors.filter(m => m.up === null).length, 5)
  assert.equal(network.notices.length, 0)
  assert.equal(storage.alarm, network.now() + 1000)
  await engine.run()
  assert.equal(network.checks.length, 45)
  assert.equal((await engine.snapshot()).up, 45)
})

test('outage storms batch persistent notifications below the per-invocation limit', async t => {
  const storage = new Kernel(); t.after(() => storage.close())
  const network = new Network()
  await storage.put({ monitors: Array.from({ length: 25 }, (_, i) => ({ ...monitor, id: `m${i}` })) })
  const engine = new Engine(storage, network, settings)
  let batches = 0
  do {
    network.statuses = Array(80).fill(503)
    const before = network.requests.length
    await engine.run()
    assert.ok(network.requests.length - before <= 50)
    batches++
  } while ((await engine.snapshot()).down < 25 || (await storage.get<any[]>('notices'))?.length)
  assert.equal(network.notices.length, 25)
  assert.ok(batches >= 3)
})

test('a queued backlog drains without new events: 25 old notices leave in 10/10/5', async t => {
  const storage = new Kernel(); t.after(() => storage.close())
  const network = new Network()
  const engine = new Engine(storage, network, settings)
  // Seed the queue with 25 stale notices; no monitor ever produces a new one.
  // Zero-padded ids keep the per-URL assertion free of prefix collisions.
  const stale = Array.from({ length: 25 }, (_, i) => ({ monitor, up: false, first: false, start: 1, time: i, reason: `stale-${String(i).padStart(2, '0')}` }))
  await storage.put({ notices: stale })
  const remaining: number[] = [25]
  let round = 0
  while ((await storage.get<any[]>('notices'))!.length > 0) {
    network.statuses = [200] // monitors stay healthy: zero new notices
    await engine.run()
    const queue = ((await storage.get<any[]>('notices')) ?? []).length
    remaining.push(queue)
    if (++round > 5) throw new Error('backlog did not drain: ' + JSON.stringify(remaining))
  }
  // Exactly three sending rounds; the persisted queue shrinks 25 → 15 → 5 → 0.
  assert.equal(round, 3)
  assert.deepEqual(remaining, [25, 15, 5, 0])
  // Each of the 25 distinct events went out exactly once (URLs carry the reason).
  assert.equal(network.notices.length, 25)
  for (let i = 0; i < 25; i++) assert.equal(network.notices.filter(url => url.includes(`stale-${String(i).padStart(2, '0')}`)).length, 1)
})

test('a paused (blank-webhook) queue must not re-arm the alarm every second', async t => {
  const storage = new Kernel(); t.after(() => storage.close())
  const network = new Network()
  // Zero monitors: the only work in every round is the queued notice.
  await storage.put({ monitors: [], notices: [{ monitor, up: false, first: true, start: 1, time: 1, reason: 'paused' }] })
  const blank = new Engine(storage, network, { ...settings, webhook: '' })
  // Round 1: nothing sent, queue intact, and the alarm lands on the next 10-min
  // tick — not 1 second away. The buggy condition armed +1000ms here.
  await blank.run()
  assert.equal(((await storage.get<any[]>('notices')) ?? []).length, 1)
  assert.ok(storage.alarm! >= network.now() + 600000, 'blank-webhook backlog must not continue at 1s (alarm: ' + storage.alarm + ')')
  assert.equal(network.notices.length, 0)
  // Once a webhook is configured, the backlog drains immediately.
  const live = new Engine(storage, network, settings)
  await live.run()
  assert.deepEqual(await storage.get<any[]>('notices'), [])
  assert.equal(network.notices.length, 1)
})
