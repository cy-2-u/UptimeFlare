export type Monitor = {
  id: string
  name: string
  target: string
  group: string
  timeout: number
  intervalMinutes: number
  preview?: string
  statusPageLink?: string
  tooltip?: string
}
export type Incident = { start: number[]; end: number | null; error: string[] }
export type Point = { time: number; ping: number; loc: string }
export type State = {
  startedAt: number
  checkedAt: number
  up: boolean | null
  error: string
  notified: boolean
  incidents: Incident[]
  latency: Point[]
}
export type Notice = { monitor: Monitor; up: boolean; first: boolean; start: number; time: number; reason: string }
export type Credentials = { username: string; salt: string; passwordHash: string; sessionKey: string; algorithm?: 'pbkdf2' }
export type Maintenance = {
  monitors?: string[]
  title?: string
  body: string
  start: number | string
  end?: number | string
  color?: string
}
export type Settings = {
  title: string
  links: { link: string; label: string }[]
  maintenances: Maintenance[]
  notification: { timeZone: string; gracePeriod: number; skipNotificationIds: string[]; skipErrorChangeNotification: boolean }
}
export interface Storage {
  get<T>(key: string): Promise<T | undefined>
  put(entries: Record<string, unknown>): Promise<void>
  delete(key: string): Promise<unknown>
  getAlarm(): Promise<number | null>
  setAlarm(time: number): Promise<void>
  transaction<T>(fn: (txn: Storage) => Promise<T>): Promise<T>
}
export interface Runtime {
  now(): number
  fetch: typeof fetch
  sleep(ms: number): Promise<void>
}
export class HttpError extends Error {
  constructor(message: string, public status = 400) { super(message) }
}
export const stateKey = (id: string) => `monitor:${id}`
export const freshState = (): State => ({ startedAt: 0, checkedAt: 0, up: null, error: '', notified: false, incidents: [], latency: [] })
