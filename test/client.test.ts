import test from 'node:test'
import assert from 'node:assert/strict'
// Browser math is tested directly, without maintaining a second implementation.
// @ts-expect-error the client module intentionally has no build or declaration step
import { barClass, dayStats } from '../assets/stats.js'

test('uptime bars distinguish pending from perfect uptime and clip incidents to observed time', () => {
  const now = new Date(2026, 10, 13, 12).getTime() / 1000
  const pending = dayStats([], 0, now, 30)
  assert.ok(pending.every((s: any) => s.percent === -1))
  const healthy = dayStats([], now - 3600, now, 1)
  assert.equal(healthy[0].percent, 100)
  assert.equal(healthy[0].monitorTime, 3600)
  const outage = dayStats([{ start: [now - 1800], end: null, error: ['down'] }], now - 3600, now, 1)
  assert.equal(outage[0].percent, 50)
  assert.equal(outage[0].downTime, 1800)
  assert.deepEqual(outage[0].segments, [{ start: now - 1800, end: now, error: 'down' }])
})
test('incident segments split per error and clip to the day boundary', () => {
  const now = new Date(2026, 10, 13, 12).getTime() / 1000
  const dayStart = now - 3600
  const incident = { start: [dayStart - 7200, dayStart - 600], end: dayStart + 1800, error: ['first', 'second'] }
  const days = dayStats([incident], dayStart - 7200, now, 1)
  assert.deepEqual(days[0].segments.map((s: any) => ({ start: s.start, end: s.end, error: s.error })), [
    { start: dayStart - 7200, end: dayStart - 600, error: 'first' },
    { start: dayStart - 600, end: dayStart + 1800, error: 'second' },
  ])
})
test('daily boundaries follow local calendar across daylight-saving changes', () => {
  const before = process.env.TZ
  process.env.TZ = 'America/New_York'
  try {
    const now = new Date(2026, 10, 2, 12).getTime() / 1000
    const days = dayStats([], now - 86400 * 10, now, 3)
    assert.equal(days[1].monitorTime, 90000) // the 25-hour day
    for (const d of days) assert.equal(new Date(d.dayStart * 1000).getHours(), 0) // true local midnights
    assert.equal(days[1].dayStart - days[0].dayStart, 86400)
    assert.equal(days[2].dayStart - days[1].dayStart, 90000) // the 25-hour gap into the fall-back day
  } finally { if (before === undefined) delete process.env.TZ; else process.env.TZ = before }
})
test('bar classes grade by availability', () => {
  assert.equal(barClass(-1), '')
  assert.equal(barClass(100), 'up')
  assert.equal(barClass(98.5), 'up-98')
  assert.equal(barClass(96), 'warn')
  assert.equal(barClass(50), 'bad')
})
