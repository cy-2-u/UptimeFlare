// Shared types. Row types live in state.ts (they describe the D1 layout).

import type { MonitorScheduler } from './index'
import type { IncidentRow, LatencyRow } from './state'

export type { IncidentRow, LatencyRow }

export type PageConfigLink = { link: string; label: string }

export type PageConfig = {
  title?: string
  links?: PageConfigLink[]
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
  target: string
  tooltip?: string
  statusPageLink?: string
  preview?: string
  group?: string
  timeout?: number
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
