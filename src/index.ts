import { DurableObject } from 'cloudflare:workers'
import { Engine } from './engine'
import { settings } from './config'
import { importLegacy } from './legacy'
import { detailPage, INTERVAL_OPTIONS, layout, loginPage, managePage, statusPage, TIMEOUT_OPTIONS, type DetailBoot, type StatusBoot } from './pages'
import { HttpError, type Monitor, type Storage } from './types'

type Env = {
  MONITOR_SCHEDULER_DO: DurableObjectNamespace<MonitorScheduler>
  UPTIMEFLARE_D1?: D1Database
  MONITOR_TRIGGER_SECRET?: string
}
export class MonitorScheduler extends DurableObject<Env> {
  private engine: Engine
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    const storage = ctx.storage as unknown as Storage
    // A failed import must never brick the object: the monitor list already
    // lives in storage, so the engine starts regardless and the (idempotent)
    // import retries on the next wake.
    ctx.blockConcurrencyWhile(() => importLegacy(storage, env.UPTIMEFLARE_D1).catch(error => console.error('Legacy import deferred to next wake:', error)))
    this.engine = new Engine(storage, { now: Date.now, fetch: globalThis.fetch.bind(globalThis), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) }, settings)
  }
  async snapshot(id?: string) {
    try { return { data: await this.engine.snapshot(id), error: undefined } }
    catch (error) {
      if (!(error instanceof HttpError)) throw error
      return { data: undefined, error: { message: error.message, status: error.status } }
    }
  }
  health() { return this.engine.health() }
  supervise() { return this.engine.supervise() }
  async request(method: string, path: string, input: Record<string, unknown>, cookie: string, secure: boolean) {
    try {
      const result = await this.engine.request(method, path, input, cookie, secure)
      return { body: JSON.stringify(result.data), cookie: result.cookie, status: 200 }
    } catch (error) {
      if (!(error instanceof HttpError)) throw error
      return { body: JSON.stringify({ error: error.message }), cookie: undefined, status: error.status }
    }
  }
  runNow() { return this.engine.run() }
  alarm() { return this.engine.run() }
}
const json = (data: unknown, status = 200, headers: HeadersInit = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } })
const html = (body: string, cacheControl: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': cacheControl } })
const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } })
const stub = (env: Env) => env.MONITOR_SCHEDULER_DO.get(env.MONITOR_SCHEDULER_DO.idFromName('default'))

// The client boot payload: one shape feeds both the server-rendered HTML and
// the browser runtime, so SSR markup and JS rendering can never disagree.
const toTarget = (m: Monitor) => ({ id: m.id, name: m.name, target: m.target, group: m.group, timeout: m.timeout, intervalMinutes: m.intervalMinutes, ...(m.preview ? { preview: m.preview } : {}), ...(m.statusPageLink ? { statusPageLink: m.statusPageLink } : {}), ...(m.tooltip ? { tooltip: m.tooltip } : {}) })

type AdminInfo = { hasAdmin: boolean; isAuthenticated: boolean }
type SnapshotItem = Monitor & { startedAt: number; checkedAt: number; up: boolean | null; error: string; notified: boolean; incidents: StatusBoot['incident'][string]; latency?: { time: number; ping: number; loc: string }[]; ping: number | null; location: string | null }
type Snapshot = { title: string; updatedAt: number; up: number; down: number; monitors: SnapshotItem[] }

async function page(request: Request, env: Env, ctx: ExecutionContext, path: string): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405)
  const url = new URL(request.url)
  const cookie = request.headers.get('cookie') ?? ''
  const secure = url.protocol === 'https:'
  const backend = stub(env)
  const adminInfo = async (): Promise<AdminInfo | null> => {
    try { return JSON.parse((await backend.request('GET', '/api/admin', {}, cookie, secure)).body) as AdminInfo }
    catch { return null }
  }
  const admin = cookie ? await adminInfo() : null
  const isAdmin = admin?.isAuthenticated === true

  if (path === '/manage') {
    const result = await backend.request('GET', '/api/monitors', {}, cookie, secure)
    if (result.status !== 200) return redirect('/login')
    const monitors = (JSON.parse(result.body) as { monitors: Monitor[] }).monitors
    const boot = { timeoutOptions: TIMEOUT_OPTIONS, intervalOptions: INTERVAL_OPTIONS, monitors: monitors.map(toTarget) }
    return html(layout({ title: '站点管理', isAdmin: true, manage: true, boot, links: settings.links }, managePage(monitors)), 'private, no-store')
  }
  if (path === '/login') {
    if (isAdmin) return redirect('/manage')
    const info = admin ?? await adminInfo()
    const hasAdmin = info?.hasAdmin === true
    return html(layout({ title: hasAdmin ? '管理员登录' : '设置管理员', isAdmin: false, links: settings.links }, loginPage(hasAdmin)), 'private, no-store')
  }

  // / and /m/:id — anonymous visitors share one edge-cached render; a valid
  // admin session gets fresh HTML with the admin nav (never cached).
  const id = path.startsWith('/m/') ? path.slice(3) : undefined
  if (id === '') return redirect('/')
  const key = url.origin + path
  if (!isAdmin) {
    const cached = await caches.default.match(key)
    if (cached) return cached
  }
  const result = await backend.snapshot(id)
  if (result.error) {
    if (result.error.status !== 404) throw new HttpError(result.error.message, result.error.status)
    return html(layout({ title: '未找到监测项', isAdmin, links: settings.links }, detailPage(null, false, id ?? '')), 'private, no-store', 404)
  }
  const snap = result.data!
  if (id) {
    const item = snap.monitors[0]
    const boot: DetailBoot = { monitor: toTarget(item), up: item.up, incident: item.incidents, latency: item.latency ?? [], ...(item.startedAt > 0 ? { startedAt: item.startedAt } : {}), lastUpdate: snap.updatedAt, maintenances: settings.maintenances }
    const body = layout({ title: `${item.name} - ${settings.title}`, isAdmin, boot, links: settings.links }, detailPage(boot, true, id))
    return finish(body, key, isAdmin, ctx)
  }
  const boot: StatusBoot = {
    title: settings.title,
    lastUpdate: snap.updatedAt,
    overallUp: snap.up,
    overallDown: snap.down,
    monitors: snap.monitors.map(toTarget),
    up: Object.fromEntries(snap.monitors.map(m => [m.id, m.up])),
    incident: Object.fromEntries(snap.monitors.map(m => [m.id, m.incidents])),
    startedAt: Object.fromEntries(snap.monitors.filter(m => m.startedAt > 0).map(m => [m.id, m.startedAt])),
    lastPing: Object.fromEntries(snap.monitors.filter(m => m.ping !== null).map(m => [m.id, m.ping as number])),
    maintenances: settings.maintenances,
  }
  return finish(layout({ title: settings.title, isAdmin, boot, links: settings.links }, statusPage(boot)), key, isAdmin, ctx)
}
function finish(body: string, key: string, isAdmin: boolean, ctx: ExecutionContext) {
  const response = html(body, isAdmin ? 'private, no-store' : 'public, max-age=0, s-maxage=30')
  if (!isAdmin) ctx.waitUntil(caches.default.put(key, response.clone()))
  return response
}

export async function handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname
  const backend = stub(env)
  try {
    if (path === '/health') {
      const health = await backend.health()
      return json(health, health.healthy ? 200 : 503, { 'cache-control': 'no-store' })
    }
    if (path === '/trigger') {
      const secret = env.MONITOR_TRIGGER_SECRET
      if (!secret || (request.headers.get('authorization') !== `Bearer ${secret}` && url.searchParams.get('secret') !== secret)) return json({ error: 'unauthorized' }, 401)
      ctx.waitUntil(backend.runNow())
      return json({ triggered: true }, 202, { 'cache-control': 'no-store' })
    }
    if (path === '/api/admin' || path === '/api/monitors') {
      let input: Record<string, unknown> = {}
      if (request.method !== 'GET') {
        try { input = await request.json() as Record<string, unknown> }
        catch { throw new HttpError('请求 JSON 无效') }
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError('请求需要 JSON 对象')
      }
      const result = await backend.request(request.method, path, input, request.headers.get('cookie') ?? '', url.protocol === 'https:')
      return new Response(result.body, { status: result.status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...(result.cookie ? { 'set-cookie': result.cookie } : {}) } })
    }
    if (['/', '/login', '/manage'].includes(path) || path.startsWith('/m/')) return await page(request, env, ctx, path)
    if (!['/api/view', '/api/data', '/api/status', '/api/badge'].includes(path)) return json({ error: 'not found' }, 404)
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS' } })
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405)
    const id = ['/api/status', '/api/view'].includes(path) ? url.searchParams.get('id') ?? undefined : undefined
    // Cache keys ignore cookies and irrelevant query parameters, and never cache admin responses.
    const key = new URL(url.origin + path)
    if (id) key.searchParams.set('id', id)
    if (path === '/api/badge') for (const name of ['id', 'label']) if (url.searchParams.has(name)) key.searchParams.set(name, url.searchParams.get(name)!)
    const cache = caches.default
    const cached = await cache.match(key.href)
    if (cached) return cached
    const result = await backend.snapshot(path === '/api/status' ? id ?? '' : id)
    if (result.error) throw new HttpError(result.error.message, result.error.status)
    const snapshot = result.data!
    let data: unknown = snapshot
    if (path === '/api/data') data = {
      up: snapshot.up, down: snapshot.down, updatedAt: snapshot.updatedAt, maintenances: snapshot.maintenances,
      monitors: Object.fromEntries(snapshot.monitors.map(m => [m.id, { up: m.up, latency: m.ping, location: m.location, message: m.up === null ? 'Pending first check' : m.up ? 'OK' : m.error }])),
    }
    if (path === '/api/status') data = {
      lastUpdate: snapshot.updatedAt, overallUp: snapshot.up, overallDown: snapshot.down,
      incident: Object.fromEntries(snapshot.monitors.map(m => [m.id, m.incidents])),
      latency: Object.fromEntries(snapshot.monitors.map(m => [m.id, m.latency ?? []])),
    }
    if (path === '/api/badge') {
      const monitor = snapshot.monitors.find(m => m.id === url.searchParams.get('id'))
      data = { schemaVersion: 1, label: url.searchParams.get('label') ?? monitor?.name ?? 'status', message: monitor?.up === null || !monitor ? 'unknown' : monitor.up ? `${monitor.ping ?? 0} ms` : 'Down', color: monitor?.up == null ? 'lightgrey' : monitor.up ? '#4c1' : '#e05d44' }
    }
    const response = json(data, 200, { 'cache-control': 'public, max-age=0, s-maxage=30', 'access-control-allow-origin': '*' })
    ctx.waitUntil(cache.put(key.href, response.clone()))
    return response
  } catch (error) {
    console.error(error)
    return json({ error: error instanceof Error ? error.message : '服务暂不可用' }, error instanceof HttpError ? error.status : 500, { 'cache-control': 'no-store' })
  }
}
export default { fetch: handle, scheduled: (_event: ScheduledController, env: Env) => stub(env).supervise() } satisfies ExportedHandler<Env>
