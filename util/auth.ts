import { bytesToHex, hexToBytes } from '../lib/state-format'
import { getRuntimeValue, setRuntimeValue } from './runtimeConfig'
import type { RuntimeEnv } from './runtimeConfig'

const ADMIN_KEY = 'admin_credentials'
export const SESSION_COOKIE = 'status_admin_session'
const SESSION_TTL_SEC = 30 * 24 * 60 * 60

type AdminCredentials = {
  username: string
  salt: string
  passwordHash: string
}

// The session token is an HMAC-signed payload with an expiry. The stored
// password hash doubles as the signing secret, so changing the password
// invalidates every existing session immediately.
type SessionPayload = {
  u: string
  ph: string
  exp: number
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
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', data)))
}

async function hmacKey(secret: string) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  )
}

async function hmacSign(secret: string, message: string) {
  const signature = await crypto.subtle.sign(
    'HMAC',
    await hmacKey(secret),
    new TextEncoder().encode(message)
  )
  return bytesToHex(new Uint8Array(signature))
}

// Constant-time signature verification via WebCrypto (never a string compare).
async function hmacVerify(secret: string, message: string, signatureHex: string) {
  const signature = hexToBytes(signatureHex)
  if (signature.length !== 32) return false
  return crypto.subtle.verify(
    'HMAC',
    await hmacKey(secret),
    signature,
    new TextEncoder().encode(message)
  )
}

function b64urlEncode(value: string) {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte)
  })
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlDecode(token: string): string | null {
  try {
    const base64 = token.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return new TextDecoder().decode(bytes)
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

  const payload: SessionPayload = {
    u: admin.username,
    ph: admin.passwordHash,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SEC,
  }
  const payloadStr = b64urlEncode(JSON.stringify(payload))
  return `${payloadStr}.${await hmacSign(admin.passwordHash, payloadStr)}`
}

export async function validateSession(env: RuntimeEnv, token?: string | null) {
  if (!token) return false
  const dotIndex = token.lastIndexOf('.')
  if (dotIndex <= 0) return false
  const payloadStr = token.slice(0, dotIndex)
  const signature = token.slice(dotIndex + 1)

  const payloadJson = b64urlDecode(payloadStr)
  if (!payloadJson) return false

  let payload: SessionPayload
  try {
    payload = JSON.parse(payloadJson) as SessionPayload
  } catch {
    return false
  }
  if (!payload.u || !payload.ph || typeof payload.exp !== 'number') return false
  if (payload.exp <= Math.floor(Date.now() / 1000)) return false

  const credentials = await getAdminCredentials(env)
  if (!credentials) return false
  if (credentials.username !== payload.u || credentials.passwordHash !== payload.ph) return false

  return hmacVerify(credentials.passwordHash, payloadStr, signature)
}

export async function clearSession(_env: RuntimeEnv) {
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
    `Max-Age=${SESSION_TTL_SEC}`,
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

export function expiredSessionCookie(secure = true) {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0']
  if (secure) parts.push('Secure')
  return parts.join('; ')
}
