'use client'

import { IconAlertTriangle, IconCalendar, IconClock, IconChevronLeft, IconChevronRight } from '@tabler/icons-react'
import { useState } from 'react'
import { MonitorState, MonitorTarget } from '@/types/config'
import { maintenances } from '@/uptime.config'
import MaintenanceAlert from './MaintenanceAlert'
import { Badge, Button, Dropdown, Drawer, formatDuration } from './ui'

type DisplayIncident = {
  monitorId: string
  monitorName: string
  start: number
  end: number | null
  errors: { start: string; end: string; error: string }[]
  duration: number
}

function getSelectedMonth(nowMs: number) {
  const now = new Date(nowMs)
  return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0')
}

function shiftMonth(monthStr: string, delta: number) {
  const [year, month] = monthStr.split('-').map(Number)
  const date = new Date(year, month - 1 + delta)
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0')
}

function formatShortTime(seconds: number) {
  return new Date(seconds * 1000).toLocaleString('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function extractIncidents(
  state: MonitorState,
  monitors: MonitorTarget[],
  monthStr: string,
  nowSec: number
): DisplayIncident[] {
  const [year, month] = monthStr.split('-').map(Number)
  const monthStart = new Date(year, month - 1, 1).getTime() / 1000
  const monthEnd = new Date(year, month, 1).getTime() / 1000

  const incidents: DisplayIncident[] = []

  for (const monitor of monitors) {
    const monitorIncidents = state.incident[monitor.id]
    if (!monitorIncidents) continue

    for (const incident of monitorIncidents) {
      const incidentStart = incident.start[0]
      const incidentEnd = incident.end ?? nowSec

      if (incidentEnd < monthStart || incidentStart >= monthEnd) continue

      const errors = incident.error.map((error, index) => ({
        start: formatShortTime(incident.start[index]),
        end: formatShortTime(index === incident.error.length - 1 ? incidentEnd : incident.start[index + 1]),
        error,
      }))

      incidents.push({
        monitorId: monitor.id,
        monitorName: monitor.name,
        start: incidentStart,
        end: incident.end,
        errors,
        duration: incidentEnd - incidentStart,
      })
    }
  }

  incidents.sort((a, b) => b.start - a.start)
  return incidents
}

function IncidentCard({ incident }: { incident: DisplayIncident }) {
  const isOngoing = incident.end === null

  return (
    <div className="rounded-[1.35rem] border border-slate-200/80 bg-white/85 p-4 shadow-[0_16px_45px_rgba(15,23,42,0.07)] backdrop-blur">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className={`h-2.5 w-2.5 rounded-full ${isOngoing ? 'bg-rose-500' : 'bg-amber-400'}`} />
            <IconAlertTriangle
              className={isOngoing ? 'text-rose-500' : 'text-amber-500'}
              size={18}
              strokeWidth={2}
            />
            <span className={`text-sm font-bold ${isOngoing ? 'text-rose-600' : 'text-amber-600'}`}>
              {incident.monitorName}
            </span>
          </div>
          <Badge tone={isOngoing ? 'rose' : 'amber'}>{isOngoing ? '进行中' : '已恢复'}</Badge>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
          <span className="flex items-center gap-1">
            <IconCalendar size={13} className={isOngoing ? 'text-rose-400' : 'text-amber-400'} />
            {formatShortTime(incident.start)}
          </span>
          <span className="text-slate-300">→</span>
          <span className="flex items-center gap-1">
            <IconClock size={13} className={isOngoing ? 'text-rose-400' : 'text-amber-400'} />
            {isOngoing ? '进行中' : formatShortTime(incident.end!)}
          </span>
          <span className="text-slate-300">|</span>
          <span className="font-medium">{formatDuration(incident.duration)}</span>
        </div>

        <div className="mt-1 flex flex-col gap-1.5">
          {incident.errors.map((err, index) => (
            <div
              key={index}
              className="flex flex-col gap-1 rounded-2xl border border-slate-100 bg-slate-50/80 p-3"
            >
              {incident.errors.length > 1 && (
                <div
                  className={`w-max rounded px-1.5 py-0.5 font-mono text-[11px] font-medium ${
                    isOngoing ? 'bg-rose-100 text-rose-700' : 'bg-amber-100 text-amber-700'
                  }`}
                >
                  {err.start} - {err.end}
                </div>
              )}
              <div className="break-all font-mono text-xs text-slate-600">{err.error}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export default function IncidentsDrawer({
  opened,
  onClose,
  state,
  monitors,
}: {
  opened: boolean
  onClose: () => void
  state: MonitorState
  monitors: MonitorTarget[]
}) {
  // The month picker initialises on the client only, so the drawer markup is
  // stable between SSR and hydration (it is hidden until opened anyway).
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null)
  const [selectedMonitor, setSelectedMonitor] = useState('')
  const [page, setPage] = useState(1)

  const month = selectedMonth ?? getSelectedMonth(Date.now())
  const nowSec = Math.floor(Date.now() / 1000)

  const incidents = extractIncidents(state, monitors, month, nowSec)
  const filtered = selectedMonitor ? incidents.filter((i) => i.monitorId === selectedMonitor) : incidents
  const maintenanceEvents = maintenances
    .filter((m) => getSelectedMonth(new Date(m.start).getTime()) === month)
    .map((maintenance) => ({
      ...maintenance,
      monitors: maintenance.monitors?.map((id) => monitors.find((monitor) => monitor.id === id)),
    }))

  const itemsPerPage = 20
  const totalPages = Math.max(1, Math.ceil(filtered.length / itemsPerPage))
  const visible = filtered.slice((page - 1) * itemsPerPage, page * itemsPerPage)

  return (
    <Drawer
      open={opened}
      onClose={onClose}
      subtitle="History"
      title="历史故障"
      wide
    >
      <div className="space-y-5">
        <div className="rounded-2xl border border-white/70 bg-white/80 p-4 shadow-sm backdrop-blur">
          <Dropdown
            ariaLabel="按站点筛选"
            value={selectedMonitor}
            onChange={(value) => {
              setSelectedMonitor(value)
              setPage(1)
            }}
            options={[
              { value: '', label: '全部站点' },
              ...monitors.map((monitor) => ({ value: monitor.id, label: monitor.name })),
            ]}
            placeholder="全部站点"
            triggerClassName="h-11 rounded-full border-transparent bg-slate-100/80 shadow-sm hover:border-slate-200"
          />
        </div>

        <div className="rounded-[1.5rem] border border-slate-200/70 bg-white/85 p-5 backdrop-blur">
          <div className="mb-5 flex items-center justify-between gap-2">
            <Button variant="subtle" size="sm" onClick={() => { setSelectedMonth(shiftMonth(month, -1)); setPage(1) }}>
              <IconChevronLeft size={16} />
              上个月
            </Button>
            <span className="flex items-center gap-2 text-lg font-extrabold tracking-tight text-slate-900">
              <IconCalendar size={18} className="text-slate-400" />
              {month}
            </span>
            <Button variant="subtle" size="sm" onClick={() => { setSelectedMonth(shiftMonth(month, 1)); setPage(1) }}>
              下个月
              <IconChevronRight size={16} />
            </Button>
          </div>

          <div className="space-y-3">
            {maintenanceEvents.map((maintenance, index) => (
              <MaintenanceAlert key={`m-${index}`} maintenance={maintenance} />
            ))}

            {filtered.length === 0 && maintenanceEvents.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-200 p-8 text-center text-sm text-slate-400">
                这个月没有故障记录 🎉
              </div>
            ) : (
              visible.map((incident, index) => <IncidentCard key={`i-${index}`} incident={incident} />)
            )}

            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-2 pt-3">
                <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                  <IconChevronLeft size={14} />
                </Button>
                <span className="text-xs font-medium text-slate-500">
                  {page} / {totalPages}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage(page + 1)}
                >
                  <IconChevronRight size={14} />
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
    </Drawer>
  )
}
