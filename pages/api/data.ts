import { maintenances } from '@/uptime.config'
import type { NextRequest } from 'next/server'
import type { RuntimeEnv } from '@/util/runtimeConfig'
import { getEffectiveWorkerConfig } from '@/util/runtimeConfig'
import { readStateSummary } from '@/util/stateReader'

export const runtime = 'edge'

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
}

export default async function handler(req: NextRequest): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers })
  }
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers })
  }

  const env = process.env as unknown as RuntimeEnv
  const summary = await readStateSummary(env)

  if (!summary || summary.meta.lastUpdate === 0) {
    return new Response(JSON.stringify({ error: 'No data available' }), { status: 503, headers })
  }

  const monitors: Record<
    string,
    { up: boolean | null; latency: number | null; location: string | null; message: string }
  > = {}

  const workerConfig = await getEffectiveWorkerConfig(env)
  for (const monitor of workerConfig.monitors) {
    monitors[monitor.id] =
      summary.summaries[monitor.id] ?? {
        up: null,
        latency: null,
        location: null,
        message: 'Pending first check',
      }
  }

  return new Response(
    JSON.stringify({
      up: summary.meta.overallUp,
      down: summary.meta.overallDown,
      updatedAt: summary.meta.lastUpdate,
      monitors,
      maintenances,
    }),
    { headers }
  )
}
