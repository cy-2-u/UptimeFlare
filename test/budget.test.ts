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
