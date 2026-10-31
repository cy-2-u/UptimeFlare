import { MaintenanceConfig, MonitorTarget } from '@/types/config'
import { IconAlertTriangle, IconCalendar, IconClock } from '@tabler/icons-react'

const colorSchemes: Record<string, { bg: string; border: string; icon: string; text: string; badge: string }> = {
  yellow: {
    bg: 'bg-amber-50',
    border: 'border-l-amber-500',
    icon: 'text-amber-500',
    text: 'text-amber-600',
    badge: 'bg-amber-100 text-amber-600',
  },
  blue: {
    bg: 'bg-blue-50',
    border: 'border-l-blue-500',
    icon: 'text-blue-500',
    text: 'text-blue-600',
    badge: 'bg-blue-100 text-blue-600',
  },
  red: {
    bg: 'bg-red-50',
    border: 'border-l-red-500',
    icon: 'text-red-500',
    text: 'text-red-600',
    badge: 'bg-red-100 text-red-600',
  },
  gray: {
    bg: 'bg-gray-50',
    border: 'border-l-gray-400',
    icon: 'text-gray-500',
    text: 'text-gray-600',
    badge: 'bg-gray-100 text-gray-600',
  },
}

export default function MaintenanceAlert({
  maintenance,
  upcoming = false,
  className = '',
}: {
  maintenance: Omit<MaintenanceConfig, 'monitors'> & { monitors?: (MonitorTarget | undefined)[] }
  upcoming?: boolean
  className?: string
}) {
  const scheme = colorSchemes[(upcoming ? 'blue' : maintenance.color) || 'yellow'] ?? colorSchemes.yellow

  const formatTime = (value: number | string) =>
    new Date(value).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })

  return (
    <div
      className={`${scheme.bg} ${scheme.border} rounded-2xl border border-slate-200/80 border-l-4 px-4 py-3 shadow-sm ${className}`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <IconAlertTriangle className={`${scheme.icon} shrink-0`} size={18} strokeWidth={2} />
        <span className={`shrink-0 text-sm font-bold ${scheme.text}`}>
          {upcoming ? '预告 · ' : ''}
          {maintenance.title || '计划维护'}
        </span>
        <span className="flex items-center gap-1 text-xs text-slate-500">
          <IconCalendar size={13} />
          {formatTime(maintenance.start)}
          {maintenance.end && (
            <>
              <span className="text-slate-300">→</span>
              <IconClock size={13} />
              {formatTime(maintenance.end)}
            </>
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-slate-500">{maintenance.body}</span>
        {maintenance.monitors && maintenance.monitors.length > 0 && (
          <span className="flex flex-wrap items-center gap-1.5">
            {maintenance.monitors.map((monitor, index) => (
              <span
                key={index}
                className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${scheme.badge}`}
              >
                <span className="h-1.5 w-1.5 rounded-full bg-current" />
                {monitor?.name ?? '未知站点'}
              </span>
            ))}
          </span>
        )}
      </div>
    </div>
  )
}
