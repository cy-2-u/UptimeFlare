import { authenticated, passwordHash, random, safeEqual, sessionCookie, token } from './auth'
import { check, parseMonitor, ProbeBudget, transition } from './monitor'
import { notify } from './notify'
import { freshState, HttpError, stateKey, type Credentials, type Monitor, type Notice, type Runtime, type Settings, type State, type Storage } from './types'

const TICK = 600000
export class Engine {
  private tail: Promise<unknown> = Promise.resolve()
  private running?: Promise<void>
  // Edited monitors skip the interval gate for one round: a changed target
  // must not keep showing the old address's result for up to ten minutes.
  private forceNext = new Set<string>()
  private config: Settings
  constructor(private storage: Storage, private runtime: Runtime, defaults: Settings) {
    // Live settings come from storage; a fresh install seeds the factory
    // defaults. The load is queued on the same serial lane as rounds, so an
    // alarm firing right after construction never reads half-initialized config.
    this.config = defaults
    this.serial(() => storage.get<Settings>('settings').then(s => { if (s) this.config = s }))
  }
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
  // A fresh monitor would otherwise sit unchecked until the next anchored
  // tick — up to ten minutes of "等待检查". Pull the alarm in instead.
  private async ensureAlarmSoon() {
    const soon = this.runtime.now() + 2000
    const existing = await this.storage.getAlarm()
    if (existing === null || existing > soon) await this.storage.setAlarm(soon)
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
  run(): Promise<void> {
    if (this.running) return this.running
    const task = this.serial(async () => {
      const started = this.runtime.now()
      await this.storage.setAlarm(started + TICK)
      let continuation = false
      try {
        const monitors = await this.monitors()
        const states = new Map(await Promise.all(monitors.map(async m => [m.id, await this.state(m.id)] as const)))
        const due = monitors.filter(m => this.forceNext.delete(m.id) || !states.get(m.id)!.checkedAt || started / 1000 - states.get(m.id)!.checkedAt >= m.intervalMinutes * 60 - 30)
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
              const result = await check(monitor, budget)
              const updated = transition(monitor, states.get(monitor.id)!, result)
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
        // Ten deliveries leave the probe budget below the free-plan 50-subrequest
        // ceiling. An empty webhook keeps the queue for later: rounds still record
        // incidents, but nothing is sent or removed while sending is paused.
        // Delivery is best-effort: a failed send is caught and the batch is
        // consumed anyway (crash before removal may re-send; send failure loses
        // that notice — acceptable for a personal status page).
        const batch = this.config.webhook ? pending.slice(0, 10) : []
        for (const notice of batch) {
          try { await notify(notice, this.config, this.runtime) }
          catch (error) { console.error('Notification failed:', error) }
        }
        if (batch.length) await this.storage.put({ notices: pending.slice(batch.length) })
        // Continuation is for pending work only: leftover notices (batch was
        // full) or exhausted probe budget. A paused (blank-webhook) queue must
        // NOT re-arm the alarm every second — it would burn DO invocations.
        continuation ||= batch.length > 0 && pending.length > batch.length
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
      return { ...monitor, ...state, incidents: state.incidents.filter(i => i.end === null || i.end >= now - 7776000), latency: full ? state.latency.filter(p => p.time >= now - 43200) : undefined, ping: state.latency.at(-1)?.ping ?? null }
    }))
    return { title: this.config.title, updatedAt: (await this.storage.get<number>('lastUpdate')) ?? 0, up: items.filter(i => i.up === true).length, down: items.filter(i => i.up === false).length, monitors: items }
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
      // Logout rotates the signing key: with stateless tokens, deleting the
      // cookie alone leaves a copied session valid for its full 30-day TTL.
      if (input.action === 'logout') {
        if (admin) await this.storage.put({ admin: { ...admin, sessionKey: random() } })
        return { data: { ok: true }, cookie: sessionCookie('', secure) }
      }
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
    if (path === '/api/settings') {
      if (method === 'GET') return { data: this.config }
      if (method === 'PUT') return this.serial(async () => {
        const title = String(input.title ?? '').trim()
        if (!title || title.length > 80) throw new HttpError('标题需要 1 到 80 个字符')
        const timeZone = String(input.timeZone ?? '').trim()
        // Intl itself is the validator: it accepts IANA names, "UTC" and
        // Etc/GMT zones alike — no regex gatekeeper in front of it.
        try { new Intl.DateTimeFormat('zh-CN', { timeZone }) } catch { throw new HttpError('时区格式无效（如 Asia/Shanghai 或 UTC）') }
        const webhook = String(input.webhook ?? '').trim()
        if (webhook) try { if (!['http:', 'https:'].includes(new URL(webhook).protocol)) throw Error() } catch { throw new HttpError('通知地址需要是有效的 HTTP 或 HTTPS URL') }
        this.config = { title, timeZone, webhook }
        await this.storage.put({ settings: this.config })
        return { data: this.config }
      })
      throw new HttpError('不支持的方法', 405)
    }
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
      if (previous) this.forceNext.add(monitor.id)
      await this.ensureAlarmSoon()
      return { data: { monitor, monitors: next } }
    })
  }
}
