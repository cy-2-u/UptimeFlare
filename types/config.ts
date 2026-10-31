import type { MonitorScheduler } from '../worker/src'

export type PageConfigLink = {
  link: string
  label: string
  highlight?: boolean
}

export type PageConfigGroup = { [key: string]: string[] }

export type PageConfig = {
  title?: string
  links?: PageConfigLink[]
  group?: PageConfigGroup
  favicon?: string
  logo?: string
  maintenances?: {
    upcomingColor?: string
  }
  customFooter?: string
}

export type MaintenanceConfig = {
  monitors?: string[]
  title?: string
  body: string
  start: number | string
  end?: number | string
  color?: string
}

export type MonitorTarget = {
  id: string
  name: string
  method: string
  target: string
  tooltip?: string
  statusPageLink?: string
  preview?: string
  group?: string
  hideLatencyChart?: boolean
  expectedCodes?: number[]
  timeout?: number
  headers?: { [key: string]: string | number }
  body?: string
  responseKeyword?: string
  responseForbiddenKeyword?: string
}

export type WorkerConfig<TEnv = unknown> = {
  monitors: MonitorTarget[]
  notification?: Notification
}

export type Notification = {
  timeZone?: string
  gracePeriod?: number
  skipNotificationIds?: string[]
  skipErrorChangeNotification?: boolean
}

export type RuntimeBindings = {
  UPTIMEFLARE_D1?: D1Database
  UPTIMEFLARE_CONFIG?: KVNamespace
  MONITOR_SCHEDULER_DO?: DurableObjectNamespace<MonitorScheduler>
}

export type IncidentRecord = {
  start: number[]
  end: number | null // null if the incident is still open
  error: string[]
}

export type LatencyRecord = {
  loc: string
  ping: number
  time: number
}

export type MonitorState = {
  lastUpdate: number
  overallUp: number
  overallDown: number
  incident: Record<string, IncidentRecord[]>
  latency: Record<string, LatencyRecord[]>
  // Time of the first check of each monitor, used for honest uptime bars.
  startedAt?: Record<string, number>
}

// Compact columnar format, ~3.5x faster parse/stringify and 40-60% smaller than
// the record-based shape. See git history of the upstream project for benchmarks.
export type MonitorStateCompacted = {
  lastUpdate: number
  overallUp: number
  overallDown: number
  incident: Record<
    string,
    {
      start: number[][]
      end: (number | null)[]
      error: string[][]
    }
  >
  latency: Record<
    string,
    {
      loc: {
        v: string[] // run-length encoded location values
        c: number[] // run-length counts
      }
      time: string // hex encoded Uint32Array
      ping: string // hex encoded Uint16Array
    }
  >
  startedAt?: Record<string, number>
}
