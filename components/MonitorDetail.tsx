'use client'

import { IconAlertTriangle, IconCheck, IconExternalLink, IconX } from '@tabler/icons-react'
import { MonitorState, MonitorTarget } from '@/types/config'
import { maintenances } from '@/uptime.config'
import Sparkline from './Sparkline'
import UptimeBars from './UptimeBars'
import { Badge, formatTimeAgo, useNow } from './ui'

// Single-monitor view used when the page hash points at a monitor id
// (e.g. /#example-com) — handy for embedding one monitor in an iframe.
export default function MonitorDetail({
  monitor,
  state,
}: {
  monitor: MonitorTarget
  state: MonitorState
}) {
  const now = useNow(30_000, state.lastUpdate * 1000)

  const incidents = state.incident[monitor.id] ?? []
  const hasData = incidents.length > 0 || (state.latency[monitor.id]?.length ?? 0) > 0

  const inMaintenance = maintenances.some(
    (m) =>
      now >= new Date(m.start).getTime() &&
      (!m.end || now <= new Date(m.end).getTime()) &&
      m.monitors?.includes(monitor.id)
  )

  const isUp = hasData && incidents.length > 0 && incidents[incidents.length - 1].end !== null

  const totalTimeSec = hasData ? now / 1000 - incidents[0].start[0] : 0
  const downTimeSec = incidents.reduce(
    (sum, incident) => sum + (incident.end ?? now / 1000) - incident.start[0],
    0
  )
  const uptimePercent =
    totalTimeSec > 0 ? (((totalTimeSec - downTimeSec) / totalTimeSec) * 100).toPrecision(4) : null

  if (!hasData) {
    return (
      <div className="rounded-[1.75rem] border border-slate-200/80 bg-white/85 p-6 shadow-sm backdrop-blur">
        <h2 className="text-xl font-bold text-slate-900">{monitor.name}</h2>
        <p className="mt-2 text-sm text-slate-500">暂无监测数据。</p>
      </div>
    )
  }

  return (
    <div className="rounded-[1.75rem] border border-slate-200/80 bg-white/85 p-6 shadow-[0_18px_55px_rgba(15,23,42,0.08)] backdrop-blur sm:p-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span
            className={`flex h-11 w-11 items-center justify-center rounded-2xl ${
              inMaintenance
                ? 'bg-amber-100 text-amber-600'
                : isUp
                  ? 'bg-emerald-100 text-emerald-600'
                  : 'bg-rose-100 text-rose-600'
            }`}
          >
            {inMaintenance ? (
              <IconAlertTriangle size={22} />
            ) : isUp ? (
              <IconCheck size={22} />
            ) : (
              <IconX size={22} />
            )}
          </span>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-extrabold tracking-[-0.03em] text-slate-950">
                {monitor.name}
              </h2>
              {monitor.statusPageLink && (
                <a
                  href={monitor.statusPageLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="访问站点"
                  className="text-slate-400 transition hover:text-slate-700"
                >
                  <IconExternalLink size={16} />
                </a>
              )}
            </div>
            {monitor.tooltip && <p className="mt-0.5 text-sm text-slate-500">{monitor.tooltip}</p>}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Badge tone={inMaintenance ? 'amber' : isUp ? 'emerald' : 'rose'}>
            {inMaintenance ? '维护中' : isUp ? '运行正常' : '宕机'}
          </Badge>
          {uptimePercent && <Badge tone="slate">总可用率 {uptimePercent}%</Badge>}
          {state.lastUpdate > 0 && (
            <Badge tone="slate">{formatTimeAgo(state.lastUpdate, now)}前更新</Badge>
          )}
        </div>
      </div>

      <div className="mt-8 space-y-8">
        <section>
          <h3 className="mb-3 text-xs font-bold uppercase tracking-[0.2em] text-slate-400">
            可用率历史（90 天）
          </h3>
          <UptimeBars
            monitor={monitor}
            incidents={incidents}
            startedAt={state.startedAt?.[monitor.id]}
            now={now}
            days={90}
            height="h-8"
            barWidth="flex-1"
          />
        </section>

        {!monitor.hideLatencyChart && (
          <section>
            <h3 className="mb-3 text-xs font-bold uppercase tracking-[0.2em] text-slate-400">
              响应时间（近 12 小时）
            </h3>
            <Sparkline points={state.latency[monitor.id] ?? []} />
          </section>
        )}
      </div>
    </div>
  )
}
