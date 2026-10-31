import test from 'node:test'
import assert from 'node:assert/strict'
import { checkMonitor, getStatus } from '../src/checks'
import { installFetchRecorder, makeMonitor } from './fakes'

test('a 2xx response with default expectations is up', async () => {
  const recorder = installFetchRecorder((url) =>
    String(url).startsWith('https://example.com') ? new Response('ok', { status: 200 }) : undefined
  )
  try {
    const status = await getStatus(makeMonitor())
    assert.equal(status.up, true)
    assert.equal(status.err, '')
    assert.ok(status.ping >= 0)
  } finally {
    recorder.restore()
  }
})

test('unexpected status codes and keywords mark the monitor down', async () => {
  const recorder = installFetchRecorder((url) => {
    if (!String(url).startsWith('https://example.com')) return undefined
    return new Response('hello', { status: 404 })
  })
  try {
    const status = await getStatus(makeMonitor())
    assert.equal(status.up, false)
    assert.match(status.err, /Got: 404/)
  } finally {
    recorder.restore()
  }

  const keywordRecorder = installFetchRecorder((url) =>
    String(url).startsWith('https://example.com')
      ? new Response('welcome to the party', { status: 200 })
      : undefined
  )
  try {
    const status = await getStatus(makeMonitor({ responseKeyword: 'success' }))
    assert.equal(status.up, false)
    assert.match(status.err, /keyword/)
  } finally {
    keywordRecorder.restore()
  }

  const forbiddenRecorder = installFetchRecorder((url) =>
    String(url).startsWith('https://example.com')
      ? new Response('everything is bad gateway today', { status: 200 })
      : undefined
  )
  try {
    const status = await getStatus(makeMonitor({ responseForbiddenKeyword: 'bad gateway' }))
    assert.equal(status.up, false)
    assert.match(status.err, /forbidden keyword/)
  } finally {
    forbiddenRecorder.restore()
  }
})

test('expectedCodes beyond 2xx are honored', async () => {
  const recorder = installFetchRecorder((url) =>
    String(url).startsWith('https://example.com')
      ? new Response('moved', { status: 301 })
      : undefined
  )
  try {
    const strict = await getStatus(makeMonitor())
    assert.equal(strict.up, false)

    const lenient = await getStatus(makeMonitor({ expectedCodes: [301] }))
    assert.equal(lenient.up, true)
  } finally {
    recorder.restore()
  }
})

test('checkMonitor retries a failed check before confirming downtime', async () => {
  let hits = 0
  const recorder = installFetchRecorder((url) => {
    if (!String(url).startsWith('https://example.com')) return undefined
    hits += 1
    return new Response('nope', { status: 500 })
  })
  try {
    const outcome = await checkMonitor(makeMonitor(), 'TEST')
    assert.equal(hits, 2) // confirmation attempt
    assert.equal(outcome.status.up, false)
    assert.equal(outcome.checkedAt > 0, true)
  } finally {
    recorder.restore()
  }
})

test('checkMonitor stops at the first success', async () => {
  let hits = 0
  const recorder = installFetchRecorder((url) => {
    if (!String(url).startsWith('https://example.com')) return undefined
    hits += 1
    return new Response('ok', { status: 200 })
  })
  try {
    const outcome = await checkMonitor(makeMonitor(), 'TEST')
    assert.equal(hits, 1)
    assert.equal(outcome.status.up, true)
    assert.equal(outcome.checkLocation, 'TEST')
  } finally {
    recorder.restore()
  }
})
