/// <reference types="node" />
import test from 'node:test'
import assert from 'node:assert/strict'
import { RunCoordinator } from './coordinator'

test('coalesces concurrent runs', async () => {
  const coordinator = new RunCoordinator()
  let calls = 0
  const run = () =>
    coordinator.run(async () => {
      calls += 1
      await Promise.resolve()
    })
  await Promise.all([run(), run(), run()])
  assert.equal(calls, 1)
})

test('continues after a failed task', async () => {
  const coordinator = new RunCoordinator()
  await assert.rejects(() =>
    coordinator.mutate(async () => {
      throw new Error('expected')
    })
  )
  let completed = false
  await coordinator.mutate(async () => {
    completed = true
  })
  assert.equal(completed, true)
})
