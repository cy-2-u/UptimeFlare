import type { MonitorTarget } from './types'
import { workerConfig } from './config'
import { META_KEY, incidentKey, latencyKey } from './state-format'
import type { RuntimeEnv } from './types'
import { SchedulerError } from './monitors'
import { RunCoordinator } from './util'
import { deleteRows, readValue } from './store'

const CHECK_INTERVAL_MS = 10 * 60 * 1000
const STALE_AFTER_SEC = 25 * 60

// The minimal storage surface the scheduler needs; DurableObjectStorage
// satisfies it structurally (and tests provide an in-memory fake).
type SchedulerStorage = Pick<
  DurableObjectStorage,
  'get' | 'put' | 'delete' | 'getAlarm' | 'setAlarm' | 'transaction'
>

export class SchedulerState {
  private coordinator = new RunCoordinator()

  constructor(
    private storage: SchedulerStorage,
    private env: RuntimeEnv,
    private check: (monitors: MonitorTarget[]) => Promise<void>
  ) {}

  // Arm the alarm unless a future one already exists. Cron and /health both
  // call this; the alarm itself is the real scheduler.
  async ensureAlarm(): Promise<{ nextAlarm: number }> {
    const existing = await this.storage.getAlarm()
    if (existing !== null && existing > Date.now()) return { nextAlarm: existing }
    const nextAlarm = Date.now() + 1000
    await this.storage.setAlarm(nextAlarm)
    return { nextAlarm }
  }

  // Cron supervisor: normally a no-op. Re-arms a missing/expired alarm and
  // force-re-arms when the stored state went stale (e.g. an alarm that exists
  // but stopped persisting rounds), so a broken alarm cannot stay broken long.
  // A missing or zero meta row means a fresh install — trust the armed alarm.
  async healIfStale(): Promise<{ healed: boolean }> {
    const alarm = await this.storage.getAlarm()
    if (alarm !== null && alarm > Date.now()) {
      const metaRaw = await readValue(this.env, META_KEY).catch(() => null)
      const lastUpdate = metaRaw ? ((JSON.parse(metaRaw).lastUpdate as number) ?? 0) : 0
      if (lastUpdate === 0 || Date.now() / 1000 - lastUpdate < STALE_AFTER_SEC) {
        return { healed: false }
      }
    }

    await this.storage.setAlarm(Date.now() + 1000)
    return { healed: true }
  }

  runNow(): Promise<void> {
    return this.coordinator.run(async () => {
      // Arm before external I/O so an interrupted manual run can recover.
      await this.storage.setAlarm(Date.now() + CHECK_INTERVAL_MS)
      try {
        const monitors = await this.readMonitors()
        await this.finishDeletes()
        await this.check(monitors)
      } finally {
        await this.storage.setAlarm(Date.now() + CHECK_INTERVAL_MS)
      }
    })
  }

  // Pure read served without queueing behind a running check, so /health and
  // the manage page stay fast even mid-round.
  async listMonitors(): Promise<MonitorTarget[]> {
    return this.readMonitors()
  }

  private async readMonitors(): Promise<MonitorTarget[]> {
    // DO storage is the single source of truth for page-managed monitors.
    const stored = await this.storage.get<MonitorTarget[]>('monitors')
    return stored ?? []
  }

  addMonitor(monitor: MonitorTarget): Promise<MonitorTarget[]> {
    return this.coordinator.mutate(async () => {
      const monitors = await this.readMonitors()
      if ([...workerConfig.monitors, ...monitors].some((item) => item.id === monitor.id)) {
        throw new SchedulerError('监测 ID 已存在，请换一个名称或 ID', 409)
      }
      await this.finishDeletes()
      const next = [...monitors, monitor]
      await this.storage.put('monitors', next)
      return next
    })
  }

  // Edit a page-managed monitor in place. The id is the history key and can
  // never change, so edits keep all incidents and latency data.
  updateMonitor(monitor: MonitorTarget): Promise<MonitorTarget[]> {
    return this.coordinator.mutate(async () => {
      const monitors = await this.readMonitors()
      const index = monitors.findIndex((item) => item.id === monitor.id)
      if (index === -1) {
        throw new SchedulerError('只能编辑在页面中添加的监测项', 404)
      }
      const next = monitors.slice()
      next[index] = monitor
      await this.storage.put('monitors', next)
      return next
    })
  }

  deleteMonitor(id: string): Promise<MonitorTarget[]> {
    return this.coordinator.mutate(async () => {
      const monitors = await this.readMonitors()
      const pending = (await this.storage.get<string[]>('pendingDeletes')) ?? []
      if (!monitors.some((item) => item.id === id) && !pending.includes(id)) {
        throw new SchedulerError('只能删除在页面中添加的监测项', 404)
      }
      // A failed state read means D1 may be unavailable; abort so we never
      // forget a monitor whose history rows cannot be cleaned up.
      await readValue(this.env, META_KEY)
      const next = monitors.filter((item) => item.id !== id)
      await this.storage.transaction(async (txn) => {
        await txn.put('monitors', next)
        await txn.put('pendingDeletes', Array.from(new Set([...pending, id])))
      })
      await this.finishDeletes()
      return next
    })
  }

  // Two-phase history cleanup: the DO commit above is atomic, the D1 row
  // deletes are retried from here until they succeed.
  private async finishDeletes(): Promise<void> {
    const pending = (await this.storage.get<string[]>('pendingDeletes')) ?? []
    if (!pending.length) return

    const keys = pending.flatMap((id) => [latencyKey(id), incidentKey(id)])
    await deleteRows(this.env, keys)
    await this.storage.delete('pendingDeletes')
  }
}
