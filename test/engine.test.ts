import test from 'node:test'
import assert from 'node:assert/strict'
import { Engine } from '../src/engine'
import { settings } from '../src/config'
import { freshState, stateKey, type Monitor, type State } from '../src/types'
import { Kernel, Network } from './kernel'
import { authenticated, passwordHash } from '../src/auth'
import { parseMonitor } from '../src/monitor'

const monitor: Monitor = { id: 'example', name: '示例', target: 'https://example.com', group: '核心服务', timeout: 3000, intervalMinutes: 10 }
function fixture(t: test.TestContext, config = structuredClone(settings)) {
  const storage = new Kernel()
  const network = new Network()
  t.after(() => storage.close())
  const engine = new Engine(storage, network, config)
  const state = () => storage.get<State>(stateKey(monitor.id))
  return { storage, network, engine, state }
}
async function login(engine: Engine) {
  const result = await engine.request('POST', '/api/admin', { action: 'setup', username: 'owner', password: 'password123' }, '', true)
  return result.cookie!
}

test('complete user journey: setup, add, check, failure, change, recovery, edit, restart and delete', async t => {
  const { storage, network, engine, state } = fixture(t)
  const cookie = await login(engine)
  await engine.request('POST', '/api/monitors', monitor, cookie, true)
  // A new monitor must not wait for the anchored tick: the alarm is pulled in.
  assert.ok((await storage.getAlarm())! <= network.now() + 2000)
  await engine.run()
  assert.equal((await state())!.up, true)
  assert.equal(network.notices.length, 0)
  network.advance()
  network.statuses = [503, 503]
  await engine.run()
  assert.equal((await state())!.incidents[0].end, null)
  assert.equal(network.notices.length, 1)
  network.advance()
  network.statuses = [502, 502]
  await engine.run()
  // The changed error is recorded in the incident history but does not re-notify.
  assert.deepEqual((await state())!.incidents[0].error, ['HTTP 503', 'HTTP 502'])
  assert.equal(network.notices.length, 1)
  network.advance()
  await engine.run()
  assert.ok((await state())!.incidents[0].end)
  assert.equal(network.notices.length, 2)
  await engine.request('PUT', '/api/monitors', { id: monitor.id, name: '改名', intervalMinutes: 20 }, cookie, true)
  const restarted = new Engine(storage, network, settings)
  assert.equal((await restarted.snapshot(monitor.id)).monitors[0].name, '改名')
  assert.equal((await restarted.snapshot(monitor.id)).monitors[0].incidents.length, 1)
  await storage.put({ notices: [{ monitor, up: false, first: false, start: network.now() / 1000, time: network.now() / 1000, reason: 'queued' }] })
  await restarted.request('DELETE', '/api/monitors', { id: monitor.id }, cookie, true)
  assert.deepEqual(await storage.get('notices'), [])
  assert.equal((await restarted.snapshot()).monitors.length, 0)
  assert.equal(await state(), undefined)
})

test('one transient failure is confirmed, then recovery produces no outage', async t => {
  const { storage, network, engine, state } = fixture(t)
  await storage.put({ monitors: [monitor] })
  network.statuses = [503, 200]
  await engine.run()
  assert.equal(network.checks.length, 2)
  assert.equal((await state())!.up, true)
  assert.equal((await state())!.incidents.length, 0)
})

test('editing a target forces an immediate recheck despite the interval gate', async t => {
  const { storage, network, engine, state } = fixture(t)
  const cookie = await login(engine)
  await engine.request('POST', '/api/monitors', monitor, cookie, true)
  await engine.run()
  network.advance(60) // one minute since the check — far below the 570s gate
  await engine.request('PUT', '/api/monitors', { id: monitor.id, target: 'https://moved.example.com' }, cookie, true)
  await engine.run()
  assert.equal(network.checks.filter(url => url.includes('moved.example.com')).length, 1)
  assert.equal((await state())!.up, true)
})

test('failed atomic commit stores nothing and sends nothing; next run recovers', async t => {
  const { storage, network, engine, state } = fixture(t)
  await storage.put({ monitors: [monitor] })
  network.statuses = [503, 503]
  storage.failWrite = true
  await assert.rejects(engine.run(), /write failure/)
  assert.equal(await state(), undefined)
  assert.equal(await storage.get('lastUpdate'), undefined)
  assert.equal(network.notices.length, 0)
  assert.ok(storage.alarm! > network.now())
  storage.failWrite = false
  network.statuses = [503, 503]
  await engine.run()
  assert.equal((await state())!.up, false)
  assert.equal(network.notices.length, 1)
})

test('overlapping alarms deduplicate; reads stay responsive and deletion waits', async t => {
  const { storage, network, engine, state } = fixture(t)
  const cookie = await login(engine)
  await engine.request('POST', '/api/monitors', monitor, cookie, true)
  let release!: () => void
  network.gate = new Promise(resolve => { release = resolve })
  const first = engine.run()
  const second = engine.run()
  assert.equal(first, second)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await engine.snapshot()).monitors.length, 1)
  const deletion = engine.request('DELETE', '/api/monitors', { id: monitor.id }, cookie, true)
  release()
  await Promise.all([first, second, deletion])
  assert.equal(network.checks.length, 1)
  assert.equal(await state(), undefined)
})

test('a failed deletion transaction preserves both configuration and history', async t => {
  const { storage, engine, state } = fixture(t)
  const cookie = await login(engine)
  await engine.request('POST', '/api/monitors', monitor, cookie, true)
  await engine.run()
  storage.failWrite = true
  await assert.rejects(engine.request('DELETE', '/api/monitors', { id: monitor.id }, cookie, true), /failure/)
  assert.equal((await engine.snapshot()).monitors.length, 1)
  assert.equal((await state())!.up, true)
})

test('configuration enforces interval/URL boundaries without mutating history', () => {
  assert.throws(() => parseMonitor({ ...monitor, target: 'javascript:alert(1)' }), /HTTP/)
  assert.throws(() => parseMonitor({ ...monitor, intervalMinutes: 15 }), /间隔/)
  assert.throws(() => parseMonitor({ ...monitor, timeout: 0 }), /超时/)
  assert.equal(parseMonitor({ ...monitor, id: 'other' }, monitor).id, monitor.id)
  assert.equal(parseMonitor({ ...monitor, timeout: 4500 }).timeout, 4500)
})

test('shorter interval skips cleanly; healthy monitors prune old incidents and latency', async t => {
  const { storage, network, engine, state } = fixture(t)
  const old = freshState()
  old.startedAt = network.now() / 1000 - 100 * 86400
  old.incidents = [{ start: [old.startedAt], end: old.startedAt + 60, error: ['old'] }]
  old.latency = [{ time: old.startedAt, ping: 70000 }]
  await storage.put({ monitors: [{ ...monitor, intervalMinutes: 20 }], [stateKey(monitor.id)]: old })
  await engine.run()
  assert.equal((await state())!.incidents.length, 0)
  assert.equal((await state())!.latency.length, 1)
  const writes = storage.writes
  network.advance(600)
  await engine.run()
  assert.equal(network.checks.length, 1)
  assert.equal(storage.writes - writes, 1)
  network.advance(600)
  await engine.run()
  assert.equal(network.checks.length, 2)
})

test('session does not disclose its signing secret and rejects tampering and expiry', async t => {
  const { storage, network, engine } = fixture(t)
  const cookie = await login(engine)
  const admin = await storage.get<any>('admin')
  assert.ok(!cookie.includes(admin.passwordHash))
  assert.ok(!cookie.includes(admin.sessionKey))
  assert.notEqual(admin.sessionKey, admin.passwordHash)
  assert.equal(await authenticated({ ...admin, sessionKey: admin.passwordHash }, cookie, network.now()), false)
  assert.equal(await authenticated(admin, cookie, network.now()), true)
  assert.equal(await authenticated(admin, cookie.replace(/.$/, 'z'), network.now()), true) // trailing cookie attribute is not part of token
  const value = cookie.split(';')[0]
  assert.equal(await authenticated(admin, value.slice(0, -1) + 'z', network.now()), false)
  assert.equal(await authenticated(admin, cookie, network.now() + 2592001000), false)
  assert.equal(await authenticated(admin, 'status_admin_session=%invalid', network.now()), false)
  const results = await Promise.allSettled([engine.request('POST', '/api/admin', { action: 'setup', username: 'a', password: 'password123' }, '', true), engine.request('POST', '/api/admin', { action: 'setup', username: 'b', password: 'password123' }, '', true)])
  assert.ok(results.every(result => result.status === 'rejected'))
  // Logout rotates the signing key: a copied token dies with the session.
  await engine.request('POST', '/api/admin', { action: 'logout' }, cookie, true)
  const rotated = await storage.get<any>('admin')
  assert.notEqual(rotated.sessionKey, admin.sessionKey)
  assert.equal(await authenticated(rotated, cookie, network.now()), false)
})

test('new installation races allow exactly one administrator', async t => {
  const { engine } = fixture(t)
  const results = await Promise.allSettled(['a', 'b'].map(username => engine.request('POST', '/api/admin', { action: 'setup', username, password: 'password123' }, '', true)))
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
})

test('settings persist across restart and drive the notification webhook', async t => {
  const { storage, network, engine } = fixture(t)
  const cookie = await login(engine)
  const saved = await engine.request('PUT', '/api/settings', { title: '新标题', timeZone: 'Europe/Berlin', webhook: 'https://hook.example.com/abc' }, cookie, true)
  assert.equal((saved.data as { title: string }).title, '新标题')
  network.webhook = 'hook.example.com' // teach the traffic splitter the new webhook host
  await storage.put({ monitors: [monitor] })
  network.statuses = [503, 503]
  await engine.run()
  // The outage notice rides the configured webhook, not the factory default.
  assert.equal(network.notices.length, 1)
  assert.ok(network.notices[0].startsWith('https://hook.example.com/abc/'))
  // A restart loads settings from storage — the title survives.
  const restarted = new Engine(storage, network, settings)
  assert.equal((await restarted.snapshot()).title, '新标题')
  // Validation: bad timezone and webhook are rejected; UTC is a valid name
  // even though it has no "/" separator; blank webhook clears notifications.
  await assert.rejects(engine.request('PUT', '/api/settings', { title: 'x', timeZone: 'Mars/Olympus', webhook: '' }, cookie, true), /时区/)
  await assert.rejects(engine.request('PUT', '/api/settings', { title: 'x', timeZone: 'Asia/Shanghai', webhook: 'ftp://x' }, cookie, true), /通知地址/)
  const utc = await engine.request('PUT', '/api/settings', { title: 'x', timeZone: 'UTC', webhook: '' }, cookie, true)
  assert.equal((utc.data as { timeZone: string }).timeZone, 'UTC')
  // A blank webhook promises "no notifications" — no request may leave at all.
  network.webhook = 'no-such-host.invalid'
  network.statuses = [503, 503]
  network.advance(600)
  const hookRequests = () => network.requests.filter(url => url.includes('/abc/')).length
  const before = hookRequests()
  await engine.run()
  assert.equal(hookRequests() - before, 0)
  // An alarm firing immediately after construction must not race the async
  // settings load: hold the settings read, queue one notice with NO monitors
  // (so the only outbound candidate is that notice), start run(), and prove
  // nothing leaves — not even to the factory webhook — once settings (blank
  // webhook) win. A constructor that skipped the serialized load would send
  // the queued notice via the factory webhook and fail this zero-request bar.
  await storage.put({ monitors: [], notices: [{ monitor, up: false, first: true, start: network.now() / 1000, time: network.now() / 1000, reason: 'held' }] })
  const releaseSettings = storage.hold('settings')
  const raced = new Engine(storage, network, settings)
  const racedBefore = network.requests.length
  const round = raced.run()
  await new Promise(resolve => setTimeout(resolve, 0)) // let run() queue behind the held load
  releaseSettings()
  await round
  assert.equal(network.requests.length - racedBefore, 0)
})

test('supervisor re-arms missing alarms and health reports stale data honestly', async t => {
  const { storage, network, engine } = fixture(t)
  await storage.put({ monitors: [monitor] })
  assert.equal((await engine.health()).healthy, false)
  await engine.run()
  assert.equal((await engine.health()).healthy, true)
  network.advance(1600)
  await engine.supervise()
  assert.equal(storage.alarm, network.now() + 1000)
  assert.equal((await engine.health()).healthy, false)
})

test('100-monitor simulation respects concurrency and a 24-hour write budget', async t => {
  const { storage, network, engine } = fixture(t)
  await storage.put({ monitors: Array.from({ length: 100 }, (_, i) => ({ ...monitor, id: `m${i}`, target: `https://example.com/${i}` })) })
  const writes = storage.writes
  const cpu = process.cpuUsage()
  for (let round = 0; round < 144; round++) {
    for (let batch = 0; batch < 3; batch++) {
      const before = network.checks.length
      await engine.run()
      assert.ok(network.checks.length - before <= 40)
    }
    network.advance()
  }
  const elapsed = process.cpuUsage(cpu)
  assert.ok(network.maxActive <= 4)
  assert.equal(network.checks.length, 14400)
  assert.equal(storage.writes - writes, 14832)
  assert.equal(network.notices.length, 0)
  t.diagnostic(`24h/100 monitors: ${network.checks.length} probe requests, ${storage.writes - writes} KV-row writes, 0 external KV/D1 calls; local CPU ${(elapsed.user + elapsed.system) / 1000}ms (not Cloudflare CPU)`)
})
