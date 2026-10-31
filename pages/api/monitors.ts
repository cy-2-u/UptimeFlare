import type { NextRequest } from 'next/server'
import type { MonitorTarget } from '@/types/config'
import { workerConfig } from '@/uptime.config'
import {
  clearMonitorsCache,
  getStoredMonitors,
  type RuntimeEnv,
} from '@/util/runtimeConfig'
import { getRequestCookieHeader, isAdminRequest } from '@/util/auth'
import { mergeMonitorUpdate, parseNewMonitor } from '@/util/monitorValidate'
import { SchedulerError, schedulerMonitors } from '@/util/schedulerClient'

export const runtime = 'edge'

const headers = {
  'Content-Type': 'application/json',
  'Cache-Control': 'private, no-store',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers })
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

export default async function handler(req: NextRequest): Promise<Response> {
  const env = process.env as unknown as RuntimeEnv

  if (req.method === 'OPTIONS') return new Response(null, { headers })

  const isAdmin = await isAdminRequest(env, getRequestCookieHeader(req))
  if (!isAdmin) return json({ error: '需要管理员登录' }, 401)

  try {
    if (req.method === 'GET') {
      const stored = await getStoredMonitors(env, { fresh: true })
      return json({ monitors: workerConfig.monitors.concat(stored), stored })
    }

    if (req.method === 'POST') {
      const monitor = parseNewMonitor(await req.json())
      const authoritative = await schedulerMonitors(env, 'POST', monitor)
      clearMonitorsCache()
      return json({ monitor, stored: authoritative }, 201)
    }

    if (req.method === 'PUT') {
      const body = (await req.json()) as Record<string, unknown>
      const id = String(body.id ?? '').trim()
      if (!id) return json({ error: '缺少监测 ID' }, 400)

      const stored = await getStoredMonitors(env, { fresh: true })
      const existing = stored.find((item) => item.id === id)
      if (!existing) return json({ error: '只能编辑在页面中添加的监测项' }, 404)

      const updated = mergeMonitorUpdate(existing, body)
      const authoritative = await schedulerMonitors(env, 'PUT', updated)
      clearMonitorsCache()
      return json({ monitor: updated, stored: authoritative })
    }

    if (req.method === 'DELETE') {
      const body = (await req.json()) as Record<string, unknown>
      const id = String(body.id ?? '').trim()
      if (!id) return json({ error: '缺少监测 ID' }, 400)

      const nextMonitors = await schedulerMonitors(env, 'DELETE', { id })
      clearMonitorsCache()
      return json({ stored: nextMonitors })
    }

    return json({ error: 'Method not allowed' }, 405)
  } catch (error: unknown) {
    return json(
      { error: getErrorMessage(error, '操作失败') },
      error instanceof SchedulerError ? error.status : 400
    )
  }
}

export type { MonitorTarget }
