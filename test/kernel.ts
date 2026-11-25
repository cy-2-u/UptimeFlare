import { DatabaseSync } from 'node:sqlite'
import type { Runtime, Storage } from '../src/types'

export class Kernel implements Storage {
  readonly db = new DatabaseSync(':memory:')
  writes = 0
  failWrite = false
  alarm: number | null = null
  private depth = 0
  // Holds one key's reads until released: turns the async settings load into a
  // controllable race for constructor-serialization tests.
  holdKey?: string
  holdGate?: Promise<void>
  constructor() { this.db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)') }
  hold(key: string) {
    let release!: () => void
    this.holdKey = key
    this.holdGate = new Promise(resolve => { release = resolve })
    return release
  }
  async get<T>(key: string): Promise<T | undefined> {
    if (this.holdKey === key && this.holdGate) await this.holdGate
    const row = this.db.prepare('SELECT value FROM kv WHERE key=?').get(key) as { value: string } | undefined
    return row ? JSON.parse(row.value) : undefined
  }
  async put(entries: Record<string, unknown>) {
    const write = () => {
      let count = 0
      for (const [key, value] of Object.entries(entries)) {
        this.db.prepare('INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value))
        if (this.failWrite && ++count === 1) throw Error('injected write failure')
      }
    }
    if (this.depth) write()
    else {
      this.db.exec('BEGIN')
      try { write(); this.db.exec('COMMIT') }
      catch (error) { this.db.exec('ROLLBACK'); throw error }
    }
    this.writes += Object.keys(entries).length
  }
  async delete(key: string) {
    this.db.prepare('DELETE FROM kv WHERE key=?').run(key)
    if (this.failWrite) throw Error('injected delete failure')
    this.writes++
  }
  async transaction<T>(fn: (txn: Storage) => Promise<T>): Promise<T> {
    if (this.depth) return fn(this)
    this.db.exec('BEGIN')
    this.depth++
    try { const result = await fn(this); this.db.exec('COMMIT'); return result }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
    finally { this.depth-- }
  }
  async getAlarm() { return this.alarm }
  async setAlarm(time: number) { this.alarm = time }
  close() { this.db.close() }
}
export class Network implements Runtime {
  time = 1700000000000
  requests: string[] = []
  statuses: number[] = []
  failure?: Error
  active = 0
  maxActive = 0
  gate?: Promise<void>
  // Notifications ride the configured webhook host; tests swap the webhook via
  // settings, so the filter tracks any URL that is not a probe target.
  webhook = 'timelynotify'
  now = () => this.time
  sleep = async (ms: number) => { this.time += ms }
  fetch: typeof fetch = async (input, _init) => {
    const url = String(input)
    this.requests.push(url)
    this.active++
    this.maxActive = Math.max(this.maxActive, this.active)
    try {
      if (this.gate && !url.includes(this.webhook)) await this.gate
      if (this.failure && !url.includes(this.webhook)) throw this.failure
      this.time += 25
      return new Response('ok', { status: url.includes(this.webhook) ? 200 : this.statuses.shift() ?? 200 })
    } finally { this.active-- }
  }
  advance(seconds = 600) { this.time += seconds * 1000 }
  get checks() { return this.requests.filter(url => !url.includes(this.webhook)) }
  get notices() { return this.requests.filter(url => url.includes(this.webhook)) }
}
