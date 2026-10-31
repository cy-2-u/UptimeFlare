import type { MonitorTarget, Notification } from '../../types/config'
import { maintenances, workerConfig } from '../../uptime.config'
import type { PendingNotice } from './stateops'

export function shouldSendNotification() {
  return true
}

// 通知区域修改开始
const WEBHOOK_URL = 'https://api.chuckfang.com/%E7%AC%AC%E4%BA%94%E4%B8%AA%E5%AD%A3%E8%8A%82'
const WEBHOOK_TIMEOUT_MS = 10000
const WEBHOOK_HEADERS: Record<string, string> = {}

function buildNotificationMessage({
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
}) {
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
    return `🟢 [${monitor.name}] 已恢复正常。\n服务自 ${timeNowFormatted} 起恢复可用，本次中断持续 ${downtimeMinutes} 分钟。`
  }

  if (timeNow === timeIncidentStart) {
    return `🔴 [${monitor.name}] 已宕机。\n服务自 ${timeNowFormatted} 起不可用。\n原因: ${reason || '未说明'}`
  }

  return `🔴 [${monitor.name}] 依然宕机。\n服务自 ${timeIncidentStartFormatted} 起不可用 (已持续 ${downtimeMinutes} 分钟)。\n原因: ${reason || '未说明'}`
}

function buildWebhookBody(message: string) {
  return {
    msg: message,
  }
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

  const message = buildNotificationMessage({
    ...context,
    timeZone: workerConfig.notification?.timeZone ?? 'Etc/GMT',
  })
  const body = buildWebhookBody(message)

  try {
    const response = await fetchWithTimeout(WEBHOOK_URL, WEBHOOK_TIMEOUT_MS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...WEBHOOK_HEADERS },
      body: JSON.stringify(body),
    })

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
    .filter((m) => nowMs >= new Date(m.start).getTime() && (!m.end || nowMs <= new Date(m.end).getTime()))
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
