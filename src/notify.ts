import type { MonitorTarget, Notification } from './types'
import { maintenances, workerConfig } from './config'
import type { PendingNotice } from './stateops'

export function shouldSendNotification() {
  return true
}

// 通知区域修改开始
// 推送渠道：「及时通知」(timelynotify) —— GET {BASE}/{标题}/{正文}?icon=&group=&ttl=&sound=
// 标题/正文自动 URL 编码；换成任何同类 GET 推送服务只需改下面几个常量。
const PUSH_BASE_URL = 'https://timelynotify.oicode.cn/Nt5RQRHQ5Vg5fNHdJF54Z9'
const PUSH_TIMEOUT_MS = 10000
const PUSH_ICON = 'https://static.wallleap.cn/temp/nwvgnm7l2on5u6c531mo.jpg'
const PUSH_GROUP = '服务状态'
const PUSH_TTL_SEC = 600
const PUSH_SOUND = 'multiwayinvitation'

// 文案拆成「标题 + 正文」两段：标题短且带状态色，正文放细节。
export function buildNotificationMessage({
  monitor,
  isUp,
  timeIncidentStart,
  timeNow,
  reason,
  timeZone,
}: {
  monitor: MonitorTarget
  isUp: boolean
  timeIncidentStart: number
  timeNow: number
  reason: string
  timeZone: string
}): { title: string; body: string } {
  function formatTime(timestamp: number) {
    const parts = new Intl.DateTimeFormat('zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone,
    }).formatToParts(new Date(timestamp * 1000))

    const values = parts.reduce<Record<string, string>>((result, part) => {
      result[part.type] = part.value
      return result
    }, {})

    return `${values.month}/${values.day}, ${values.hour}:${values.minute}`
  }

  const downtimeMinutes = Math.round((timeNow - timeIncidentStart) / 60)
  const timeNowFormatted = formatTime(timeNow)
  const timeIncidentStartFormatted = formatTime(timeIncidentStart)

  if (isUp) {
    return {
      title: `🟢 [${monitor.name}] 已恢复`,
      body: `服务自 ${timeNowFormatted} 起恢复可用，本次中断持续 ${downtimeMinutes} 分钟。`,
    }
  }

  if (timeNow === timeIncidentStart) {
    return {
      title: `🔴 [${monitor.name}] 已宕机`,
      body: `服务自 ${timeNowFormatted} 起不可用。\n原因: ${reason || '未说明'}`,
    }
  }

  return {
    title: `🔴 [${monitor.name}] 依然宕机`,
    body: `服务自 ${timeIncidentStartFormatted} 起不可用 (已持续 ${downtimeMinutes} 分钟)。\n原因: ${reason || '未说明'}`,
  }
}

export function buildPushUrl(title: string, body: string): string {
  const params = new URLSearchParams()
  if (PUSH_ICON) params.set('icon', PUSH_ICON)
  if (PUSH_GROUP) params.set('group', PUSH_GROUP)
  if (PUSH_TTL_SEC > 0) params.set('ttl', String(PUSH_TTL_SEC))
  if (PUSH_SOUND) params.set('sound', PUSH_SOUND)
  return `${PUSH_BASE_URL}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?${params.toString()}`
}
// 通知区域修改结束

async function fetchWithTimeout(url: string, ms: number, options: RequestInit = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), ms)

  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

export async function sendNotification(context: {
  monitor: MonitorTarget
  isUp: boolean
  timeIncidentStart: number
  timeNow: number
  reason: string
}) {
  if (!shouldSendNotification()) {
    console.log(`Notification disabled, skipping ${context.monitor.name}`)
    return
  }

  const { title, body } = buildNotificationMessage({
    ...context,
    timeZone: workerConfig.notification?.timeZone ?? 'Etc/GMT',
  })
  const url = buildPushUrl(title, body)

  try {
    const response = await fetchWithTimeout(url, PUSH_TIMEOUT_MS, { method: 'GET' })

    if (!response.ok) {
      console.log(
        `Notification failed: ${response.status} ${response.statusText}, ${await response.text()}`
      )
      return
    }

    console.log(`Notification sent for ${context.monitor.name}`)
  } catch (error) {
    console.log('Notification request failed: ' + error)
  }
}

// Dispatch the notices collected during a round. Called only after the state
// commit succeeded, so notifications can never describe a state the page
// does not show.
export async function dispatchNotices(notices: PendingNotice[], notification?: Notification) {
  if (notices.length === 0) return

  const skipList = notification?.skipNotificationIds
  const nowMs = Date.now()
  const maintenanceMonitors = maintenances
    .filter(
      (m) => nowMs >= new Date(m.start).getTime() && (!m.end || nowMs <= new Date(m.end).getTime())
    )
    .map((e) => e.monitors || [])
    .flat()

  for (const notice of notices) {
    try {
      if (skipList && skipList.includes(notice.monitor.id)) {
        console.log(`Skipping notification for ${notice.monitor.name} (${notice.monitor.id} in skipNotificationIds)`)
        continue
      }

      if (maintenanceMonitors.includes(notice.monitor.id)) {
        console.log(`Skipping notification for ${notice.monitor.name} (in maintenance)`)
        continue
      }

      await sendNotification(notice)
    } catch (error) {
      console.log(`Notification dispatch failed for ${notice.monitor.name}: ` + error)
    }
  }
}
