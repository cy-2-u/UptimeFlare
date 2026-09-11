import {
  IncidentRecord,
  LatencyRecord,
  MonitorState,
  MonitorStateCompacted,
} from '../../types/config'

type StoreEnv = {
  UPTIMEFLARE_D1?: D1Database
}

const STORE_TABLE = 'uptimeflare'

async function ensureStore(env: StoreEnv): Promise<void> {
  if (!env.UPTIMEFLARE_D1) return
  await env.UPTIMEFLARE_D1.exec(
    `CREATE TABLE IF NOT EXISTS ${STORE_TABLE} (key VARCHAR(255) PRIMARY KEY, value BLOB NOT NULL);`
  )
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

export async function getFromStore(env: StoreEnv, key: string): Promise<string | null> {
  if (!env.UPTIMEFLARE_D1) return null
  try {
    const stmt = env.UPTIMEFLARE_D1.prepare(`SELECT value FROM ${STORE_TABLE} WHERE key = ?`)
    const result = await stmt.bind(key).first<{ value: string }>()
    return result?.value || null
  } catch (error) {
    console.error('Failed to read D1 state:', error)
    return null
  }
}

export async function setToStore(env: StoreEnv, key: string, value: string): Promise<void> {
  const db = env.UPTIMEFLARE_D1
  if (!db) return
  const sql = `INSERT INTO ${STORE_TABLE} (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;`
  try {
    await db.prepare(sql).bind(key, value).run()
  } catch {
    await ensureStore(env)
    await db.prepare(sql).bind(key, value).run()
  }
}

export class CompactedMonitorStateWrapper {
  data: MonitorStateCompacted

  constructor(compactedStateStr: string | null) {
    if (!compactedStateStr) {
      // Initialize empty state
      this.data = {
        lastUpdate: 0,
        overallUp: 0,
        overallDown: 0,
        incident: {},
        latency: {},
      }
      return
    }
    this.data = JSON.parse(compactedStateStr)
  }

  getCompactedStateStr(): string {
    return JSON.stringify(this.data)
  }

  // Don't use this method at server-side
  uncompact(): MonitorState {
    let state: MonitorState = {
      lastUpdate: this.data.lastUpdate,
      overallUp: this.data.overallUp,
      overallDown: this.data.overallDown,
      incident: {},
      latency: {},
    }

    Object.keys(this.data.incident).forEach((monitorId) => {
      state.incident[monitorId] = []
      const incidents = this.data.incident[monitorId]

      if (
        incidents.start.length !== incidents.end.length ||
        incidents.start.length !== incidents.error.length
      ) {
        throw new Error(
          'Inconsistent incident data lengths.'
        )
      }

      for (let i = 0; i < incidents.start.length; i++) {
        state.incident[monitorId].push({
          start: incidents.start[i],
          end: incidents.end[i],
          error: incidents.error[i],
        })
      }
    })

    Object.keys(this.data.latency).forEach((monitorId) => {
      state.latency[monitorId] = []
      const latencies = this.data.latency[monitorId]
      const locUncompacted: string[] = []
      latencies.loc.c.forEach((count, index) => {
        for (let i = 0; i < count; i++) {
          locUncompacted.push(latencies.loc.v[index])
        }
      })

      const timeArr = new Uint32Array(hexToBytes(latencies.time).buffer)
      const pingArr = new Uint16Array(hexToBytes(latencies.ping).buffer)

      if (timeArr.length !== pingArr.length || timeArr.length !== locUncompacted.length) {
        throw new Error(
          'Inconsistent latency data lengths.'
        )
      }

      for (let i = 0; i < timeArr.length; i++) {
        state.latency[monitorId].push({
          time: timeArr[i],
          ping: pingArr[i],
          loc: locUncompacted[i],
        })
      }
    })

    return state
  }

  incidentLen(monitorId: string): number {
    const incidents = this.data.incident[monitorId]
    if (!incidents) return 0
    return incidents.start.length
  }

  getIncident(monitorId: string, index: number): IncidentRecord {
    const incidents = this.data.incident[monitorId]
    if (!incidents || index < 0 || index >= incidents.start.length) {
      throw new Error('Index out of bounds or monitor not found')
    }
    return {
      start: incidents.start[index],
      end: incidents.end[index],
      error: incidents.error[index],
    }
  }

  setIncident(monitorId: string, index: number, incident: IncidentRecord) {
    const incidents = this.data.incident[monitorId]
    if (!incidents || index < 0 || index >= incidents.start.length) {
      throw new Error('Index out of bounds or monitor not found')
    }
    incidents.start[index] = incident.start
    incidents.end[index] = incident.end
    incidents.error[index] = incident.error
  }

  appendIncident(monitorId: string, incident: IncidentRecord) {
    let incidents = this.data.incident[monitorId]
    if (!incidents) {
      // Initialize incident arrays
      this.data.incident[monitorId] = {
        start: [],
        end: [],
        error: [],
      }
      incidents = this.data.incident[monitorId]
    }
    incidents.start.push(incident.start)
    incidents.end.push(incident.end)
    incidents.error.push(incident.error)
  }

  shiftIncident(monitorId: string) {
    const incidents = this.data.incident[monitorId]
    incidents.start.shift()
    incidents.end.shift()
    incidents.error.shift()
  }

  unshiftIncident(monitorId: string, incident: IncidentRecord) {
    const incidents = this.data.incident[monitorId]
    incidents.start.unshift(incident.start)
    incidents.end.unshift(incident.end)
    incidents.error.unshift(incident.error)
  }

  latencyLen(monitorId: string): number {
    const latencies = this.data.latency[monitorId]
    if (!latencies) return 0
    return latencies.ping.length / 4 // Uint16Array, 4 characters per entry in hex
  }

  appendLatency(monitorId: string, record: LatencyRecord) {
    let latencies = this.data.latency[monitorId]
    if (!latencies) {
      // Initialize latency arrays
      this.data.latency[monitorId] = {
        time: '',
        ping: '',
        loc: {
          c: [],
          v: [],
        },
      }
      latencies = this.data.latency[monitorId]
    }

    // @ts-expect-error
    latencies.time += new Uint8Array(new Uint32Array([record.time]).buffer).toHex()
    // @ts-expect-error
    latencies.ping += new Uint8Array(new Uint16Array([record.ping]).buffer).toHex()

    if (latencies.loc.v[latencies.loc.v.length - 1] !== record.loc) {
      latencies.loc.c.push(1)
      latencies.loc.v.push(record.loc)
    } else {
      latencies.loc.c[latencies.loc.c.length - 1] += 1
    }
  }

  getFirstLatency(monitorId: string): LatencyRecord {
    let latencies = this.data.latency[monitorId]

    return {
      time: new Uint32Array(hexToBytes(latencies.time.slice(0, 8)).buffer)[0],
      ping: new Uint16Array(hexToBytes(latencies.ping.slice(0, 4)).buffer)[0],
      loc: latencies.loc.v[0],
    }
  }

  getLastLatency(monitorId: string): LatencyRecord {
    let latencies = this.data.latency[monitorId]

    return {
      time: new Uint32Array(hexToBytes(latencies.time.slice(-8)).buffer)[0],
      ping: new Uint16Array(hexToBytes(latencies.ping.slice(-4)).buffer)[0],
      loc: latencies.loc.v[latencies.loc.v.length - 1],
    }
  }

  unshiftLatency(monitorId: string) {
    let latencies = this.data.latency[monitorId]

    latencies.time = latencies.time.slice(8)
    latencies.ping = latencies.ping.slice(4)

    latencies.loc.c[0] -= 1
    if (latencies.loc.c[0] === 0) {
      latencies.loc.c.shift()
      latencies.loc.v.shift()
    }
  }
}
