import { HttpError, type Monitor, type Notice, type Runtime, type Settings, type State } from './types'

const DAY = 86400
const text = (value: unknown) => String(value ?? '').trim()
function url(value: unknown, optional = false): string | undefined {
  const input = text(value)
  if (!input && optional) return undefined
  try {
    const parsed = new URL(input)
    if (!['http:', 'https:'].includes(parsed.protocol)) throw Error()
    return parsed.href
  } catch { throw new HttpError('请输入有效的 HTTP 或 HTTPS 地址') }
}
export function parseMonitor(input: Record<string, unknown>, previous?: Monitor): Monitor {
  const data = { ...previous, ...input }
  const name = text(data.name)
  if (!name || name.length > 80) throw new HttpError('网站名称需要 1 到 80 个字符')
  const target = url(data.target)!
  const timeout = Number(data.timeout ?? 3000)
  const intervalMinutes = Number(data.intervalMinutes ?? 10)
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 60000) throw new HttpError('超时需要在 1 到 60 秒之间')
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 10 || intervalMinutes > 1440 || intervalMinutes % 10) throw new HttpError('间隔需要是 10 的倍数（10–1440 分钟）')
  const id = previous?.id ?? (text(data.id) || crypto.randomUUID())
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new HttpError('监测 ID 格式无效')
  return { id, name, target, timeout, intervalMinutes, group: text(data.group) || '核心服务', preview: url(data.preview, true), statusPageLink: url(data.statusPageLink, true), tooltip: text(data.tooltip) || undefined }
}

export class ProbeBudget extends Error {}
export async function check(monitor: Monitor, runtime: Runtime, loc: string) {
  let result = { up: false, ping: 0, error: '' }
  for (let attempt = 0; attempt < 2; attempt++) {
    const start = runtime.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), monitor.timeout)
    try {
      let target = monitor.target
      let response: Response
      for (let hop = 0; ; hop++) {
        response = await runtime.fetch(target, {
          headers: { 'user-agent': 'UptimeFlare/5' }, signal: controller.signal, redirect: 'manual',
          cf: { cacheTtl: 0 },
        })
        if (![301, 302, 303, 307, 308].includes(response.status) || !response.headers.has('location')) break
        const next = new URL(response.headers.get('location')!, target)
        await response.body?.cancel()
        if (hop >= 5 || !['http:', 'https:'].includes(next.protocol)) throw Error('重定向无效或过多')
        target = next.href
      }
      result = { up: response.ok, ping: Math.max(0, runtime.now() - start), error: response.ok ? '' : `HTTP ${response.status}` }
      await response.body?.cancel().catch(() => undefined)
    } catch (error) {
      if (error instanceof ProbeBudget) throw error
      result = { up: false, ping: Math.max(0, runtime.now() - start), error: controller.signal.aborted ? `超时（${monitor.timeout}ms 无响应）` : String(error).slice(0, 300) }
    } finally { clearTimeout(timer) }
    if (result.up || attempt === 1) break
    await runtime.sleep(3000)
  }
  return { ...result, time: Math.floor(runtime.now() / 1000), loc }
}

export function transition(monitor: Monitor, original: State, result: Awaited<ReturnType<typeof check>>, config: Settings): { state: State; notices: Notice[] } {
  const state = structuredClone(original)
  const notices: Notice[] = []
  const last = state.incidents.at(-1)
  const wasDown = state.up === false
  const changedError = wasDown && state.error !== result.error
  state.startedAt ||= result.time
  state.checkedAt = result.time
  state.latency = state.latency.filter(p => p.time >= result.time - 43200)
  state.latency.push({ time: result.time, ping: result.ping, loc: result.loc })
  state.incidents = state.incidents.filter(i => i.end === null || i.end >= result.time - 90 * DAY)
  const notice = (up: boolean, first: boolean, start: number, reason: string) => notices.push({ monitor, up, first, start, time: result.time, reason })
  if (result.up) {
    if (last?.end === null) {
      last.end = result.time
      if (state.notified) notice(true, false, last.start[0], 'OK')
    }
    state.notified = false
  } else {
    if (!wasDown || !last || last.end !== null) {
      state.incidents.push({ start: [result.time], end: null, error: [result.error] })
      state.notified = false
    } else if (changedError) {
      last.start.push(result.time)
      last.error.push(result.error)
    }
    const open = state.incidents.at(-1)!
    if (!state.notified && result.time - open.start[0] >= config.notification.gracePeriod * 60) {
      notice(false, true, open.start[0], result.error)
      state.notified = true
    } else if (state.notified && changedError && !config.notification.skipErrorChangeNotification) {
      notice(false, false, open.start[0], result.error)
    }
  }
  state.up = result.up
  state.error = result.error
  return { state, notices }
}

export function activeMaintenance(config: Settings, id: string, time: number) {
  return config.maintenances.some(m => (m.monitors ?? []).includes(id) && time >= new Date(m.start).getTime() && (m.end === undefined || time <= new Date(m.end).getTime()))
}
