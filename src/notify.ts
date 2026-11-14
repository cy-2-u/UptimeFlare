import { push } from './config'
import { activeMaintenance } from './monitor'
import type { Notice, Runtime, Settings } from './types'

export function message(notice: Notice, timeZone: string) {
  const format = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone })
  const time = format.format(new Date(notice.time * 1000))
  const start = format.format(new Date(notice.start * 1000))
  const minutes = Math.round((notice.time - notice.start) / 60)
  return notice.up
    ? { title: `🟢 [${notice.monitor.name}] 已恢复`, body: `服务自 ${time} 起恢复可用，本次中断持续 ${minutes} 分钟。` }
    : { title: `🔴 [${notice.monitor.name}] ${notice.first ? '已宕机' : '依然宕机'}`, body: `服务自 ${start} 起不可用（已持续 ${minutes} 分钟）。\n原因: ${notice.reason}` }
}
export async function notify(notice: Notice, config: Settings, runtime: Runtime) {
  if (config.notification.skipNotificationIds.includes(notice.monitor.id) || activeMaintenance(config, notice.monitor.id, notice.time * 1000)) return
  const { title, body } = message(notice, config.notification.timeZone)
  const params = new URLSearchParams({ icon: push.icon, group: push.group, ttl: push.ttl, sound: push.sound })
  const response = await runtime.fetch(`${push.url}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?${params}`, { signal: AbortSignal.timeout(10000), redirect: 'manual' })
  await response.body?.cancel()
  if (!response.ok) throw Error(`Notification HTTP ${response.status}`)
}
