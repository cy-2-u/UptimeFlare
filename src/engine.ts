import { authenticated, passwordHash, random, safeEqual, sessionCookie, token } from './auth'
import { check, parseMonitor, ProbeBudget, transition } from './monitor'
import { notify } from './notify'
import { freshState, HttpError, stateKey, type Credentials, type Monitor, type Notice, type Runtime, type Settings, type State, type Storage } from './types'

const TICK = 600000
export class Engine {
  private tail: Promise<unknown> = Promise.resolve()
  private running?: Promise<void>
  constructor(private storage: Storage, private runtime: Runtime, private config: Settings) {}
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.tail.then(fn)
    this.tail = task.catch(() => undefined)
    return task
  }
  private async monitors() { return (await this.storage.get<Monitor[]>('monitors')) ?? [] }
  private async state(id: string) { return (await this.storage.get<State>(stateKey(id))) ?? freshState() }
  async ensureAlarm() {
    const existing = await this.storage.getAlarm()
    if (existing !== null && existing > this.runtime.now()) return existing
    const next = this.runtime.now() + 1000
    await this.storage.setAlarm(next)
    return next
  }
  async health() {
    const nextAlarm = await this.ensureAlarm()
    const lastUpdate = (await this.storage.get<number>('lastUpdate')) ?? 0
    const monitors = await this.monitors()
    const stale = monitors.length > 0 && (!lastUpdate || this.runtime.now() / 1000 - lastUpdate > 1500)
    return { healthy: !stale, lastUpdate, lastRunAgoSec: lastUpdate ? Math.floor(this.runtime.now() / 1000) - lastUpdate : null, nextAlarm, monitorCount: monitors.length, serverTime: Math.floor(this.runtime.now() / 1000) }
  }
  async supervise() {
    const lastUpdate = (await this.storage.get<number>('lastUpdate')) ?? 0
    if (lastUpdate && this.runtime.now() / 1000 - lastUpdate > 1500) await this.storage.setAlarm(this.runtime.now() + 1000)
    else await this.ensureAlarm()
  }
  run(loc = 'CF'): Promise<void> {
    if (this.running) return this.running
    const task = this.serial(async () => {
      const started = this.runtime.now()
      await this.storage.setAlarm(started + TICK)
      let continuation = false
      try {
        const monitors = await this.monitors()
        const states = new Map(await Promise.all(monitors.map(async m => [m.id, await this.state(m.id)] as const)))
        const due = monitors.filter(m => !states.get(m.id)!.checkedAt || started / 1000 - states.get(m.id)!.checkedAt >= (m.intervalMinutes ?? 10) * 60 - 30)
        const changes: Record<string, unknown> = {}
        const notices: Notice[] = []
        let requests = 0
        const budget: Runtime = { ...this.runtime, fetch: async (url, init) => {
          if (requests >= 40) throw new ProbeBudget()
          requests++
          return this.runtime.fetch(url, init)
        } }
        let cursor = 0
        await Promise.all(Array.from({ length: Math.min(4, due.length) }, async () => {
          while (cursor < due.length) {
            const monitor = due[cursor++]
            try {
              const result = await check(monitor, budget, loc)
              const updated = transition(monitor, states.get(monitor.id)!, result, this.config)
              changes[stateKey(monitor.id)] = updated.state
              notices.push(...updated.notices)
            } catch (error) {
              if (!(error instanceof ProbeBudget)) throw error
              continuation = true
            }
          }
        }))
        const pending = [...((await this.storage.get<Notice[]>('notices')) ?? []), ...notices]
        if (pending.length) changes.notices = pending
        changes.lastUpdate = Math.floor(this.runtime.now() / 1000)
        await this.storage.put(changes)
        // Ten deliveries leave the probe budget below the free-plan 50-subrequest ceiling.
        const batch = pending.slice(0, 10)
        for (const notice of batch) {
          try { await notify(notice, this.config, this.runtime) }
          catch (error) { console.error('Notification failed:', error) }
        }
        if (batch.length) await this.storage.put({ notices: pending.slice(batch.length) })
        continuation ||= pending.length > batch.length
      } finally {
        // Cadence is anchored to the start; the conditional rewrite only fires when the
        // round actually changed the plan (continuation or a slower-than-tick round).
        const next = continuation ? this.runtime.now() + 1000 : Math.max(started + TICK, this.runtime.now() + 1000)
        if ((await this.storage.getAlarm()) !== next) await this.storage.setAlarm(next)
      }
    })
    this.running = task
    void task.finally(() => { if (this.running === task) this.running = undefined }).catch(() => undefined)
    return task
  }
  async snapshot(id?: string) {
    const monitors = await this.monitors()
    const full = id !== undefined
    const selected = id ? monitors.filter(m => m.id === id) : monitors
    if (id && !selected.length) throw new HttpError('未找到监测项', 404)
    const now = Math.floor(this.runtime.now() / 1000)
    const items = await Promise.all(selected.map(async monitor => {
      const state = await this.state(monitor.id)
      return { ...monitor, ...state, incidents: state.incidents.filter(i => i.end === null || i.end >= now - 7776000), latency: full ? state.latency.filter(p => p.time >= now - 43200) : undefined, ping: state.latency.at(-1)?.ping ?? null, location: state.latency.at(-1)?.loc ?? null }
    }))
    return { title: this.config.title, links: this.config.links, maintenances: this.config.maintenances, updatedAt: (await this.storage.get<number>('lastUpdate')) ?? 0, nextAlarm: await this.storage.getAlarm(), up: items.filter(i => i.up === true).length, down: items.filter(i => i.up === false).length, monitors: items }
  }
  async request(method: string, path: string, input: Record<string, unknown>, cookie: string, secure: boolean): Promise<{ data: unknown; cookie?: string }> {
    if (method === 'GET' && path === '/api/admin') {
      const admin = await this.storage.get<Credentials>('admin')
      return { data: { hasAdmin: !!admin, isAuthenticated: await authenticated(admin, cookie, this.runtime.now()) } }
    }
    if (method === 'POST' && path === '/api/admin') return this.serial(async () => {
      let admin = await this.storage.get<Credentials>('admin')
      const username = String(input.username ?? '').trim()
      const password = String(input.password ?? '')
      if (input.action === 'logout') return { data: { ok: true }, cookie: sessionCookie('', secure) }
      if (input.action === 'setup') {
        if (admin) throw new HttpError('管理员已存在', 409)
        if (!username || username.length > 80 || password.length < 8 || password.length > 1024) throw new HttpError('账号需要 1–80 个字符，密码需要 8–1024 个字符')
        const salt = random()
        admin = { username, salt, passwordHash: await passwordHash(password, salt, 'pbkdf2'), sessionKey: random(), algorithm: 'pbkdf2' }
        await this.storage.put({ admin })
      } else if (input.action === 'login') {
        const hash = await passwordHash(password, admin?.salt ?? '', admin?.algorithm)
        if (!admin || !safeEqual(admin.username, username) || !safeEqual(admin.passwordHash, hash)) throw new HttpError('账号或密码错误', 401)
      } else throw new HttpError('未知操作')
      return { data: { ok: true }, cookie: sessionCookie(await token(admin, this.runtime.now()), secure) }
    })
    const admin = await this.storage.get<Credentials>('admin')
    if (!await authenticated(admin, cookie, this.runtime.now())) throw new HttpError('请先登录', 401)
    if (path !== '/api/monitors') throw new HttpError('未找到接口', 404)
    if (method === 'GET') return { data: { monitors: await this.monitors() } }
    return this.serial(async () => {
      const monitors = await this.monitors()
      if (method === 'DELETE') {
        const id = String(input.id ?? '')
        if (!monitors.some(m => m.id === id)) throw new HttpError('未找到监测项', 404)
        const next = monitors.filter(m => m.id !== id)
        await this.storage.transaction(async txn => {
          const pending = (await txn.get<Notice[]>('notices')) ?? []
          await txn.put({ monitors: next, ...(pending.length ? { notices: pending.filter(n => n.monitor.id !== id) } : {}) })
          await txn.delete(stateKey(id))
        })
        return { data: { monitors: next } }
      }
      if (!['POST', 'PUT'].includes(method)) throw new HttpError('不支持的方法', 405)
      const previous = method === 'PUT' ? monitors.find(m => m.id === input.id) : undefined
      if (method === 'PUT' && !previous) throw new HttpError('未找到监测项', 404)
      const monitor = parseMonitor(input, previous)
      if (!previous && monitors.some(m => m.id === monitor.id)) throw new HttpError('监测 ID 已存在', 409)
      const next = previous ? monitors.map(m => m.id === monitor.id ? monitor : m) : [...monitors, monitor]
      if (next.length > 100) throw new HttpError('单实例最多 100 个站点')
      await this.storage.put({ monitors: next })
      await this.ensureAlarm()
      return { data: { monitor, monitors: next } }
    })
  }
}
