'use client'

import { IconCloud } from '@tabler/icons-react'
import { MonitorState, MonitorTarget } from '@/types/config'
import { maintenances } from '@/uptime.config'
import UptimeBars, { computeDayStats } from './UptimeBars'
import { Badge, formatTimeAgo, useNow } from './ui'

type CardStatus = 'maintenance' | 'up' | 'pending' | 'down'

const statusDot: Record<CardStatus, string> = {
  maintenance: 'bg-amber-500',
  up: 'bg-emerald-500',
  pending: 'bg-slate-400',
  down: 'bg-rose-500',
}

const statusPill: Record<CardStatus, string> = {
  maintenance: 'border-amber-200 bg-amber-50 text-amber-700',
  up: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  pending: 'border-slate-200 bg-slate-50 text-slate-600',
  down: 'border-rose-200 bg-rose-50 text-rose-700',
}

const statusLabels: Record<CardStatus, string> = {
  maintenance: '维护中',
  up: '运行正常',
  pending: '等待检查',
  down: '宕机',
}

export default function MonitorCard({
  monitor,
  state,
}: {
  monitor: MonitorTarget
  state: MonitorState
}) {
  const now = useNow(30_000, state.lastUpdate * 1000)

  const targetLabel = (() => {
    if (!monitor.target) return ''
    try {
      return new URL(monitor.target).hostname
    } catch {
      return monitor.target.split('/')[0]
    }
  })()

  const previewUrl =
    monitor.preview ||
    (/^https?:\/\//.test(monitor.target)
      ? `https://image.thum.io/get/width/1200/${monitor.target}`
      : '')

  const incidents = state.incident[monitor.id] ?? []
  const hasCheckData = incidents.length > 0

  const inMaintenance = maintenances.some(
    (m) =>
      now >= new Date(m.start).getTime() &&
      (!m.end || now <= new Date(m.end).getTime()) &&
      m.monitors?.includes(monitor.id)
  )

  const status: CardStatus = inMaintenance
    ? 'maintenance'
    : !hasCheckData
      ? 'pending'
      : incidents[incidents.length - 1].end === null
        ? 'down'
        : 'up'

  const latencies = state.latency[monitor.id]
  const lastLatency = latencies && latencies.length > 0 ? latencies[latencies.length - 1].ping : null

  // 30-day uptime percentage from the same day buckets the bars render.
  const dayStats = computeDayStats({
    incidents,
    startedAt: state.startedAt?.[monitor.id],
    now,
    days: 30,
  })
  const totalMonitorTime = dayStats.reduce((sum, day) => sum + day.monitorTime, 0)
  const totalDownTime = dayStats.reduce((sum, day) => sum + day.downTime, 0)
  const uptimePercent =
    totalMonitorTime > 0 ? (((totalMonitorTime - totalDownTime) / totalMonitorTime) * 100).toFixed(2) : '—'

  return (
    <div className="monitor-card group relative flex flex-col gap-5 rounded-[1.75rem] border border-slate-200/80 bg-white/80 p-4 shadow-[0_18px_55px_rgba(15,23,42,0.08)] backdrop-blur transition-all duration-300 hover:-translate-y-0.5 hover:bg-white hover:shadow-[0_24px_70px_rgba(15,23,42,0.12)]">
      <div className="overflow-hidden rounded-[1.15rem] border border-slate-200/65 bg-slate-100">
        <div
          className="flex h-8 items-center gap-1.5 border-b border-slate-200/60 bg-white/70 px-3"
          aria-hidden="true"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-slate-300" />
          <span className="h-1.5 w-1.5 rounded-full bg-slate-300" />
          <span className="h-1.5 w-1.5 rounded-full bg-slate-300" />
          <span className="ml-2 truncate font-mono text-[9px] tracking-wide text-slate-400">
            {targetLabel}
          </span>
        </div>
        <div className="relative aspect-video w-full overflow-hidden">
          {previewUrl ? (
            <a
              href={monitor.statusPageLink || monitor.target}
              target="_blank"
              rel="noopener noreferrer"
              className="block h-full w-full"
            >
              {/* Plain <img>: next/image optimization needed a paid Cloudflare
                  Images plan plus an allow-any-host config; this needs neither. */}
              <img
                src={previewUrl}
                alt={monitor.name}
                loading="lazy"
                className="h-full w-full origin-top object-cover object-top transition-transform duration-700 group-hover:scale-105"
              />
            </a>
          ) : (
            <div className="flex h-full w-full items-center justify-center text-slate-300">
              <IconCloud size={56} stroke={1.2} />
            </div>
          )}

          <div
            className={`absolute right-4 top-14 flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium shadow-sm backdrop-blur ${statusPill[status]}`}
          >
            <span className={`h-2 w-2 rounded-full ${statusDot[status]}`} />
            {statusLabels[status]}
          </div>
        </div>
      </div>

      <div className="flex min-h-12 items-start justify-between gap-3 px-1">
        <div className="min-w-0">
          <h3 className="truncate text-lg font-semibold tracking-[-0.025em] text-slate-800">
            {monitor.name}
          </h3>
          {targetLabel && (
            <div className="mt-1 truncate font-mono text-[11px] text-slate-500">{targetLabel}</div>
          )}
        </div>
        {monitor.group && <Badge>{monitor.group}</Badge>}
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex justify-between text-xs font-medium text-slate-500">
          <span>近 30 天</span>
          <span className="font-mono text-slate-700">
            {uptimePercent}
            <span className="ml-0.5 text-slate-400">%</span>
          </span>
        </div>
        <UptimeBars
          monitor={monitor}
          incidents={incidents}
          startedAt={state.startedAt?.[monitor.id]}
          now={now}
          days={30}
        />
      </div>

      <div className="mt-auto flex items-center justify-between border-t border-slate-100 pt-4 text-xs font-medium text-slate-500">
        <div className="flex items-center gap-1.5">
          <span className={`h-2.5 w-2.5 rounded-full ${statusDot[status]}`} />
          <span className={status === 'down' ? 'text-rose-600' : ''}>{statusLabels[status]}</span>
          {status !== 'pending' && state.lastUpdate > 0 && (
            <span className="text-slate-400">{formatTimeAgo(state.lastUpdate, now)}前</span>
          )}
        </div>
        <div className="flex items-center gap-1 rounded-xl bg-slate-100 px-2 py-1">
          <span
            className={`font-mono text-xs font-bold ${
              lastLatency && lastLatency > 500 ? 'text-amber-600' : 'text-slate-700'
            }`}
          >
            {lastLatency ? `${lastLatency}ms` : '-'}
          </span>
        </div>
      </div>
    </div>
  )
}
