import { Tooltip, Drawer, Badge, Stack, Text } from '@mantine/core'
import { IconCloud, IconAlertTriangle, IconCalendar, IconClock } from '@tabler/icons-react'
import { MonitorTarget, MonitorState } from '@/types/config'
import { useTranslation } from 'react-i18next'
import Image from 'next/image'
import { useState } from 'react'
import { maintenances } from '@/uptime.config'

export default function MonitorCard({
  monitor,
  state,
}: {
  monitor: MonitorTarget
  state: MonitorState
}) {
  const { t } = useTranslation('common')
  const [drawerOpened, setDrawerOpened] = useState(false)
  const [drawerTitle, setDrawerTitle] = useState('')
  const [drawerIncidents, setDrawerIncidents] = useState<
    { start: string; end: string; error: string }[]
  >([])
  const [drawerDowntime, setDrawerDowntime] = useState('')

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
    (/^https?:\/\//.test(monitor.target) ? `https://image.thum.io/get/width/1200/${monitor.target}` : '')

  const incident = state.incident[monitor.id]

  // Check if monitor is in maintenance
  const now = new Date()
  const hasMaintenance = maintenances
    .filter((m) => now >= new Date(m.start) && (!m.end || now <= new Date(m.end)))
    .find((maintenance) => maintenance.monitors?.includes(monitor.id))

  const hasCheckData = Boolean(incident && incident.length > 0)

  // Determine status: maintenance > pending > down > up
  const status = hasMaintenance
    ? 'maintenance'
    : !hasCheckData
    ? 'pending'
    : incident && incident.length > 0 && incident[incident.length - 1].end === null
    ? 'down'
    : 'up'

  // Get latest latency
  const latencies = state.latency[monitor.id]
  const lastLatency =
    latencies && latencies.length > 0 ? latencies[latencies.length - 1].ping : null

  // Calculate uptime bars (last 30 days)
  const uptimeBars = []
  const currentTime = Math.round(Date.now() / 1000)
  const monitorStartTime = state.incident[monitor.id]
    ? state.incident[monitor.id][0].start[0]
    : currentTime
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)

  // Helper to calculate overlap
  const overlapLen = (x1: number, x2: number, y1: number, y2: number) => {
    return Math.max(0, Math.min(x2, y2) - Math.max(x1, y1))
  }

  const formatDuration = (seconds: number) => {
    const d = Math.floor(seconds / 86400)
    const h = Math.floor((seconds % 86400) / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    const s = Math.floor(seconds % 60)

    const parts = []
    if (d > 0) parts.push(`${d}d`)
    if (h > 0) parts.push(`${h}h`)
    if (m > 0) parts.push(`${m}m`)
    if (s > 0) parts.push(`${s}s`)
    return parts.join(' ') || '0s'
  }

  let totalMonitorTime = 0
  let totalDownTime = 0

  for (let i = 29; i >= 0; i--) {
    const dayStart = Math.round(todayStart.getTime() / 1000) - i * 86400
    const dayEnd = dayStart + 86400
    const dayMonitorTime = overlapLen(dayStart, dayEnd, monitorStartTime, currentTime)
    let dayDownTime = 0

    let incidentReasons: { start: string; end: string; error: string }[] = []
    if (state.incident[monitor.id]) {
      for (let incident of state.incident[monitor.id]) {
        const incidentStart = incident.start[0]
        const incidentEnd = incident.end ?? currentTime
        const overlap = overlapLen(dayStart, dayEnd, incidentStart, incidentEnd)
        dayDownTime += overlap

        if (overlap > 0) {
          for (let i = 0; i < incident.error.length; i++) {
            let partStart = incident.start[i]
            let partEnd =
              i === incident.error.length - 1 ? incident.end ?? currentTime : incident.start[i + 1]
            partStart = Math.max(partStart, dayStart)
            partEnd = Math.min(partEnd, dayEnd)

            if (overlapLen(dayStart, dayEnd, partStart, partEnd) > 0) {
              const startStr = new Date(partStart * 1000).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })
              const endStr = new Date(partEnd * 1000).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })
              incidentReasons.push({
                start: startStr,
                end: endStr,
                error: incident.error[i],
              })
            }
          }
        }
      }
    }

    if (dayMonitorTime > 0) {
      totalMonitorTime += dayMonitorTime
      totalDownTime += dayDownTime
    }

    const dayPercent =
      dayMonitorTime === 0 ? -1 : ((dayMonitorTime - dayDownTime) / dayMonitorTime) * 100

    // Determine color based on uptime
    let barColor = 'bg-gray-200' // gray-200 for No data
    if (dayPercent === 100) barColor = 'bg-emerald-400' // emerald-500
    else if (dayPercent >= 98) barColor = 'bg-emerald-300' // emerald-400
    else if (dayPercent >= 95) barColor = 'bg-amber-400' // amber-500
    else if (dayPercent >= 0) barColor = 'bg-rose-500' // red-500

    uptimeBars.push(
      <Tooltip
        key={i}
        label={
          <Stack gap={2} p={4}>
            <Text size="xs" fw={700}>
              {new Date(dayStart * 1000).toLocaleDateString()} &nbsp;
              {dayPercent === -1 ? t('No Data') : `${dayPercent.toFixed(2)}%`}
            </Text>
            {dayDownTime > 0 && (
              <Text size="xs" c="red.2" fw={700}>
                {t('Down for', {
                  duration: formatDuration(dayDownTime),
                })}
              </Text>
            )}
          </Stack>
        }
        position="top"
        withArrow
        transitionProps={{ transition: 'pop', duration: 200 }}
      >
        <div
          className={`w-1.5 h-6 rounded-sm ${barColor} hover:opacity-80 transition-opacity cursor-pointer`}
          onClick={(e) => {
            e.stopPropagation()
            if (dayDownTime > 0) {
              setDrawerTitle(
                t('incidents at', {
                  name: monitor.name,
                  date: new Date(dayStart * 1000).toLocaleDateString(),
                })
              )
              setDrawerDowntime(formatDuration(dayDownTime))
              setDrawerIncidents(incidentReasons.reverse())
              setDrawerOpened(true)
            }
          }}
        />
      </Tooltip>
    )
  }

  // Format latency time ago
  const formatTimeAgo = (timestamp: number) => {
    const seconds = Math.floor(Date.now() / 1000 - timestamp)
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m`
    const hours = Math.floor(minutes / 60)
    return `${hours}h`
  }

  const timeInfo = state.lastUpdate ? formatTimeAgo(state.lastUpdate) : 'now'

  const totalPercent =
    totalMonitorTime > 0
      ? (((totalMonitorTime - totalDownTime) / totalMonitorTime) * 100).toFixed(2)
      : '0.00'

  const statusDotClass =
    status === 'maintenance'
      ? 'bg-amber-500'
      : status === 'up'
      ? 'bg-emerald-500'
      : status === 'pending'
      ? 'bg-slate-400'
      : 'bg-rose-500'

  const statusLabel =
    status === 'maintenance'
      ? t('Maintenance')
      : status === 'up'
      ? t('Operational')
      : status === 'pending'
       ? '等待检查'
      : t('Down')

  return (
    <>
      <Drawer
        opened={drawerOpened}
        onClose={() => setDrawerOpened(false)}
        position="right"
        size="xl"
        title={
          <Text size="xl" fw={800}>
            {drawerTitle}
          </Text>
        }
        padding="xl"
        onClick={(e) => e.stopPropagation()}
      >
        <Stack gap="md">
          {/* 总宕机时间 */}
          <div className="bg-red-50 border-l-4 border-l-red-500 rounded-lg shadow-sm shadow-slate-200 border border-slate-200 px-4 py-3">
            <div className="flex items-center gap-2">
              <IconAlertTriangle className="text-red-500" size={18} strokeWidth={2} />
              <span className="font-semibold text-sm text-red-600">{t('Total downtime')}</span>
              <Badge size="sm" variant="light" color="red" style={{ textTransform: 'none' }}>
                {drawerDowntime}
              </Badge>
            </div>
          </div>

          {/* 故障记录列表 */}
          {drawerIncidents.map((reason, index) => (
            <div
              key={index}
              className="bg-amber-50 border-l-4 border-l-amber-500 rounded-lg shadow-sm shadow-slate-200 border border-slate-200 px-4 py-3"
            >
              <div className="flex flex-col gap-2">
                {/* 时间范围 */}
                <div className="flex items-center gap-2 text-xs text-gray-600 flex-wrap">
                  <div className="flex items-center gap-1">
                    <IconCalendar size={14} className="text-amber-400" />
                    <span>{reason.start}</span>
                  </div>
                  <span className="text-gray-400">→</span>
                  <div className="flex items-center gap-1">
                    <IconClock size={14} className="text-amber-400" />
                    <span>{reason.end}</span>
                  </div>
                </div>

                {/* 错误详情 */}
                <div className="flex flex-col gap-1.5">
                  <div className="flex flex-col gap-1 p-2 rounded-md border border-slate-100 bg-white/60">
                    <div className="text-xs text-slate-600 font-mono break-all">{reason.error}</div>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </Stack>
      </Drawer>
      <div className="monitor-card group relative flex flex-col gap-5 overflow-hidden rounded-[1.75rem] border border-slate-200/80 bg-white/80 p-4 shadow-[0_18px_55px_rgba(15,23,42,0.08)] backdrop-blur transition-all duration-300 hover:-translate-y-0.5 hover:bg-white hover:shadow-[0_24px_70px_rgba(15,23,42,0.12)]">
        {/* Preview Image Area */}
        <div className="overflow-hidden rounded-[1.15rem] border border-slate-200/65 bg-slate-100">
          <div className="flex h-8 items-center gap-1.5 border-b border-slate-200/60 bg-white/70 px-3" aria-hidden="true">
            <span className="h-1.5 w-1.5 rounded-full bg-slate-300" />
            <span className="h-1.5 w-1.5 rounded-full bg-slate-300" />
            <span className="h-1.5 w-1.5 rounded-full bg-slate-300" />
            <span className="ml-2 truncate font-mono text-[9px] tracking-wide text-slate-400">{targetLabel}</span>
          </div>
          <div className="relative aspect-video w-full overflow-hidden">
            {previewUrl ? (
              <a href={monitor.statusPageLink} target="_blank" rel="noopener noreferrer" className="block h-full w-full">
                <Image
                  src={previewUrl}
                  alt={monitor.name}
                  fill
                  sizes="(min-width: 1280px) 380px, (min-width: 768px) 45vw, 90vw"
                  className="h-full w-full origin-top object-cover object-top transition-transform duration-700 group-hover:scale-105"
                />
              </a>
            ) : (
              <div className="flex h-full w-full items-center justify-center text-slate-300">
                <IconCloud size={56} stroke={1.2} />
              </div>
            )}
          </div>

          {/* Status Badge */}
          <div className="absolute right-7 top-16">
            <div
              className={`
              flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium shadow-sm backdrop-blur
              ${
                status === 'maintenance'
                  ? 'border-amber-200 bg-amber-50 text-amber-700'
                  : status === 'up'
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                  : status === 'pending'
                  ? 'border-slate-200 bg-slate-50 text-slate-600'
                  : 'border-rose-200 bg-rose-50 text-rose-700'
              }
            `}
            >
              <div
                className={`h-2 w-2 rounded-full ${statusDotClass}`}
              />
              {statusLabel}
            </div>
          </div>

        </div>
        <div className="flex min-h-12 items-start justify-between gap-3 px-1">
          <div className="min-w-0">
            <h3 className="truncate text-lg font-semibold tracking-[-0.025em] text-slate-800">{monitor.name}</h3>
            {targetLabel && <div className="mt-1 truncate text-[11px] font-mono text-slate-500">{targetLabel}</div>}
          </div>
          {monitor.group && <span className="shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-semibold text-slate-500">{monitor.group}</span>}
        </div>
        {/* Uptime Bars */}
        <div className="flex flex-col gap-2">
          <div className="flex justify-between text-xs font-medium text-slate-500">
            <span>近 30 天</span>
            <span className="font-mono text-slate-700">{totalPercent}<span className="ml-0.5 text-slate-400">%</span></span>
          </div>
          <div className="flex h-6 items-end justify-between gap-[3px]">
            {uptimeBars}
          </div>
        </div>

        {/* Footer */}
        <div className="mt-auto flex items-center justify-between border-t border-slate-100 pt-4 text-xs font-medium text-slate-500">
          <div className="flex items-center gap-1.5">
            <div
              className={`h-2.5 w-2.5 rounded-full ${statusDotClass}`}
            />
            <span>{statusLabel}</span>
            {status !== 'pending' && <span className="text-slate-400">{timeInfo} 前</span>}
          </div>
          <div className="flex items-center gap-1 rounded-xl bg-slate-100 px-2 py-1">
            <span
              className={`font-bold font-mono ${
                lastLatency && lastLatency > 500
                  ? 'text-amber-600'
                  : 'text-slate-700'
              }`}
            >
              {lastLatency ? `${lastLatency}ms` : '-'}
            </span>
          </div>
        </div>
      </div>
    </>
  )
}
