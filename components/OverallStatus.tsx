'use client'

import { IconActivity, IconCheck, IconHistory, IconX } from '@tabler/icons-react'
import { useState } from 'react'
import { MaintenanceConfig, MonitorState, MonitorTarget } from '@/types/config'
import { maintenances, pageConfig } from '@/uptime.config'
import IncidentsDrawer from './IncidentsDrawer'
import MaintenanceAlert from './MaintenanceAlert'
import { Button, Collapse, useNow } from './ui'

export default function OverallStatus({
  state,
  monitors,
}: {
  state: MonitorState
  monitors: MonitorTarget[]
}) {
  const now = useNow(60_000, state.lastUpdate * 1000)
  const [drawerOpened, setDrawerOpened] = useState(false)
  const [expandUpcoming, setExpandUpcoming] = useState(false)

  let statusString = ''
  let statusColor = 'text-slate-500'
  let statusTone = 'bg-slate-400'
  let StatusIcon = IconActivity

  if (state.overallUp === 0 && state.overallDown === 0) {
    statusString = '暂无监测数据'
  } else if (state.overallUp === 0) {
    statusString = '全部服务不可用'
    statusColor = 'text-rose-700'
    statusTone = 'bg-rose-600'
    StatusIcon = IconX
  } else if (state.overallDown === 0) {
    statusString = '全部服务运行正常'
    statusColor = 'text-emerald-700'
    statusTone = 'bg-emerald-600'
    StatusIcon = IconCheck
  } else {
    statusString = `${state.overallDown} / ${state.overallUp + state.overallDown} 个服务出现故障`
    statusColor = 'text-amber-700'
    statusTone = 'bg-amber-500'
  }

  const totalMonitors = state.overallUp + state.overallDown
  const uptimeTone = state.overallDown === 0 && totalMonitors > 0 ? 'text-emerald-700' : statusColor

  const activeMaintenances = maintenances
    .filter((m) => now >= new Date(m.start).getTime() && (!m.end || now <= new Date(m.end).getTime()))
    .map((maintenance: MaintenanceConfig) => ({
      ...maintenance,
      monitors: maintenance.monitors?.map((id) => monitors.find((monitor) => monitor.id === id)),
    }))

  const upcomingMaintenances = maintenances
    .filter((m) => now < new Date(m.start).getTime())
    .map((maintenance: MaintenanceConfig) => ({
      ...maintenance,
      monitors: maintenance.monitors?.map((id) => monitors.find((monitor) => monitor.id === id)),
    }))

  return (
    <div className="py-12 sm:py-16 lg:py-20">
      <div className="grid items-center gap-9 lg:grid-cols-[1fr_25rem] lg:gap-16">
        <div className="hero-enter text-left">
          <div className="mb-7 inline-flex items-center gap-3 rounded-full border border-white bg-white/65 px-4 py-2 text-xs font-medium text-slate-500 shadow-[0_2px_12px_rgba(15,23,42,0.025)] backdrop-blur">
            <span className={`status-pulse h-2.5 w-2.5 rounded-full ${statusTone}`} />
            <span>每 10 分钟检查一轮</span>
          </div>
          <h1 className="hero-title max-w-3xl text-5xl font-semibold tracking-[-0.055em] sm:text-7xl">
            {pageConfig.title || '服务状态'}
          </h1>
          <div className={`mt-6 flex items-center gap-2.5 text-base font-medium ${statusColor}`}>
            <StatusIcon size={19} stroke={2} />
            <span>{statusString}</span>
          </div>
          <div className="mt-9 flex flex-wrap gap-3">
            <Button variant="ghost" size="sm" onClick={() => setDrawerOpened(true)}>
              <IconHistory size={15} />
              历史故障
            </Button>
          </div>
        </div>

        <div className="status-summary hero-enter rounded-[2rem] border border-white/90 bg-white/65 p-7 shadow-[0_16px_64px_-20px_rgba(15,75,80,0.18)] backdrop-blur-xl">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium tracking-wide text-slate-500">运行概况</span>
            <span className={`status-emblem ${statusColor}`} aria-hidden="true">
              <StatusIcon stroke={1.8} size={22} />
            </span>
          </div>
          <div className="relative z-10 mt-4 grid grid-cols-2 divide-x divide-slate-200/60">
            <div>
              <div className={`text-6xl font-light tabular-nums tracking-[-0.06em] ${uptimeTone}`}>
                {state.overallUp}
              </div>
              <div className="mt-3 text-xs text-slate-500">在线服务</div>
            </div>
            <div className="pl-7">
              <div className="text-6xl font-light tabular-nums tracking-[-0.06em] text-slate-700">
                {totalMonitors}
              </div>
              <div className="mt-3 text-xs text-slate-500">监测总数</div>
            </div>
          </div>
          <div className="relative z-10 mt-7 flex items-start gap-2 border-t border-slate-200/60 pt-4 text-[11px] text-slate-400">
            <IconActivity className="mt-0.5 shrink-0" size={15} />
            <span>
              数据更新于{' '}
              {state.lastUpdate ? new Date(state.lastUpdate * 1000).toLocaleString('zh-CN', { hour12: false }) : '—'}
            </span>
          </div>
        </div>
      </div>

      {upcomingMaintenances.length > 0 && (
        <div className="mx-auto mt-8 max-w-3xl text-center">
          <button
            type="button"
            onClick={() => setExpandUpcoming(!expandUpcoming)}
            className="text-sm text-slate-500 transition hover:text-slate-800"
          >
            {upcomingMaintenances.length} 个即将进行的维护
            {expandUpcoming ? '（收起）' : '（展开）'}
          </button>
          <Collapse open={expandUpcoming}>
            <div className="mt-3 space-y-3">
              {upcomingMaintenances.map((maintenance, index) => (
                <MaintenanceAlert key={`upcoming-${index}`} maintenance={maintenance} upcoming />
              ))}
            </div>
          </Collapse>
        </div>
      )}

      <div className="mx-auto mt-8 max-w-3xl space-y-3">
        {activeMaintenances.map((maintenance, index) => (
          <MaintenanceAlert key={`active-${index}`} maintenance={maintenance} />
        ))}
      </div>

      <IncidentsDrawer
        opened={drawerOpened}
        onClose={() => setDrawerOpened(false)}
        state={state}
        monitors={monitors}
      />
    </div>
  )
}
