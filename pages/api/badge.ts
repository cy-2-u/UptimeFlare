import type { NextRequest } from 'next/server'
import { latencyKey, type LatencyRow } from '@/lib/state-format'
import { getRuntimeValue, type RuntimeEnv } from '@/util/runtimeConfig'

export const runtime = 'edge'

type BadgePayload = {
  schemaVersion: 1
  label: string
  message: string
  color: string
  isError?: boolean
}

const jsonHeaders = {
  'Content-Type': 'application/json',
  'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
}

function errorBadge(label: string, message: string): BadgePayload {
  return {
    schemaVersion: 1,
    label,
    message,
    color: 'lightgrey',
    isError: true,
  }
}

// Shields.io-style badge endpoint. Reads only the monitor's latency row.
export default async function handler(req: NextRequest): Promise<Response> {
  try {
    const url = new URL(req.url)

    const monitorId = url.searchParams.get('id')
    const label = url.searchParams.get('label') ?? monitorId ?? 'status'
    const upMsg = url.searchParams.get('up') ?? 'UP'
    const downMsg = url.searchParams.get('down') ?? 'DOWN'
    const colorUp = url.searchParams.get('colorUp') ?? 'brightgreen'
    const colorDown = url.searchParams.get('colorDown') ?? 'red'

    if (!monitorId) {
      return new Response(JSON.stringify(errorBadge(label, 'no-monitor')), {
        headers: jsonHeaders,
        status: 400,
      })
    }

    const env = process.env as unknown as RuntimeEnv
    const raw = await getRuntimeValue(env, latencyKey(monitorId))

    let isUp: boolean | null = null
    if (raw !== null) {
      const row = JSON.parse(raw) as LatencyRow
      isUp = row.lastStatus === null ? null : row.lastStatus === 'up'
    }

    const badge: BadgePayload = {
      schemaVersion: 1,
      label,
      message: isUp === null ? 'pending' : isUp ? upMsg : downMsg,
      color: isUp === null ? 'lightgrey' : isUp ? colorUp : colorDown,
    }

    return new Response(JSON.stringify(badge), { headers: jsonHeaders })
  } catch (error) {
    console.error('Error rendering badge API:', error)
    return new Response(JSON.stringify(errorBadge('status', 'error')), {
      headers: jsonHeaders,
      status: 500,
    })
  }
}
