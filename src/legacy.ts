import { random } from './auth'
import { freshState, stateKey, type Credentials, type Monitor, type State, type Storage } from './types'

// Runs only until the version marker is committed. Any unreadable old row aborts the import.
export async function importLegacy(storage: Storage, db?: D1Database) {
  if (await storage.get('version')) return
  const monitors = (await storage.get<Monitor[]>('monitors')) ?? []
  const pending = new Set((await storage.get<string[]>('pendingDeletes')) ?? [])
  const active = monitors.filter(m => !pending.has(m.id)).map(m => ({ ...m, timeout: m.timeout ?? 3000, intervalMinutes: m.intervalMinutes ?? 10, group: m.group || '核心服务' }))
  if (monitors.length && !db) throw Error('Existing monitors require the legacy D1 binding for migration')
  const entries: Record<string, unknown> = { version: 5, monitors: active }
  if (db) {
    const { results } = await db.prepare('SELECT key, value FROM uptimeflare').all<{ key: string; value: string }>()
    const rows = new Map(results.map(row => [row.key, row.value]))
    const credential = rows.get('admin_credentials')
    if (credential) entries.admin = { ...JSON.parse(credential), sessionKey: random() } satisfies Credentials
    const meta = rows.get('state:meta')
    if (meta) entries.lastUpdate = JSON.parse(meta).lastUpdate ?? 0
    for (const monitor of active) {
      const state = freshState()
      const rawLat = rows.get(`state:lat:${monitor.id}`)
      const rawInc = rows.get(`state:inc:${monitor.id}`)
      if (rawLat) {
        const row = JSON.parse(rawLat)
        const numbers = (value: string, width: number) => {
          const data = Uint8Array.from(value.match(/../g) ?? [], (part: string) => parseInt(part, 16))
          const view = new DataView(data.buffer)
          return Array.from({ length: data.length / width }, (_, i) => width === 4 ? view.getUint32(i * width, true) : view.getUint16(i * width, true))
        }
        const times = numbers(row.time, 4)
        const pings = numbers(row.ping, 2)
        const locations: string[] = row.loc.c.flatMap((count: number, i: number) => Array(count).fill(row.loc.v[i]))
        if (times.length !== pings.length || times.length !== locations.length) throw Error(`Invalid legacy latency: ${monitor.id}`)
        state.latency = times.map((time, i) => ({ time, ping: pings[i], loc: locations[i] }))
        state.checkedAt = times.at(-1) ?? 0
        state.startedAt = row.startedAt
        state.up = row.lastStatus === null ? null : row.lastStatus === 'up'
        state.error = row.lastErr
        state.notified = row.downNotifiedAt != null
      }
      if (rawInc) {
        const row = JSON.parse(rawInc)
        state.incidents = row.start.map((start: number[], i: number) => ({ start, end: row.end[i], error: row.error[i] }))
      }
      entries[stateKey(monitor.id)] = state satisfies State
    }
  }
  await storage.transaction(async txn => {
    await txn.put(entries)
    await txn.delete('pendingDeletes')
  })
}
