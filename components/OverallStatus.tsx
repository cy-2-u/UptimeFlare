import { MaintenanceConfig, MonitorState, MonitorTarget } from '@/types/config'
import { Collapse, Button } from '@mantine/core'
import { IconCheck, IconX, IconAlertCircle, IconActivity, IconHistory } from '@tabler/icons-react'
import { useState } from 'react'
import MaintenanceAlert from './MaintenanceAlert'
import IncidentsDrawer from './IncidentsDrawer'
import { useTranslation } from 'react-i18next'
import { pageConfig } from '@/uptime.config'

export default function OverallStatus({
  state,
  maintenances,
  monitors,
}: {
  state: MonitorState
  maintenances: MaintenanceConfig[]
  monitors: MonitorTarget[]
}) {
  const { t } = useTranslation('common')

  let statusString = ''
  let statusColor = 'text-stone-500'
  let statusTone = 'bg-stone-950'
  let StatusIcon = IconAlertCircle

  if (state.overallUp === 0 && state.overallDown === 0) {
    statusString = t('No data yet')
    statusColor = 'text-stone-500'
  } else if (state.overallUp === 0) {
    statusString = t('All systems not operational')
    statusColor = 'text-rose-700'
    statusTone = 'bg-rose-600'
    StatusIcon = IconX
  } else if (state.overallDown === 0) {
    statusString = t('All systems operational')
    statusColor = 'text-emerald-700'
    statusTone = 'bg-emerald-600'
    StatusIcon = IconCheck
  } else {
    statusString = t('Some systems not operational', {
      down: state.overallDown,
      total: state.overallUp + state.overallDown,
    })
    statusColor = 'text-amber-700'
    statusTone = 'bg-amber-500'
  }

  const totalMonitors = state.overallUp + state.overallDown
  const uptimeTone = state.overallDown === 0 && totalMonitors > 0 ? 'text-emerald-700' : statusColor

  const [expandUpcoming, setExpandUpcoming] = useState(false)
  const [drawerOpened, setDrawerOpened] = useState(false)

  const now = new Date()

  const activeMaintenances: (Omit<MaintenanceConfig, 'monitors'> & {
    monitors?: MonitorTarget[]
  })[] = maintenances
    .filter((m) => now >= new Date(m.start) && (!m.end || now <= new Date(m.end)))
    .map((maintenance) => ({
      ...maintenance,
      monitors: maintenance.monitors?.map(
        (monitorId) => monitors.find((mon) => monitorId === mon.id)!
      ),
    }))

  const upcomingMaintenances: (Omit<MaintenanceConfig, 'monitors'> & {
    monitors?: (MonitorTarget | undefined)[]
  })[] = maintenances
    .filter((m) => now < new Date(m.start))
    .map((maintenance) => ({
      ...maintenance,
      monitors: maintenance.monitors?.map(
        (monitorId) => monitors.find((mon) => monitorId === mon.id)!
      ),
    }))

  return (
    <div className="py-12 sm:py-16 lg:py-20">
      <div className="grid items-center gap-9 lg:grid-cols-[1fr_25rem] lg:gap-16">
        <div className="hero-enter text-left">
          <div className="mb-7 inline-flex items-center gap-3 rounded-full border border-white bg-white/65 px-4 py-2 text-xs font-medium text-slate-500 shadow-[0_2px_12px_rgba(15,23,42,0.025)] backdrop-blur">
            <span className={`status-pulse h-2.5 w-2.5 rounded-full ${statusTone}`} />
            <span>每 10 分钟检查</span>
          </div>
          <h1 className="hero-title max-w-3xl text-5xl font-semibold tracking-[-0.055em] sm:text-7xl">
            {pageConfig.title || '服务状态'}
          </h1>
          <div className={`mt-6 flex items-center gap-2.5 text-base font-medium ${statusColor}`}>
            <StatusIcon size={19} stroke={2} />
            <span>{statusString}</span>
          </div>
          <div className="mt-9 flex flex-wrap gap-3">
            <Button
              variant="default"
              size="sm"
              leftSection={<IconHistory size={15} />}
              onClick={() => setDrawerOpened(true)}
              styles={{ root: { borderRadius: 12, borderColor: '#ffffff', color: '#475569', background: 'rgba(255,255,255,.6)', boxShadow: '0 4px 16px rgba(15,23,42,.035)' } }}
            >
              {t('Incidents')}
            </Button>
          </div>
        </div>

        <div className="status-summary hero-enter rounded-[2rem] border border-white/90 bg-white/65 p-7 shadow-[0_16px_64px_-20px_rgba(15,75,80,0.18)] backdrop-blur-xl">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium tracking-wide text-slate-500">运行概况</span>
            <span className={`status-emblem ${statusColor}`} aria-hidden="true"><StatusIcon stroke={1.8} size={22} /></span>
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
              {t('Last updated on', {
                date: new Date(state.lastUpdate * 1000).toLocaleString(),
              })}
            </span>
          </div>
        </div>
      </div>

      {/* Upcoming Maintenance */}
      {upcomingMaintenances.length > 0 && (
        <div className="mx-auto mt-8 max-w-3xl text-center">
          <div
            className="mb-2 cursor-pointer text-stone-500 hover:underline"
            onClick={() => setExpandUpcoming(!expandUpcoming)}
          >
            {t('upcoming maintenance', { count: upcomingMaintenances.length })}{' '}
            <span>{expandUpcoming ? t('Hide') : t('Show')}</span>
          </div>

          <Collapse in={expandUpcoming}>
            {upcomingMaintenances.map((maintenance, idx) => (
              <MaintenanceAlert
                key={`upcoming-${idx}`}
                maintenance={maintenance}
                style={{ marginTop: 10 }}
                upcoming
              />
            ))}
          </Collapse>
        </div>
      )}

      {/* Active Maintenance */}
      <div className="mx-auto mt-8 max-w-3xl">
        {activeMaintenances.map((maintenance, idx) => (
          <MaintenanceAlert
            key={`active-${idx}`}
            maintenance={maintenance}
            style={{ marginTop: 10 }}
          />
        ))}
      </div>

      {/* Incidents Drawer */}
      <IncidentsDrawer
        opened={drawerOpened}
        onClose={() => setDrawerOpened(false)}
        state={state}
        monitors={monitors}
      />
    </div>
  )
}
