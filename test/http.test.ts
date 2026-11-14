import test from 'node:test'
import assert from 'node:assert/strict'

const base = process.env.TEST_URL
const integration = base ? test : test.skip
integration('real Workers runtime: static delivery, page auth, RPC errors, authentication, CRUD and API compatibility', async () => {
  const call = async (path: string, method = 'GET', body?: unknown, cookie = '') => {
    const response = await fetch(base + path, { method, redirect: 'manual', headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { response, data: await response.json().catch(() => null) as Record<string, any> }
  }
  // Anonymous pages: status renders, manage bounces to login, unknown monitor 404s.
  const home = await fetch(base + '/')
  assert.equal(home.status, 200)
  const homeText = await home.text()
  assert.ok(homeText.includes('<!doctype html>'))
  assert.ok(homeText.includes('id="bootstrap"'))
  assert.ok(!homeText.includes('data-action="logout"'))
  assert.equal((await fetch(base + '/manage', { redirect: 'manual' })).status, 302)
  assert.equal((await fetch(base + '/login')).status, 200)
  assert.equal((await fetch(base + '/m/missing', { redirect: 'manual' })).status, 404)
  assert.equal((await fetch(base + '/nope')).status, 404)
  assert.equal((await call('/api/monitors')).response.status, 401)
  for (const path of ['/api/view?id=missing', '/api/status?id=missing']) assert.equal((await call(path)).response.status, 404)
  const setup = await call('/api/admin', 'POST', { action: 'setup', username: 'runtime', password: 'password123' })
  let cookie = setup.response.headers.get('set-cookie')
  if (setup.response.status === 409) cookie = (await call('/api/admin', 'POST', { action: 'login', username: 'runtime', password: 'password123' })).response.headers.get('set-cookie')
  assert.ok(cookie)
  assert.equal((await call('/api/admin', 'POST', { action: 'login', username: 'runtime', password: 'wrongpassword' })).response.status, 401)
  // Admin pages: truthful nav, no redirect bounce, no flash.
  const manage = await fetch(base + '/manage', { redirect: 'manual', headers: { cookie: cookie! } })
  assert.equal(manage.status, 200)
  assert.ok((await manage.text()).includes('data-action="logout"'))
  assert.equal((await fetch(base + '/login', { redirect: 'manual', headers: { cookie: cookie! } })).status, 302)
  const added = await call('/api/monitors', 'POST', { id: 'runtime-check', name: '运行时验证', target: 'https://example.com' }, cookie!)
  assert.equal(added.response.status, 200)
  assert.equal((await call('/api/monitors', 'PUT', { id: 'runtime-check', name: '已编辑', timeout: 4500 }, cookie!)).response.status, 200)
  const list = await call('/api/monitors', 'GET', undefined, cookie!)
  assert.equal(list.data.monitors.find((m: any) => m.id === 'runtime-check').timeout, 4500)
  assert.equal(list.response.headers.get('cache-control'), 'no-store')
  const detail = await fetch(base + '/m/runtime-check', { headers: { cookie: cookie! } })
  assert.equal(detail.status, 200)
  assert.ok((await detail.text()).includes('已编辑'))
  const summary = await call('/api/data?integration=1')
  assert.ok('up' in summary.data)
  assert.ok(!Array.isArray(summary.data.monitors))
  const history = await call('/api/status?integration=1')
  assert.ok('incident' in history.data && 'latency' in history.data)
  const view = await call('/api/view?integration=1')
  assert.ok(Array.isArray(view.data.monitors))
  const badge = await call('/api/badge?id=runtime-check')
  assert.equal(badge.data.schemaVersion, 1)
  assert.equal((await call('/api/monitors', 'DELETE', { id: 'runtime-check' }, cookie!)).response.status, 200)
  assert.equal((await call('/api/monitors', 'GET', undefined, cookie!)).data.monitors.length, 0)
  assert.equal((await fetch(base + '/m/runtime-check', { redirect: 'manual' })).status, 404)
  assert.equal((await call('/trigger')).response.status, 401)
})
