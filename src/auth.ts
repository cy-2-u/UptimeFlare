import type { Credentials } from './types'

const encoder = new TextEncoder()
export const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
const unhex = (value: string) => Uint8Array.from(value.match(/../g) ?? [], v => parseInt(v, 16))
export const random = () => hex(crypto.getRandomValues(new Uint8Array(24)))
// Constant-time string comparison for credential equality.
export const safeEqual = (a: string, b: string) => {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
export async function passwordHash(password: string, salt: string, algorithm?: string) {
  if (algorithm !== 'pbkdf2') return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(`${salt}:${password}`))))
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'])
  return hex(new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: encoder.encode(salt), iterations: 100000 }, key, 256)))
}
export async function sign(secret: string, message: string) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message))))
}
export async function token(credentials: Credentials, now: number) {
  const payload = `${Math.floor(now / 1000) + 2592000}.${random()}`
  return `${payload}.${await sign(credentials.sessionKey, payload)}`
}
export async function authenticated(credentials: Credentials | undefined, cookie: string, now: number) {
  const value = cookie.split(';').map(v => v.trim()).find(v => v.startsWith('status_admin_session='))?.slice(21)
  if (!value || !credentials) return false
  const parts = value.split('.')
  if (parts.length !== 3 || !/^\d+$/.test(parts[0]) || Number(parts[0]) <= now / 1000 || !/^[a-f0-9]{48}$/.test(parts[1]) || !/^[a-f0-9]{64}$/.test(parts[2])) return false
  const key = await crypto.subtle.importKey('raw', encoder.encode(credentials.sessionKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
  return crypto.subtle.verify('HMAC', key, unhex(parts[2]), encoder.encode(`${parts[0]}.${parts[1]}`))
}
export function sessionCookie(value: string, secure: boolean) {
  return `status_admin_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${value ? 2592000 : 0}${secure ? '; Secure' : ''}`
}
