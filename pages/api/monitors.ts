import { NextRequest } from 'next/server'
import { MonitorTarget } from '@/types/config'
import { CompactedMonitorStateWrapper, getFromStore, setToStore } from '@/worker/src/store'
import { getStoredMonitors, setStoredMonitors } from '@/util/runtimeConfig'
import type { RuntimeEnv } from '@/util/runtimeConfig'
import { isAdminRequest } from '@/util/auth'
import { workerConfig } from '@/uptime.config'

export const runtime = 'edge'

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers })
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/https?:\/\//, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

async function purgeMonitorState(env: RuntimeEnv, monitorId: string): Promise<void> {
  const db = env.UPTIMEFLARE_D1
  if (!db) return

  const raw = await getFromStore(env, 'state')
  if (!raw) return

  const compacted = new CompactedMonitorStateWrapper(raw)
  const hadIncident = Object.prototype.hasOwnProperty.call(compacted.data.incident, monitorId)
  const hadLatency = Object.prototype.hasOwnProperty.call(compacted.data.latency, monitorId)
  if (!hadIncident && !hadLatency) return

  delete compacted.data.incident[monitorId]
  delete compacted.data.latency[monitorId]
  await setToStore(env, 'state', compacted.getCompactedStateStr())
}

function parseMonitor(input: unknown): MonitorTarget {
  const data = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const name = String(data.name ?? '').trim()
  const target = String(data.target ?? '').trim()
  const group = String(data.group ?? '核心服务').trim() || '核心服务'
  const preview = String(data.preview ?? '').trim()
  const timeout = Number(data.timeout ?? 4500)

  if (!name) throw new Error('请输入网站名称')
  if (name.length > 80) throw new Error('网站名称最多 80 个字符')
  if (!target) throw new Error('请输入网站地址')
  if (!Number.isFinite(timeout) || timeout < 1000 || timeout > 60000) {
    throw new Error('超时时间需要在 1 到 60 秒之间')
  }

  let url: URL
  try {
    url = new URL(target)
  } catch {
    throw new Error('网站地址格式无效')
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('网站地址需要使用 http 或 https')
  }

  if (preview) {
    try {
      const previewUrl = new URL(preview)
      if (!['http:', 'https:'].includes(previewUrl.protocol)) throw new Error('invalid preview')
    } catch {
      throw new Error('封面图地址格式无效')
    }
  }

  const id = slugify(String(data.id ?? '') || `${url.hostname}-${name}`)
  if (!id) throw new Error('无法生成监测 ID')

  return {
    id,
    name,
    method: 'GET',
    target: url.toString(),
    statusPageLink: url.toString(),
    preview: preview || undefined,
    group,
    expectedCodes: [200],
    timeout,
    hideLatencyChart: false,
  }
}

export default async function handler(req: NextRequest): Promise<Response> {
  const env = process.env as unknown as RuntimeEnv

  if (req.method === 'OPTIONS') return new Response(null, { headers })

  const isAdmin = await isAdminRequest(env, req.headers.get('cookie') ?? undefined)
  if (!isAdmin) return json({ error: '需要管理员登录' }, 401)

  if (req.method === 'GET') {
    const stored = await getStoredMonitors(env)
    return json({ monitors: workerConfig.monitors.concat(stored), stored })
  }

  if (req.method === 'POST') {
    try {
      const monitor = parseMonitor(await req.json())
      const configuredIds = new Set(workerConfig.monitors.map((monitor) => monitor.id))
      const storedMonitors = await getStoredMonitors(env)
      const existingIds = new Set(storedMonitors.map((monitor) => monitor.id))

      if (configuredIds.has(monitor.id) || existingIds.has(monitor.id)) {
        return json({ error: '监测 ID 已存在，请换一个名称或 ID' }, 409)
      }

      const nextMonitors = [...storedMonitors, monitor]
      await setStoredMonitors(env, nextMonitors)

      return json({ monitor, stored: nextMonitors }, 201)
    } catch (error: unknown) {
      return json({ error: getErrorMessage(error, '添加失败') }, 400)
    }
  }

  if (req.method === 'DELETE') {
    try {
      const body = await req.json()
      const data = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
      const id = String(data.id ?? '').trim()
      if (!id) return json({ error: '缺少监测 ID' }, 400)

      const storedMonitors = await getStoredMonitors(env)
      const nextMonitors = storedMonitors.filter((monitor) => monitor.id !== id)

      if (nextMonitors.length === storedMonitors.length) {
        return json({ error: '只能删除在页面中添加的监测项' }, 404)
      }

      await setStoredMonitors(env, nextMonitors)
      await purgeMonitorState(env, id)
      return json({ stored: nextMonitors })
    } catch (error: unknown) {
      return json({ error: getErrorMessage(error, '删除失败') }, 400)
    }
  }

  return json({ error: 'Method not allowed' }, 405)
}
