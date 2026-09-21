import { getRuntimeValue, setRuntimeValue } from './runtimeConfig'
import type { RuntimeEnv } from './runtimeConfig'

const ADMIN_KEY = 'admin_credentials'
export const SESSION_COOKIE = 'status_admin_session'

type AdminCredentials = {
  username: string
  salt: string
  passwordHash: string
}

type AdminCookie = {
  username: string
  passwordHash: string
}

function bytesToHex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function randomHex(length = 16) {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

async function hashPassword(password: string, salt: string) {
  const data = new TextEncoder().encode(`${salt}:${password}`)
  return bytesToHex(await crypto.subtle.digest('SHA-256', data))
}

function encodeAdminCookie(credentials: AdminCredentials) {
  const value = JSON.stringify({
    username: credentials.username,
    passwordHash: credentials.passwordHash,
  } satisfies AdminCookie)
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte)
  })
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function decodeAdminCookie(token: string): AdminCookie | null {
  try {
    const base64 = token.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }

    const value = JSON.parse(new TextDecoder().decode(bytes)) as AdminCookie
    if (!value.username || !value.passwordHash) return null
    return value
  } catch {
    return null
  }
}

export async function getAdminCredentials(env: RuntimeEnv): Promise<AdminCredentials | null> {
  const value = await getRuntimeValue(env, ADMIN_KEY)
  if (!value) return null

  try {
    const credentials = JSON.parse(value) as AdminCredentials
    if (!credentials.username || !credentials.salt || !credentials.passwordHash) return null
    return credentials
  } catch {
    return null
  }
}

export async function hasAdmin(env: RuntimeEnv) {
  return Boolean(await getAdminCredentials(env))
}

export async function createAdmin(env: RuntimeEnv, username: string, password: string) {
  if (await hasAdmin(env)) throw new Error('管理员已存在')
  if (!username.trim()) throw new Error('请输入账号')
  if (password.length < 8) throw new Error('密码至少 8 位')

  const salt = randomHex()
  const credentials: AdminCredentials = {
    username: username.trim(),
    salt,
    passwordHash: await hashPassword(password, salt),
  }
  await setRuntimeValue(env, ADMIN_KEY, JSON.stringify(credentials))
  return credentials
}

export async function verifyAdmin(env: RuntimeEnv, username: string, password: string) {
  const credentials = await getAdminCredentials(env)
  if (!credentials) return null
  if (credentials.username !== username.trim()) return null
  if (credentials.passwordHash !== (await hashPassword(password, credentials.salt))) return null
  return credentials
}

export async function createSession(env: RuntimeEnv, credentials?: AdminCredentials) {
  const admin = credentials ?? (await getAdminCredentials(env))
  if (!admin) throw new Error('管理员不存在')
  return encodeAdminCookie(admin)
}

export async function validateSession(env: RuntimeEnv, token?: string | null) {
  if (!token) return false
  const cookie = decodeAdminCookie(token)
  if (!cookie) return false

  const credentials = await getAdminCredentials(env)
  return Boolean(
    credentials &&
      credentials.username === cookie.username &&
      credentials.passwordHash === cookie.passwordHash
  )
}

export async function clearSession(env: RuntimeEnv) {
  return
}

export function getCookieValue(cookieHeader: string | undefined, name: string) {
  if (!cookieHeader) return null
  const cookies = cookieHeader.split(';').map((item) => item.trim())
  const prefix = `${name}=`
  const cookie = cookies.find((item) => item.startsWith(prefix))
  return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : null
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined
  const getter = (headers as { get?: (key: string) => string | null }).get
  if (typeof getter === 'function') {
    return getter.call(headers, name) ?? undefined
  }

  const record = headers as Record<string, unknown>
  const value = record[name] ?? record[name.toLowerCase()]
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return name.toLowerCase() === 'cookie' ? value.join('; ') : value.join(', ')
  }
  return undefined
}

function cookieFromStore(cookies: unknown, name: string): string | undefined {
  if (!cookies || typeof cookies !== 'object') return undefined
  const getter = (cookies as { get?: (key: string) => unknown }).get
  if (typeof getter === 'function') {
    const value = getter.call(cookies, name)
    if (typeof value === 'string') return value
    if (value && typeof value === 'object' && 'value' in value) {
      const inner = (value as { value?: unknown }).value
      return typeof inner === 'string' ? inner : undefined
    }
  }

  const direct = (cookies as Record<string, unknown>)[name]
  return typeof direct === 'string' ? direct : undefined
}

export function getRequestCookieHeader(req?: {
  headers?: unknown
  cookies?: unknown
}): string | undefined {
  const fromHeader = headerValue(req?.headers, 'cookie')
  if (fromHeader) return fromHeader

  const value = cookieFromStore(req?.cookies, SESSION_COOKIE)
  return value ? `${SESSION_COOKIE}=${encodeURIComponent(value)}` : undefined
}

export function isHttpsRequest(req?: { headers?: unknown; url?: string }): boolean {
  const forwarded = headerValue(req?.headers, 'x-forwarded-proto')
  if (forwarded) return forwarded.split(',')[0].trim() === 'https'
  try {
    if (req?.url) return new URL(req.url).protocol === 'https:'
  } catch {
    return false
  }
  return false
}

export async function isAdminRequest(env: RuntimeEnv, cookieHeader?: string) {
  return validateSession(env, getCookieValue(cookieHeader, SESSION_COOKIE))
}

export function sessionCookie(token: string, secure = true) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=2592000',
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

export function expiredSessionCookie(secure = true) {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0']
  if (secure) parts.push('Secure')
  return parts.join('; ')
}
