// Shared types. Row types describe the D1 layout (see state-format.ts).

import type { MonitorScheduler } from './index'
import type { IncidentRow } from './state-format'

export type { IncidentRow }

export type PageConfigLink = { link: string; label: string }

export type PageConfig = {
  title?: string
  links?: PageConfigLink[]
  group?: { [key: string]: string[] }
  favicon?: string
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
  // Per-monitor check cadence. The scheduler ticks every 10 minutes and
  // checks a monitor only when its interval elapsed, so any multiple of 10
  // (10/20/30/60) is free — skipped rounds cost nothing.
  intervalMinutes?: number
}

export type Notification = {
  timeZone?: string
  gracePeriod?: number
  skipNotificationIds?: string[]
  skipErrorChangeNotification?: boolean
}

export type WorkerConfig = {
  monitors: MonitorTarget[]
  notification?: Notification
}

export type RuntimeBindings = {
  UPTIMEFLARE_D1?: D1Database
  MONITOR_SCHEDULER_DO?: DurableObjectNamespace<MonitorScheduler>
}

export type RuntimeEnv = RuntimeBindings & Record<string, unknown>

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
  startedAt?: Record<string, number>
}

// Compact columnar format: ~3.5x faster parse/stringify and 40-60% smaller
// than the record-based shape (upstream benchmarks).
export type MonitorStateCompacted = {
  lastUpdate: number
  overallUp: number
  overallDown: number
  incident: Record<
    string,
    { start: number[][]; end: (number | null)[]; error: string[][] }
  >
  latency: Record<
    string,
    {
      loc: { v: string[]; c: number[] }
      time: string // hex encoded little-endian Uint32Array
      ping: string // hex encoded little-endian Uint16Array
    }
  >
  startedAt?: Record<string, number>
}
