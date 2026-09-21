import { NextRequest } from 'next/server'
import {
  clearSession,
  createAdmin,
  createSession,
  expiredSessionCookie,
  getRequestCookieHeader,
  hasAdmin,
  isAdminRequest,
  isHttpsRequest,
  sessionCookie,
  verifyAdmin,
} from '@/util/auth'
import type { RuntimeEnv } from '@/util/runtimeConfig'

export const runtime = 'edge'

const headers = {
  'Content-Type': 'application/json',
  'Cache-Control': 'private, no-store',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

function json(data: unknown, status = 200, extraHeaders?: Record<string, string>) {
  return new Response(JSON.stringify(data), { status, headers: { ...headers, ...extraHeaders } })
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

function readBody(input: unknown) {
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
}

export default async function handler(req: NextRequest): Promise<Response> {
  const env = process.env as unknown as RuntimeEnv
  if (req.method === 'OPTIONS') return new Response(null, { headers })

  if (req.method === 'GET') {
    return json({
      hasAdmin: await hasAdmin(env),
      isAuthenticated: await isAdminRequest(env, getRequestCookieHeader(req)),
    })
  }

  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    const body = readBody(await req.json())
    const action = String(body.action ?? '')
    const username = String(body.username ?? '')
    const password = String(body.password ?? '')

    const secure = isHttpsRequest(req)

    if (action === 'setup') {
      const credentials = await createAdmin(env, username, password)
      const token = await createSession(env, credentials)
      return json({ ok: true, isAuthenticated: true, hasAdmin: true }, 201, {
        'Set-Cookie': sessionCookie(token, secure),
      })
    }

    if (action === 'login') {
      const credentials = await verifyAdmin(env, username, password)
      if (!credentials) return json({ error: '账号或密码错误' }, 401)
      const token = await createSession(env, credentials)
      return json({ ok: true, isAuthenticated: true, hasAdmin: true }, 200, {
        'Set-Cookie': sessionCookie(token, secure),
      })
    }

    if (action === 'logout') {
      await clearSession(env)
      return json({ ok: true, isAuthenticated: false }, 200, {
        'Set-Cookie': expiredSessionCookie(secure),
      })
    }

    return json({ error: '未知操作' }, 400)
  } catch (error: unknown) {
    return json({ error: getErrorMessage(error, '操作失败') }, 400)
  }
}
