import test from 'node:test'
import assert from 'node:assert/strict'
import { RunCoordinator } from '../src/coordinator'

test('overlapping runs share a single execution', async () => {
  const coordinator = new RunCoordinator()
  let calls = 0

  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })

  const first = coordinator.run(async () => {
    calls += 1
    await gate
  })
  const second = coordinator.run(async () => {
    calls += 1
  })
  const third = coordinator.run(async () => {
    calls += 1
  })

  release()
  await Promise.all([first, second, third])
  assert.equal(calls, 1)
})

test('a failed run still releases the coordinator for the next one', async () => {
  const coordinator = new RunCoordinator()

  await assert.rejects(coordinator.run(async () => { throw new Error('boom') }), /boom/)

  let calls = 0
  await coordinator.run(async () => {
    calls += 1
  })
  assert.equal(calls, 1)
})

test('mutations queue in order behind runs', async () => {
  const coordinator = new RunCoordinator()
  const order: string[] = []

  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })

  const run = coordinator.run(async () => {
    await gate
    order.push('run')
  })
  const mutation = coordinator.mutate(async () => {
    order.push('mutate-1')
    return 1
  })
  const mutation2 = coordinator.mutate(async () => {
    order.push('mutate-2')
    return 2
  })

  release()
  await Promise.all([run, mutation, mutation2])
  assert.deepEqual(order, ['run', 'mutate-1', 'mutate-2'])
})
