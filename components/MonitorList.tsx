import { MonitorTarget, MonitorState } from '@/types/config'
import { IconServer, IconApps, IconDeviceDesktop, IconCloud } from '@tabler/icons-react'
import MonitorCard from './MonitorCard'

import { pageConfig } from '@/uptime.config'

export default function MonitorList({
  monitors,
  state,
}: {
  monitors: MonitorTarget[]
  state: MonitorState
}) {
  const monitorMap = new Map(monitors.map((m) => [m.id, m]))
  const processedIds = new Set<string>()

  const sortedGroups: string[] = []
  const groupedMonitors: Record<string, MonitorTarget[]> = {}

  if (pageConfig.group) {
    for (const [groupName, monitorIds] of Object.entries(pageConfig.group)) {
      const groupMonitors: MonitorTarget[] = []
      monitorIds.forEach((id) => {
        const monitor = monitorMap.get(id)
        if (monitor) {
          groupMonitors.push(monitor)
          processedIds.add(id)
        }
      })

      if (groupName === '核心服务' || groupMonitors.length > 0) {
        sortedGroups.push(groupName)
        groupedMonitors[groupName] = groupMonitors
      }
    }
  }

  const runtimeMonitors = monitors.filter((monitor) => !processedIds.has(monitor.id))
  for (const monitor of runtimeMonitors) {
    const groupName = monitor.group || '核心服务'
    if (!groupedMonitors[groupName]) {
      sortedGroups.push(groupName)
      groupedMonitors[groupName] = []
    }
    groupedMonitors[groupName].push(monitor)
  }

  // Helper to get icon for group
  const getGroupIcon = (groupName: string) => {
    if (groupName.includes('基础')) return IconServer
    if (groupName.includes('AI')) return IconCloud
    if (groupName.includes('工具')) return IconApps
    return IconDeviceDesktop
  }

  return (
    <div className="space-y-10">
      {sortedGroups.map((group) => {
        const GroupIcon = getGroupIcon(group)
        return (
          <div key={group}>
            <div className="mb-5">
              <div className="flex items-center gap-3">
                <div className="group-mark flex h-10 w-10 items-center justify-center rounded-2xl border border-slate-200 bg-white text-slate-700 shadow-sm">
                  <GroupIcon size={20} />
                </div>
                <div>
                  <h2 className="text-2xl font-semibold tracking-[-0.035em] text-slate-950">
                    {group}
                  </h2>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
              {groupedMonitors[group].map((monitor) => (
                <MonitorCard key={monitor.id} monitor={monitor} state={state} />
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
