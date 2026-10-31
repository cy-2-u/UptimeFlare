'use client'

import { useState } from 'react'
import { MonitorState, MonitorTarget } from '@/types/config'
import { getColor } from '@/util/color'
import { Badge, Drawer, Tooltip, formatDuration } from './ui'

type DayIncident = { start: string; end: string; error: string }

function overlapLen(x1: number, x2: number, y1: number, y2: number) {
  return Math.max(0, Math.min(x2, y2) - Math.max(x1, y1))
}

export type DayStat = {
  dayStart: number
  dayEnd: number
  monitorTime: number // seconds this monitor was (assumed) watched that day
  percent: number // -1 = no data
  downTime: number
  incidents: DayIncident[]
}

// Shared per-day uptime computation for the card (30d) and detail (90d) bars.
// `now` comes from a mounted-aware clock so SSR and hydration agree.
export function computeDayStats({
  incidents,
  startedAt,
  now,
  days,
}: {
  incidents: MonitorState['incident'][string]
  startedAt?: number
  now: number
  days: number
}): DayStat[] {
  const stats: DayStat[] = []
  const monitorStartTime = startedAt ?? incidents[0]?.start[0] ?? Math.round(now / 1000)

  const todayStart = new Date(now)
  todayStart.setHours(0, 0, 0, 0)
  const todayStartSec = Math.round(todayStart.getTime() / 1000)
  const nowSec = Math.round(now / 1000)

  for (let i = days - 1; i >= 0; i--) {
    const dayStart = todayStartSec - i * 86400
    const dayEnd = dayStart + 86400
    const dayMonitorTime = overlapLen(dayStart, dayEnd, monitorStartTime, nowSec)
    let dayDownTime = 0
    const dayIncidents: DayIncident[] = []

    for (const incident of incidents) {
      const incidentStart = incident.start[0]
      const incidentEnd = incident.end ?? nowSec
      const overlap = overlapLen(dayStart, dayEnd, incidentStart, incidentEnd)
      dayDownTime += overlap

      if (overlap > 0) {
        for (let k = 0; k < incident.error.length; k++) {
          const partStart = Math.max(incident.start[k], dayStart)
          const partEnd = Math.min(
            k === incident.error.length - 1 ? incidentEnd : incident.start[k + 1],
            dayEnd
          )
          if (overlapLen(dayStart, dayEnd, partStart, partEnd) > 0) {
            dayIncidents.push({
              start: new Date(partStart * 1000).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              }),
              end: new Date(partEnd * 1000).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              }),
              error: incident.error[k],
            })
          }
        }
      }
    }

    const percent =
      dayMonitorTime === 0
        ? -1
        : ((dayMonitorTime - dayDownTime) / dayMonitorTime) * 100

    stats.push({
      dayStart,
      dayEnd,
      monitorTime: dayMonitorTime,
      percent,
      downTime: dayDownTime,
      incidents: dayIncidents,
    })
  }

  return stats
}

function DayIncidentDrawer({
  open,
  onClose,
  day,
  monitorName,
}: {
  open: boolean
  onClose: () => void
  day: DayStat | null
  monitorName: string
}) {
  return (
    <Drawer
      open={open}
      onClose={onClose}
      subtitle={new Date((day?.dayStart ?? 0) * 1000).toLocaleDateString()}
      title={`${monitorName} 的故障记录`}
      wide
    >
      {day && (
        <div className="space-y-4">
          <div className="flex items-center justify-between rounded-2xl border border-rose-100 bg-rose-50 px-4 py-3">
            <span className="text-sm font-semibold text-rose-700">总宕机时间</span>
            <Badge tone="rose">{formatDuration(day.downTime)}</Badge>
          </div>

          {day.incidents.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-slate-200 p-5 text-sm text-slate-500">
              这一天没有故障记录。
            </p>
          ) : (
            [...day.incidents].reverse().map((incident, index) => (
              <div
                key={index}
                className="rounded-2xl border border-amber-100 border-l-4 border-l-amber-400 bg-amber-50/60 p-4"
              >
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <span className="font-mono">{incident.start}</span>
                  <span className="text-slate-300">→</span>
                  <span className="font-mono">{incident.end}</span>
                </div>
                <div className="mt-2 break-all rounded-xl border border-slate-100 bg-white/70 p-2.5 font-mono text-xs text-slate-600">
                  {incident.error}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </Drawer>
  )
}

// Uptime bars with per-day tooltips and a click-through incident drawer.
export default function UptimeBars({
  monitor,
  incidents,
  startedAt,
  now,
  days = 30,
  height = 'h-6',
  barWidth = 'w-1.5',
}: {
  monitor: MonitorTarget
  incidents: MonitorState['incident'][string]
  startedAt?: number
  now: number
  days?: number
  height?: string
  barWidth?: string
}) {
  const [selectedDay, setSelectedDay] = useState<DayStat | null>(null)

  const stats = computeDayStats({ incidents, startedAt, now, days })

  return (
    <>
      <div className="flex items-end justify-between gap-[3px]">
        {stats.map((day) => {
          const barColor =
            day.percent === -1
              ? 'bg-gray-200'
              : getColor(day.percent)
          return (
            <Tooltip
              key={day.dayStart}
              wide
              label={
                <span className="block">
                  <span className="block font-bold">
                    {new Date(day.dayStart * 1000).toLocaleDateString()}
                    {day.percent === -1 ? ' · 无数据' : ` · ${day.percent.toFixed(2)}%`}
                  </span>
                  {day.downTime > 0 && (
                    <span className="mt-0.5 block font-semibold text-rose-300">
                      宕机 {formatDuration(day.downTime)}
                    </span>
                  )}
                  {day.downTime > 0 && <span className="block text-slate-300">点击查看详情</span>}
                </span>
              }
            >
              <button
                type="button"
                aria-label={`${new Date(day.dayStart * 1000).toLocaleDateString()} 可用率 ${
                  day.percent === -1 ? '无数据' : day.percent.toFixed(2) + '%'
                }`}
                className={`${barWidth} ${height} cursor-pointer rounded-sm ${barColor} transition-all duration-200 hover:scale-y-110 hover:opacity-80`}
                onClick={() => {
                  if (day.downTime > 0) setSelectedDay(day)
                }}
              />
            </Tooltip>
          )
        })}
      </div>

      <DayIncidentDrawer
        open={selectedDay !== null}
        onClose={() => setSelectedDay(null)}
        day={selectedDay}
        monitorName={monitor.name}
      />
    </>
  )
}
