import { Hono } from 'hono'
import { DurableObject } from 'cloudflare:workers'
import type { MonitorTarget } from './types'
import { maintenances, pageConfig } from './config'
import { decodeLatency, emptyMeta, lastLatencyPoint, latencyKey, type MetaRow } from './state-format'
import {
  clearMonitorsCache,
  getEffectiveMonitors,
  getStoredMonitors,
  mergeMonitorUpdate,
  parseNewMonitor,
  schedulerMonitors,
  SchedulerError,
} from './monitors'
import { parseLatencyRow, readLatencySnapshot, readStateSnapshot, readValue } from './store'
import { dispatchNotices } from './notify'
import { SchedulerState } from './scheduler'
import { runChecks } from './round'
import { getWorkerLocation } from './util'
import {
  createAdmin,
  createSession,
  expiredSessionCookie,
  hasAdmin,
  hasSessionCookie,
  isAdminRequest,
  isHttpsRequest,
  sessionCookie,
  verifyAdmin,
} from './auth'
import { Layout } from './pages/layout'
import { StatusPage } from './pages/status'
import { DetailPage } from './pages/detail'
import { ManagePage } from './pages/manage'
import { LoginPage } from './pages/login'

export type Env = {
  Bindings: {
    UPTIMEFLARE_D1?: D1Database
    MONITOR_SCHEDULER_DO?: DurableObjectNamespace<MonitorScheduler>
    MONITOR_TRIGGER_SECRET?: string
  }
}

const app = new Hono<{ Bindings: Env['Bindings'] }>()

// --- helpers -----------------------------------------------------------------

function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json;charset=UTF-8', ...extraHeaders },
  })
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

function getScheduler(env: Env['Bindings']) {
  const namespace = env.MONITOR_SCHEDULER_DO
  if (!namespace) throw new Error('MONITOR_SCHEDULER_DO binding is missing')
  return namespace.get(namespace.idFromName('default'))
}

// Read meta + fully decoded per-monitor state for page rendering. Incidents
// stay in the stored columnar shape (the client runtime reads them as-is).
async function readState(env: Env['Bindings']): Promise<{
  meta: MetaRow
  state: {
    incident: Record<string, import('./types').IncidentRecord[]>
    latency: Record<string, import('./types').LatencyRecord[]>
    startedAt?: Record<string, number>
  }
}> {
  const snapshot = await readStateSnapshot(env)

  let meta: MetaRow = emptyMeta()
  if (snapshot.meta.value !== null) {
    try {
      meta = JSON.parse(snapshot.meta.value) as MetaRow
    } catch {
      meta = emptyMeta()
    }
  }

  // Incidents are stored columnar for cheap D1 writes, but the page payload
  // and client runtime consume plain IncidentRecord[] — convert here, once.
  const incident: Record<string, import('./types').IncidentRecord[]> = {}
  for (const [id, row] of snapshot.inc) {
    if (row.value === null) continue
    const incidents = JSON.parse(row.value) as import('./state-format').IncidentRow
    if (incidents.start.length === 0) continue
    incident[id] = incidents.start.map((starts, i) => ({
      start: starts,
      end: incidents.end[i],
      error: incidents.error[i],
    }))
  }

  const latency: Record<string, import('./types').LatencyRecord[]> = {}
  const startedAt: Record<string, number> = {}
  for (const [id, row] of snapshot.lat) {
    const parsed = parseLatencyRow(row)
    if (!parsed || parsed.time === '') continue
    latency[id] = decodeLatency(parsed)
    if (parsed.startedAt > 0) startedAt[id] = parsed.startedAt
  }

  return { meta, state: { incident, latency, startedAt } }
}

function sanitizeMonitors(monitors: MonitorTarget[]) {
  return monitors.map((monitor) => ({
    id: monitor.id,
    name: monitor.name,
    method: monitor.method,
    target: monitor.target,
    ...(monitor.tooltip ? { tooltip: monitor.tooltip } : {}),
    ...(monitor.statusPageLink ? { statusPageLink: monitor.statusPageLink } : {}),
    ...(monitor.hideLatencyChart ? { hideLatencyChart: true } : {}),
    ...(monitor.preview ? { preview: monitor.preview } : {}),
    ...(monitor.group ? { group: monitor.group } : {}),
    ...(monitor.intervalMinutes ? { intervalMinutes: monitor.intervalMinutes } : {}),
  }))
}

// --- health & trigger ----------------------------------------------------------

app.get('/health', async (c) => {
  const env = c.env

  let nextAlarm: number | null = null
  try {
    nextAlarm = (await getScheduler(env).ensureAlarm()).nextAlarm
  } catch (err) {
    console.log('Failed to arm monitor scheduler: ' + err)
  }

  let meta: MetaRow = emptyMeta()
  try {
    const metaRaw = await readValue(env, 'state:meta')
    if (metaRaw !== null) meta = JSON.parse(metaRaw) as MetaRow
  } catch (err) {
    console.log('Failed to read meta row: ' + err)
  }

  let monitorCount = 0
  try {
    monitorCount = (await getEffectiveMonitors(env)).length
  } catch (err) {
    console.log('Failed to read monitors for health: ' + err)
  }

  const nowSec = Math.round(Date.now() / 1000)
  return json(
    {
      healthy: true,
      workerLocation: (await getWorkerLocation(c.req.raw)) || null,
      lastUpdate: meta.lastUpdate,
      lastRunAgoSec: meta.lastUpdate ? nowSec - meta.lastUpdate : null,
      nextAlarm,
      nextAlarmInSec: nextAlarm ? Math.max(0, Math.round((nextAlarm - Date.now()) / 1000)) : null,
      monitorCount,
      serverTime: nowSec,
    },
    200,
    { 'cache-control': 'no-store' }
  )
})

app.all('/trigger', async (c) => {
  const secret = c.env.MONITOR_TRIGGER_SECRET
  const authorized =
    !!secret &&
    (c.req.header('authorization') === `Bearer ${secret}` ||
      new URL(c.req.url).searchParams.get('secret') === secret)
  if (!authorized) return json({ error: 'unauthorized' }, 401)

  c.executionCtx.waitUntil(getScheduler(c.env).runNow())
  return json({ triggered: true, startedAt: Math.round(Date.now() / 1000) }, 200, {
    'cache-control': 'no-store',
  })
})

// --- public JSON APIs -----------------------------------------------------------

app.get('/api/data', async (c) => {
  const env = c.env
  const snapshot = await readLatencySnapshot(env)
  if (snapshot.meta.value === null) return json({ error: 'No data available' }, 503)

  const meta: MetaRow = JSON.parse(snapshot.meta.value)
  const summaries: Record<
    string,
    { up: boolean | null; latency: number | null; location: string | null; message: string }
  > = {}
  for (const [id, row] of snapshot.lat) {
    const parsed = row.value === null ? null : (JSON.parse(row.value) as import('./state-format').LatencyRow)
    if (!parsed) continue
    const last = lastLatencyPoint(parsed)
    summaries[id] = {
      up: parsed.lastStatus === null ? null : parsed.lastStatus === 'up',
      latency: last?.ping ?? null,
      location: last?.loc ?? null,
      message: parsed.lastStatus === 'down' ? parsed.lastErr || 'DOWN' : 'OK',
    }
  }

  const monitors: Record<string, unknown> = {}
  for (const monitor of await getEffectiveMonitors(env)) {
    monitors[monitor.id] =
      summaries[monitor.id] ?? {
        up: null,
        latency: null,
        location: null,
        message: 'Pending first check',
      }
  }

  return json(
    {
      up: meta.overallUp,
      down: meta.overallDown,
      updatedAt: meta.lastUpdate,
      monitors,
      maintenances,
    },
    200,
    {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'cache-control': 'public, s-maxage=60, stale-while-revalidate=300',
    }
  )
})

app.get('/api/badge', async (c) => {
  const url = new URL(c.req.url)
  const monitorId = url.searchParams.get('id')
  const label = url.searchParams.get('label') ?? monitorId ?? 'status'
  const headers = { 'cache-control': 'public, s-maxage=300, stale-while-revalidate=600' }

  const badge = (message: string, color: string, isError = false) =>
    json(
      { schemaVersion: 1, label, message, color, ...(isError ? { isError: true } : {}) },
      200,
      headers
    )

  if (!monitorId) return badge('no-monitor', 'lightgrey', true)

  try {
    const raw = await readValue(c.env, latencyKey(monitorId))
    let isUp: boolean | null = null
    if (raw !== null) {
      const row = JSON.parse(raw) as { lastStatus: 'up' | 'down' | null }
      isUp = row.lastStatus === null ? null : row.lastStatus === 'up'
    }
    return badge(
      isUp === null
        ? 'pending'
        : isUp
          ? url.searchParams.get('up') ?? 'UP'
          : url.searchParams.get('down') ?? 'DOWN',
      isUp === null
        ? 'lightgrey'
        : isUp
          ? url.searchParams.get('colorUp') ?? 'brightgreen'
          : url.searchParams.get('colorDown') ?? 'red'
    )
  } catch (error) {
    console.error('Error rendering badge API:', error)
    return badge('error', 'lightgrey', true)
  }
})

// Public status API (same-origin only, edge-cached 60s). The bundled client
// polls /api/data for light updates; this endpoint serves the full state for
// external consumers.
app.get('/api/status', async (c) => {
  const host = c.req.header('host')
  const origin = c.req.header('origin')
  const referer = c.req.header('referer')

  let isAllowed = (_value: string | null) => false
  if (host) {
    const parts = host.split(':')[0].split('.')
    const rootDomain =
      parts.length > 2 && !/^\d+\.\d+\.\d+\.\d+$/.test(host) ? parts.slice(1).join('.') : host
    isAllowed = (value: string | null) => {
      if (!value) return false
      try {
        const parsed = new URL(value)
        return parsed.hostname === rootDomain || parsed.hostname.endsWith('.' + rootDomain)
      } catch {
        return false
      }
    }
  }

  if (origin && !isAllowed(origin)) {
    return new Response('Forbidden: Origin not allowed', { status: 403 })
  }
  if (referer && !isAllowed(referer)) {
    return new Response('Forbidden: Referer not allowed', { status: 403 })
  }

  try {
    const { meta, state } = await readState(c.env)
    return json(
      {
        lastUpdate: meta.lastUpdate,
        overallUp: meta.overallUp,
        overallDown: meta.overallDown,
        incident: state.incident,
        latency: state.latency,
      },
      200,
      { 'cache-control': 'public, s-maxage=60, stale-while-revalidate=300' }
    )
  } catch (error: unknown) {
    return json({ error: errorMessage(error, 'Failed to read status') }, 500)
  }
})

// --- admin APIs ------------------------------------------------------------------

app.get('/api/admin', async (c) => {
  return json({
    hasAdmin: await hasAdmin(c.env),
    isAuthenticated: await isAdminRequest(c.req.raw, c.env),
  })
})

app.post('/api/admin', async (c) => {
  try {
    const body = ((await c.req.json()) as Record<string, unknown>) ?? {}
    const action = String(body.action ?? '')
    const username = String(body.username ?? '')
    const password = String(body.password ?? '')
    const secure = isHttpsRequest(c.req.raw)

    if (action === 'setup') {
      const credentials = await createAdmin(c.env, username, password)
      const token = await createSession(c.env, credentials)
      return json({ ok: true }, 201, { 'set-cookie': sessionCookie(token, secure) })
    }
    if (action === 'login') {
      const credentials = await verifyAdmin(c.env, username, password)
      if (!credentials) return json({ error: '账号或密码错误' }, 401)
      const token = await createSession(c.env, credentials)
      return json({ ok: true }, 200, { 'set-cookie': sessionCookie(token, secure) })
    }
    if (action === 'logout') {
      return json({ ok: true }, 200, { 'set-cookie': expiredSessionCookie(secure) })
    }
    return json({ error: '未知操作' }, 400)
  } catch (error: unknown) {
    return json({ error: errorMessage(error, '操作失败') }, 400)
  }
})

app.get('/api/monitors', async (c) => {
  if (!(await isAdminRequest(c.req.raw, c.env))) return json({ error: '需要管理员登录' }, 401)
  const stored = await getStoredMonitors(c.env, { fresh: true })
  return json({ monitors: sanitizeMonitors(await getEffectiveMonitors(c.env)), stored })
})

app.post('/api/monitors', async (c) => {
  if (!(await isAdminRequest(c.req.raw, c.env))) return json({ error: '需要管理员登录' }, 401)
  try {
    const monitor = parseNewMonitor(await c.req.json())
    const authoritative = await schedulerMonitors(c.env, 'POST', monitor)
    clearMonitorsCache()
    return json({ monitor, stored: authoritative }, 201)
  } catch (error: unknown) {
    return json(
      { error: errorMessage(error, '添加失败') },
      error instanceof SchedulerError ? error.status : 400
    )
  }
})

app.put('/api/monitors', async (c) => {
  if (!(await isAdminRequest(c.req.raw, c.env))) return json({ error: '需要管理员登录' }, 401)
  try {
    const body = (await c.req.json()) as Record<string, unknown>
    const id = String(body.id ?? '').trim()
    if (!id) return json({ error: '缺少监测 ID' }, 400)

    const stored = await getStoredMonitors(c.env, { fresh: true })
    const existing = stored.find((item) => item.id === id)
    if (!existing) return json({ error: '只能编辑在页面中添加的监测项' }, 404)

    const updated = mergeMonitorUpdate(existing, body)
    const authoritative = await schedulerMonitors(c.env, 'PUT', updated)
    clearMonitorsCache()
    return json({ monitor: updated, stored: authoritative })
  } catch (error: unknown) {
    return json(
      { error: errorMessage(error, '保存失败') },
      error instanceof SchedulerError ? error.status : 400
    )
  }
})

app.delete('/api/monitors', async (c) => {
  if (!(await isAdminRequest(c.req.raw, c.env))) return json({ error: '需要管理员登录' }, 401)
  try {
    const body = (await c.req.json()) as Record<string, unknown>
    const id = String(body.id ?? '').trim()
    if (!id) return json({ error: '缺少监测 ID' }, 400)
    const nextMonitors = await schedulerMonitors(c.env, 'DELETE', { id })
    clearMonitorsCache()
    return json({ stored: nextMonitors })
  } catch (error: unknown) {
    return json(
      { error: errorMessage(error, '删除失败') },
      error instanceof SchedulerError ? error.status : 400
    )
  }
})

// --- pages -------------------------------------------------------------------------

// Server-side nav auth: anonymous visitors (no cookie) skip the D1 read
// entirely; a present cookie gets real validation. Pages are rendered
// per-request (private, no-store) so the nav is always truthful and never
// flashes "登录" after a back-navigation.
async function navIsAdmin(request: Request, env: Env['Bindings']): Promise<boolean> {
  return hasSessionCookie(request) ? isAdminRequest(request, env) : false
}

app.get('/', async (c) => {
  const env = c.env
  const monitors = await getEffectiveMonitors(env)
  const { meta, state } = await readState(env)

  // Cards only display the latest latency; the full 12h arrays (sparkline
  // material) stay on the detail page, keeping this payload small.
  const lastPing: Record<string, number> = {}
  for (const monitor of monitors) {
    const points = state.latency[monitor.id]
    if (points?.length) lastPing[monitor.id] = points[points.length - 1].ping
  }

  return c.html(
    <Layout
      pageConfig={pageConfig}
      title={pageConfig.title ?? '服务状态'}
      isAdmin={await navIsAdmin(c.req.raw, env)}
    >
      <StatusPage
        pageConfigTitle={pageConfig.title ?? '服务状态'}
        monitors={monitors}
        state={state}
        bootstrap={{
          lastUpdate: meta.lastUpdate,
          overallUp: meta.overallUp,
          overallDown: meta.overallDown,
          monitors: sanitizeMonitors(monitors),
          incident: state.incident,
          startedAt: state.startedAt,
          lastPing,
          maintenances,
        }}
      />
    </Layout>,
    200,
    { 'cache-control': 'private, no-store' }
  )
})

app.get('/m/:id', async (c) => {
  const id = c.req.param('id')
  const monitors = await getEffectiveMonitors(c.env)
  const monitor = monitors.find((item) => item.id === id)
  if (!monitor) {
    return c.html(
      <Layout pageConfig={pageConfig} title="未找到监测项" isAdmin={await navIsAdmin(c.req.raw, c.env)}>
        <div class="detail-wrap">
          <a href="/" class="back">
            ← 返回状态页
          </a>
          <p class="empty">未找到监测项：{id}</p>
        </div>
      </Layout>,
      404
    )
  }

  const { meta, state } = await readState(c.env)
  const bootstrap = JSON.stringify({
    monitor: sanitizeMonitors([monitor])[0],
    incident: state.incident[id] ?? [],
    latency: state.latency[id] ?? [],
    startedAt: state.startedAt?.[id],
    lastUpdate: meta.lastUpdate,
    maintenances,
  }).replace(/</g, '\\u003c')

  return c.html(
    <Layout
      pageConfig={pageConfig}
      title={`${monitor.name} - ${pageConfig.title ?? '服务状态'}`}
      isAdmin={await navIsAdmin(c.req.raw, c.env)}
    >
      <DetailPage monitor={monitor} state={state} bootstrap={bootstrap} />
    </Layout>,
    200,
    { 'cache-control': 'private, no-store' }
  )
})

app.get('/login', async (c) => {
  const hasAdminAccount = await hasAdmin(c.env)
  return c.html(
    <Layout
      pageConfig={pageConfig}
      title={hasAdminAccount ? '管理员登录' : '设置管理员'}
      isAdmin={await navIsAdmin(c.req.raw, c.env)}
    >
      <LoginPage hasAdmin={hasAdminAccount} />
    </Layout>,
    200,
    { 'cache-control': 'private, no-store' }
  )
})

app.get('/manage', async (c) => {
  if (!(await isAdminRequest(c.req.raw, c.env))) {
    return c.redirect('/login')
  }
  const monitors = await getStoredMonitors(c.env, { fresh: true })
  return c.html(
    <Layout pageConfig={pageConfig} title="站点管理" isAdmin>
      <ManagePage monitors={monitors} />
    </Layout>,
    200,
    { 'cache-control': 'private, no-store' }
  )
})

app.notFound((c) => json({ healthy: false, error: 'not found' }, 404))

app.onError((error, c) => {
  console.log('Unhandled error: ' + error)
  return json({ error: 'internal error' }, 500)
})

// --- Durable Object ----------------------------------------------------------------

export class MonitorScheduler extends DurableObject {
  private scheduler: SchedulerState

  constructor(ctx: DurableObjectState, env: Env['Bindings']) {
    super(ctx, env)
    this.scheduler = new SchedulerState(ctx.storage, env, (monitors) => runChecks(env, monitors))
  }

  async ensureAlarm(): Promise<{ nextAlarm: number }> {
    return this.scheduler.ensureAlarm()
  }

  async healIfStale(): Promise<{ healed: boolean }> {
    return this.scheduler.healIfStale()
  }

  async runNow(): Promise<void> {
    return this.scheduler.runNow()
  }

  async alarm(): Promise<void> {
    await this.scheduler.runNow()
  }

  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== '/monitors') {
      return json({ error: 'not found' }, 404)
    }
    try {
      if (request.method === 'GET') {
        return json({ monitors: await this.scheduler.listMonitors() })
      }
      if (request.method === 'POST') {
        return json({ monitors: await this.scheduler.addMonitor(await request.json<MonitorTarget>()) })
      }
      if (request.method === 'PUT') {
        return json({
          monitors: await this.scheduler.updateMonitor(await request.json<MonitorTarget>()),
        })
      }
      if (request.method === 'DELETE') {
        const { id } = await request.json<{ id: string }>()
        return json({ monitors: await this.scheduler.deleteMonitor(id) })
      }
      return json({ error: 'method not allowed' }, 405)
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : 'Scheduler request failed' },
        error instanceof SchedulerError ? error.status : 500
      )
    }
  }
}

// --- scheduled handler ---------------------------------------------------------------

export default {
  fetch: app.fetch,
  async scheduled(
    _controller: ScheduledController,
    env: Env['Bindings'],
    _ctx: ExecutionContext
  ): Promise<void> {
    // Cron is a supervisor only: make sure the DO alarm is armed (and
    // force-re-arm if rounds went stale).
    try {
      const result = await getScheduler(env).healIfStale()
      if (result.healed) console.log('Cron healed the monitor scheduler alarm.')
    } catch (err) {
      console.log('Failed to heal monitor scheduler from cron: ' + err)
    }
  },
} as ExportedHandler<Env['Bindings']>
