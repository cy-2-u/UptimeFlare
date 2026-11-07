import { bytesToHex, hexToBytes, readValue, setRuntimeValue } from './state'
import type { RuntimeEnv } from './types'

const ADMIN_KEY = 'admin_credentials'
export const SESSION_COOKIE = 'status_admin_session'
const SESSION_TTL_SEC = 30 * 24 * 60 * 60

type AdminCredentials = { username: string; salt: string; passwordHash: string }

// The session token is an HMAC-signed payload with an expiry. The stored
// password hash doubles as the signing secret, so changing the password
// invalidates every existing session immediately.
type SessionPayload = { u: string; ph: string; exp: number }

const randomHex = (length = 16) =>
  bytesToHex(crypto.getRandomValues(new Uint8Array(length)))

async function hashPassword(password: string, salt: string) {
  const data = new TextEncoder().encode(`${salt}:${password}`)
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', data)))
}

async function hmac(secret: string, message: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  return bytesToHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))))
}

// Constant-time signature verification via WebCrypto (never a string compare).
async function hmacValid(secret: string, message: string, signatureHex: string) {
  const signature = hexToBytes(signatureHex)
  if (signature.length !== 32) return false
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  )
  return crypto.subtle.verify('HMAC', key, signature, new TextEncoder().encode(message))
}

const b64urlEncode = (value: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(value)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

function b64urlDecode(token: string): string | null {
  try {
    const base64 = token.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
    const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    return null
  }
}

export async function getAdminCredentials(env: RuntimeEnv): Promise<AdminCredentials | null> {
  const value = await readValue(env, ADMIN_KEY)
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
  return `${payloadStr}.${await hmac(admin.passwordHash, payloadStr)}`
}

export async function validateSession(env: RuntimeEnv, token?: string | null) {
  if (!token) return false
  const dotIndex = token.lastIndexOf('.')
  if (dotIndex <= 0) return false
  const payloadStr = token.slice(0, dotIndex)
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

  return hmacValid(credentials.passwordHash, payloadStr, token.slice(dotIndex + 1))
}

export function getCookieValue(cookieHeader: string | undefined, name: string) {
  const prefix = `${name}=`
  const cookie = cookieHeader
    ?.split(';')
    .map((item) => item.trim())
    .find((item) => item.startsWith(prefix))
  if (!cookie) return null
  try {
    return decodeURIComponent(cookie.slice(prefix.length))
  } catch {
    // A truncated/corrupted cookie value must read as "no session", not 500
    // every page render for that visitor.
    return null
  }
}

export function hasSessionCookie(request: Request): boolean {
  return Boolean(getCookieValue(request.headers.get('cookie') ?? undefined, SESSION_COOKIE))
}

export async function isAdminRequest(request: Request, env: RuntimeEnv) {
  return validateSession(env, getCookieValue(request.headers.get('cookie') ?? undefined, SESSION_COOKIE))
}

function cookie(parts: string[], secure: boolean) {
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

export function sessionCookie(token: string, secure = true) {
  return cookie(
    [
      `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${SESSION_TTL_SEC}`,
    ],
    secure
  )
}

export function expiredSessionCookie(secure = true) {
  return cookie([`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'], secure)
}

export function isHttpsRequest(request: Request): boolean {
  const forwarded = request.headers.get('x-forwarded-proto')
  if (forwarded) return forwarded.split(',')[0].trim() === 'https'
  try {
    return new URL(request.url).protocol === 'https:'
  } catch {
    return false
  }
}
