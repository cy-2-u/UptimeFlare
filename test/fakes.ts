import type { MonitorTarget } from '../src/types'

// ---------------------------------------------------------------------------
// Minimal in-memory fakes for the D1 row store and Durable Object storage.
// The D1 fake reproduces the exact SQL shapes used by src/store.ts, including
// atomic batch semantics and compare-and-set behaviour.
// ---------------------------------------------------------------------------

const LIKE_PREFIX_RE = /LIKE '([^']+)'/g
const INSERT_RE = /^INSERT INTO uptimeflare \(key, value\) VALUES \(\?, \?\)/
const UPDATE_RE = /^UPDATE uptimeflare SET value = \? WHERE key = \? AND value = \?$/

type FakeStatement = {
  apply: (db: FakeD1) => (() => void) | null
}

export class FakeD1 {
  rows = new Map<string, string>()
  failReads = false
  failWrites = false
  writes = 0

  prepare(sql: string) {
    const upsertMatch = /^INSERT INTO uptimeflare \(key, value\) VALUES \(\?, \?\) ON CONFLICT\(key\) DO UPDATE/.test(
      sql
    )
    const deleteOneMatch = /^DELETE FROM uptimeflare WHERE key = \?$/.test(sql)

    if (upsertMatch) {
      // INSERT ... ON CONFLICT DO UPDATE (upsert): applied immediately via run().
      return {
        bind: (...args: unknown[]) => ({
          first: async () => null,
          all: async () => ({ results: [] }),
          run: async () => {
            if (this.failWrites) throw new Error('write unavailable')
            this.rows.set(String(args[0]), String(args[1]))
            this.writes += 1
            return { meta: { changes: 1 } }
          },
        }),
      }
    }

    if (INSERT_RE.test(sql) || UPDATE_RE.test(sql) || deleteOneMatch) {
      return {
        bind: (...args: unknown[]) => ({
          _fake: {
            apply: (db: FakeD1): (() => void) | null => {
              if (db.failWrites) return null
              if (deleteOneMatch) {
                const key = String(args[0])
                return () => {
                  db.rows.delete(key)
                }
              }
              if (INSERT_RE.test(sql)) {
                const key = String(args[0])
                const value = String(args[1])
                return () => {
                  if (!db.rows.has(key)) {
                    db.rows.set(key, value)
                    db.writes += 1
                  }
                }
              }
              const next = String(args[0])
              const key = String(args[1])
              const expected = String(args[2])
              return () => {
                if (db.rows.get(key) === expected) {
                  db.rows.set(key, next)
                  db.writes += 1
                }
              }
            },
          } satisfies FakeStatement,
        }),
      }
    }

    return {
      bind: (...args: unknown[]) => ({
        first: async () => {
          this.assertRead()
          const key = String(args[0])
          return this.rows.has(key) ? { value: this.rows.get(key) } : null
        },
        all: async () => {
          this.assertRead()
          const keys = this.matchKeys(sql, args)
          return { results: keys.map((key) => ({ key, value: this.rows.get(key)! })) }
        },
        run: async () => {
          if (this.failWrites) throw new Error('write unavailable')
          let removed = 0
          for (const key of this.matchKeys(sql, args)) {
            if (this.rows.delete(key)) removed += 1
          }
          return { meta: { changes: removed } }
        },
      }),
    }
  }

  async batch(statements: unknown[]): Promise<void> {
    const planned: Array<() => void> = []
    for (const statement of statements) {
      const fake = (statement as { _fake?: FakeStatement })._fake
      if (!fake) throw new Error('Unknown statement passed to FakeD1.batch')
      const closure = fake.apply(this)
      if (closure === null) throw new Error('write unavailable')
      planned.push(closure)
    }
    planned.forEach((apply) => apply())
  }

  // CREATE TABLE IF NOT EXISTS ... (a no-op in the in-memory fake)
  async exec(sql: string): Promise<void> {
    if (!/^CREATE TABLE IF NOT EXISTS/.test(sql.trim())) {
      throw new Error('FakeD1.exec only supports CREATE TABLE IF NOT EXISTS')
    }
  }

  private assertRead() {
    if (this.failReads) throw new Error('read unavailable')
  }

  private matchKeys(sql: string, args: unknown[]): string[] {
    const matched = new Set<string>()

    if (/WHERE key IN \(\?(?:, \?)*\)/.test(sql)) {
      for (const arg of args) {
        const key = String(arg)
        if (this.rows.has(key)) matched.add(key)
      }
      return [...matched]
    }

    const patterns = [...sql.matchAll(LIKE_PREFIX_RE)].map((match) => match[1].replace(/%/g, ''))
    const eqKey = sql.includes('key = ?') ? String(args[0]) : null

    for (const key of this.rows.keys()) {
      if (eqKey !== null && key === eqKey) {
        matched.add(key)
        continue
      }
      if (patterns.some((prefix) => key.startsWith(prefix))) {
        matched.add(key)
      }
    }
    return [...matched]
  }
}

export function makeFakeD1() {
  return new FakeD1() as unknown as D1Database & FakeD1
}

export function makeMonitor(partial: Partial<MonitorTarget> = {}): MonitorTarget {
  return {
    id: 'example-com',
    name: 'Example',
    target: 'https://example.com',
    timeout: 4500,
    ...partial,
  }
}

export class FakeStorage {
  records = new Map<string, unknown>()
  currentAlarm: number | null = null

  async get<T>(key: string, options?: DurableObjectGetOptions): Promise<T | undefined>
  async get<T>(keys: string[], options?: DurableObjectGetOptions): Promise<Map<string, T>>
  async get<T>(
    keyOrKeys: string | string[],
    _options?: DurableObjectGetOptions
  ): Promise<T | undefined | Map<string, T>> {
    if (Array.isArray(keyOrKeys)) {
      const out = new Map<string, T>()
      for (const key of keyOrKeys) {
        const value = this.records.get(key)
        if (value !== undefined) out.set(key, structuredClone(value) as T)
      }
      return out
    }
    const value = this.records.get(keyOrKeys)
    return value === undefined ? undefined : (structuredClone(value) as T)
  }

  async put<T>(key: string, value: T, options?: DurableObjectPutOptions): Promise<void>
  async put<T>(entries: Record<string, T>, options?: DurableObjectPutOptions): Promise<void>
  async put<T>(
    keyOrEntries: string | Record<string, T>,
    value?: unknown,
    _options?: DurableObjectPutOptions
  ): Promise<void> {
    if (typeof keyOrEntries === 'string') {
      this.records.set(keyOrEntries, structuredClone(value))
      return
    }
    for (const [key, entry] of Object.entries(keyOrEntries)) {
      this.records.set(key, structuredClone(entry))
    }
  }

  async delete(key: string, options?: DurableObjectPutOptions): Promise<boolean>
  async delete(keys: string[], options?: DurableObjectPutOptions): Promise<number>
  async delete(
    keyOrKeys: string | string[],
    _options?: DurableObjectPutOptions
  ): Promise<boolean | number> {
    if (Array.isArray(keyOrKeys)) {
      let removed = 0
      for (const key of keyOrKeys) {
        if (this.records.delete(key)) removed += 1
      }
      return removed
    }
    return this.records.delete(keyOrKeys)
  }

  async getAlarm(): Promise<number | null> {
    return this.currentAlarm
  }

  async setAlarm(value: number): Promise<void> {
    this.currentAlarm = value
  }

  async transaction<T>(fn: (txn: DurableObjectTransaction) => Promise<T>): Promise<T> {
    return fn(this as unknown as DurableObjectTransaction)
  }
}
