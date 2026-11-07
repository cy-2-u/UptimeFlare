import { Hono } from 'hono'
import { DurableObject } from 'cloudflare:workers'
import type { IncidentRecord, LatencyRecord, MonitorTarget } from './types'
import { maintenances, pageConfig } from './config'
import {
  emptyMeta,
  incidentsToRecords,
  lastLatencyPoint,
  latencyKey,
  parseIncidentRow,
  parseLatencyRow,
  readLatencySnapshot,
  readStateSnapshot,
  readValue,
  decodeLatency,
  type MetaRow,
  type LatencyRow,
} from './state'
import {
  clearMonitorsCache,
  getStoredMonitors,
  mergeMonitorUpdate,
  parseNewMonitor,
  schedulerMonitors,
  SchedulerError,
} from './monitors'
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

const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback

function getScheduler(env: Env['Bindings']) {
  const namespace = env.MONITOR_SCHEDULER_DO
  if (!namespace) throw new Error('MONITOR_SCHEDULER_DO binding is missing')
  return namespace.get(namespace.idFromName('default'))
}

type PageState = {
  incident: Record<string, IncidentRecord[]>
  latency: Record<string, LatencyRecord[]>
  lastStatus: Record<string, 'up' | 'down' | null>
  lastPing: Record<string, number>
  startedAt?: Record<string, number>
}

type ReadStateOptions = {
  // 'last' skips the full 12h decode and only extracts the latest ping
  // (homepage cards); the default 'full' decodes arrays for the sparkline
  // and /api/status consumers.
  latency?: 'full' | 'last'
  // Restrict row parsing to one monitor (detail page ignores the rest).
  onlyId?: string
}

// Read meta + decoded per-monitor state for page rendering. The
// columnar->record conversion happens here, once, server-side.
async function readState(
  env: Env['Bindings'],
  opts: ReadStateOptions = {}
): Promise<{ meta: MetaRow; state: PageState }> {
  const snapshot = await readStateSnapshot(env)

  let meta: MetaRow = emptyMeta()
  if (snapshot.meta.value !== null) {
    try {
      meta = JSON.parse(snapshot.meta.value) as MetaRow
    } catch {
      meta = emptyMeta()
    }
  }

  const incident: Record<string, IncidentRecord[]> = {}
  for (const [id, row] of snapshot.inc) {
    if (opts.onlyId && id !== opts.onlyId) continue
    try {
      const parsed = parseIncidentRow(row)
      // A corrupt row must not take the whole page down; skip and log.
      if (parsed && parsed.start.length > 0) incident[id] = incidentsToRecords(parsed)
    } catch (err) {
      console.log(`Skipping unreadable incident row for ${id}: ` + err)
    }
  }

  const latency: Record<string, LatencyRecord[]> = {}
  const lastStatus: Record<string, 'up' | 'down' | null> = {}
  const lastPing: Record<string, number> = {}
  const startedAt: Record<string, number> = {}
  for (const [id, row] of snapshot.lat) {
    if (opts.onlyId && id !== opts.onlyId) continue
    try {
      const parsed = parseLatencyRow(row)
      if (!parsed || parsed.time === '') continue
      lastStatus[id] = parsed.lastStatus
      if (parsed.startedAt > 0) startedAt[id] = parsed.startedAt
      const last = lastLatencyPoint(parsed)
      if (last) lastPing[id] = last.ping
      if (opts.latency !== 'last') latency[id] = decodeLatency(parsed)
    } catch (err) {
      console.log(`Skipping unreadable latency row for ${id}: ` + err)
    }
  }

  return { meta, state: { incident, latency, lastStatus, lastPing, startedAt } }
}

function sanitizeMonitors(monitors: MonitorTarget[]) {
  return monitors.map((monitor) => ({
    id: monitor.id,
    name: monitor.name,
    target: monitor.target,
    ...(monitor.tooltip ? { tooltip: monitor.tooltip } : {}),
    ...(monitor.statusPageLink ? { statusPageLink: monitor.statusPageLink } : {}),
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
    monitorCount = (await getStoredMonitors(env)).length
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
    const parsed = row.value === null ? null : (JSON.parse(row.value) as LatencyRow)
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
  for (const monitor of await getStoredMonitors(env)) {
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
    const row = raw === null ? null : (JSON.parse(raw) as LatencyRow)
    const isUp = row?.lastStatus === null || row === null ? null : row.lastStatus === 'up'

    if (isUp === null) return badge('unknown', 'lightgrey')
    if (isUp) {
      const last = row ? lastLatencyPoint(row) : null
      return badge(last?.ping ? `${last.ping} ms` : 'Up', BADGE_UP)
    }
    return badge('Down', BADGE_DOWN)
  } catch (error) {
    console.log('Badge failed: ' + error)
    return badge('error', 'lightgrey', true)
  }
})

const BADGE_UP = '#4c1'
const BADGE_DOWN = '#e05d44'

app.get('/api/status', async (c) => {
  // Same-origin defense: browsers always send Origin/Referer on cross-site
  // fetches; direct navigations and server clients are unaffected. This is a
  // personal project — this is spam protection, not hardening.
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
  return json({ monitors: sanitizeMonitors(stored), stored })
})

app.post('/api/monitors', async (c) => {
  if (!(await isAdminRequest(c.req.raw, c.env))) return json({ error: '需要管理员登录' }, 401)
  try {
    const monitor = parseNewMonitor(await c.req.json())
    const authoritative = await schedulerMonitors(c.env, 'add', monitor)
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
    const authoritative = await schedulerMonitors(c.env, 'update', updated)
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
    const nextMonitors = await schedulerMonitors(c.env, 'delete', { id })
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
  const monitors = await getStoredMonitors(env)
  // 'last' skips the full 12h decode: cards only show the latest ping, the
  // sparkline arrays stay a detail-page concern.
  const { meta, state } = await readState(env, { latency: 'last' })

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
          lastPing: state.lastPing,
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
  const monitors = await getStoredMonitors(c.env)
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

  // Decode only this monitor's rows; the others' 12h arrays are irrelevant.
  const { meta, state } = await readState(c.env, { onlyId: id })
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
    <Layout pageConfig={pageConfig} title="站点管理" isAdmin page="manage">
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

  // Typed RPC surface (v4): the Worker calls stub.listMonitors() etc.
  // directly — no fetch routing, no JSON envelope, no manual error mapping.
  async listMonitors(): Promise<MonitorTarget[]> {
    return this.scheduler.listMonitors()
  }

  async addMonitor(monitor: MonitorTarget): Promise<MonitorTarget[]> {
    return this.scheduler.addMonitor(monitor)
  }

  async updateMonitor(monitor: MonitorTarget): Promise<MonitorTarget[]> {
    return this.scheduler.updateMonitor(monitor)
  }

  async deleteMonitor(id: string): Promise<MonitorTarget[]> {
    return this.scheduler.deleteMonitor(id)
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
