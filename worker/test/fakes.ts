import type { MonitorTarget } from '../../types/config'

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
    const deleteOneMatch = /^DELETE FROM uptimeflare WHERE key = \?$/.test(sql)
    if (INSERT_RE.test(sql) || UPDATE_RE.test(sql) || deleteOneMatch) {
      // Write statement: bind() produces a tagged statement that only
      // FakeD1.batch knows how to apply (atomically).
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
          // SELECT value FROM uptimeflare WHERE key = ?
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
          // DELETE FROM uptimeflare WHERE key IN (?, ...)
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
    // Atomic: evaluate every statement first, apply only if none failed.
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

  private assertRead() {
    if (this.failReads) throw new Error('read unavailable')
  }

  private matchKeys(sql: string, args: unknown[]): string[] {
    const matched = new Set<string>()

    // `WHERE key IN (?, ?...)`
    if (/WHERE key IN \(\?(?:, \?)*\)/.test(sql)) {
      for (const arg of args) {
        const key = String(arg)
        if (this.rows.has(key)) matched.add(key)
      }
      return [...matched]
    }

    // `WHERE key = ?` plus zero or more `OR key LIKE 'prefix%'`
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

export function makeEnv(overrides: Record<string, unknown> = {}) {
  const db = makeFakeD1()
  const env = {
    UPTIMEFLARE_D1: db,
    MONITOR_SCHEDULER_DO: undefined,
    ...overrides,
  }
  return { env: env as Record<string, unknown>, db }
}

export function makeMonitor(partial: Partial<MonitorTarget> = {}): MonitorTarget {
  return {
    id: 'example-com',
    name: 'Example',
    method: 'GET',
    target: 'https://example.com',
    expectedCodes: [200],
    timeout: 4500,
    ...partial,
  }
}

// Installs a fetch recorder. The handler decides how each request responds;
// unknown URLs get a generic 200. Returns the recorded calls.
export function installFetchRecorder(
  handler?: (url: string, init?: RequestInit) => Response | undefined
) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const original = globalThis.fetch
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = (async (
    url: RequestInfo | URL,
    init?: RequestInit
  ) => {
    const urlStr = String(url)
    calls.push({ url: urlStr, init })
    const response = handler?.(urlStr, init)
    if (response) return response
    return new Response('{}', { status: 200 })
  }) as typeof fetch

  return {
    calls,
    restore: () => {
      ;(globalThis as unknown as { fetch: typeof fetch }).fetch = original
    },
  }
}
