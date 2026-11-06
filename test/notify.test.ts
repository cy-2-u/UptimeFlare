import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildNotificationMessage, buildPushUrl } from '../src/notify'
import type { MonitorTarget } from '../src/types'

const monitor = { id: 'm1', name: '主站', target: 'https://example.com' } as MonitorTarget

const base = {
  monitor,
  timeIncidentStart: 1700000000,
  timeNow: 1700000000,
  reason: 'HTTP 503',
  timeZone: 'Asia/Shanghai',
}

test('buildNotificationMessage: first down has short title and detail body', () => {
  const { title, body } = buildNotificationMessage({ ...base, isUp: false })
  assert.equal(title, '🔴 [主站] 已宕机')
  assert.ok(body.includes('起不可用') && body.includes('原因: HTTP 503'))
})

test('buildNotificationMessage: ongoing down includes duration', () => {
  const { title, body } = buildNotificationMessage({
    ...base,
    isUp: false,
    timeNow: 1700000000 + 15 * 60,
  })
  assert.equal(title, '🔴 [主站] 依然宕机')
  assert.ok(body.includes('已持续 15 分钟'))
})

test('buildNotificationMessage: recovery uses green title', () => {
  const { title, body } = buildNotificationMessage({ ...base, isUp: true, timeNow: 1700000000 + 15 * 60 })
  assert.equal(title, '🟢 [主站] 已恢复')
  assert.ok(body.includes('恢复可用') && body.includes('15 分钟'))
})

test('buildPushUrl: GET path segments and query params match timelynotify format', () => {
  const url = buildPushUrl('🔴 [主站] 已宕机', '服务自 11/14, 21:10 起不可用。\n原因: HTTP 503')

  const parsed = new URL(url)
  assert.equal(parsed.origin, 'https://timelynotify.oicode.cn')
  const segments = parsed.pathname.split('/').filter(Boolean)
  assert.equal(segments.length, 3)
  assert.equal(segments[0], 'Nt5RQRHQ5Vg5fNHdJF54Z9')
  assert.equal(decodeURIComponent(segments[1]), '🔴 [主站] 已宕机')
  assert.equal(decodeURIComponent(segments[2]), '服务自 11/14, 21:10 起不可用。\n原因: HTTP 503')
  assert.equal(parsed.searchParams.get('icon'), 'https://static.wallleap.cn/temp/nwvgnm7l2on5u6c531mo.jpg')
  assert.equal(parsed.searchParams.get('group'), '服务状态')
  assert.equal(parsed.searchParams.get('ttl'), '600')
  assert.equal(parsed.searchParams.get('sound'), 'multiwayinvitation')
})
