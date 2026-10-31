import test from 'node:test'
import assert from 'node:assert/strict'
import { dispatchNotices, sendNotification, shouldSendNotification } from '../src/notify'
import type { PendingNotice } from '../src/stateops'
import { installFetchRecorder, makeMonitor } from './fakes'

const monitor = makeMonitor({ name: '示例站点' })

function notice(partial: Partial<PendingNotice> = {}): PendingNotice {
  return {
    monitor,
    isUp: false,
    timeIncidentStart: 1_700_000_000,
    timeNow: 1_700_000_000,
    reason: 'boom',
    ...partial,
  }
}

test('shouldSendNotification defaults to enabled', () => {
  assert.equal(shouldSendNotification(), true)
})

test('down messages distinguish first detection from ongoing incidents', async () => {
  const recorder = installFetchRecorder()
  try {
    await sendNotification(notice({ isUp: false }))
    await sendNotification(
      notice({ isUp: false, timeNow: 1_700_000_000 + 1800, reason: 'still down' })
    )
    await sendNotification(notice({ isUp: true, timeNow: 1_700_000_000 + 600 }))

    const messages = recorder.calls
      .filter((call) => String(call.url).includes('chuckfang'))
      .map((call) => (JSON.parse(String(call.init?.body)) as { msg: string }).msg)

    assert.equal(messages.length, 3)
    assert.match(messages[0], /已宕机/)
    assert.match(messages[0], /boom/)
    assert.match(messages[1], /依然宕机/)
    assert.match(messages[1], /still down/)
    assert.match(messages[2], /已恢复正常/)
  } finally {
    recorder.restore()
  }
})

test('dispatchNotices sends every notice after the commit', async () => {
  const recorder = installFetchRecorder()
  try {
    await dispatchNotices([
      notice({ monitor: makeMonitor({ id: 'a', name: 'A' }), isUp: true }),
      notice({ monitor: makeMonitor({ id: 'b', name: 'B' }), isUp: false }),
    ])

    const webhookCalls = recorder.calls.filter((call) => String(call.url).includes('chuckfang'))
    assert.equal(webhookCalls.length, 2)
  } finally {
    recorder.restore()
  }
})

test('dispatchNotices respects skipNotificationIds', async () => {
  const recorder = installFetchRecorder()
  try {
    await dispatchNotices(
      [
        notice({ monitor: makeMonitor({ id: 'skipped', name: 'S' }) }),
        notice({ monitor: makeMonitor({ id: 'kept', name: 'K' }) }),
      ],
      { skipNotificationIds: ['skipped'] }
    )

    const webhookCalls = recorder.calls.filter((call) => String(call.url).includes('chuckfang'))
    assert.equal(webhookCalls.length, 1)
    const body = JSON.parse(String(webhookCalls[0].init?.body)) as { msg: string }
    assert.match(body.msg, /\[K\]/)
  } finally {
    recorder.restore()
  }
})

test('a failing webhook never throws', async () => {
  const recorder = installFetchRecorder((url) =>
    String(url).includes('chuckfang') ? new Response('nope', { status: 500 }) : undefined
  )
  try {
    await sendNotification(notice())
    // Also with a network-level failure.
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = (async () => {
      throw new Error('network down')
    }) as typeof fetch
    await sendNotification(notice())
  } finally {
    recorder.restore()
  }
})
