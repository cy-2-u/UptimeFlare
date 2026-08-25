import { maintenances } from '@/uptime.config'
import { NextRequest } from 'next/server'
import { CompactedMonitorStateWrapper, getFromStore } from '@/worker/src/store'
import { getEffectiveWorkerConfig, RuntimeEnv } from '@/util/runtimeConfig'

export const runtime = 'edge'

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'public, s-maxage=540, stale-while-revalidate=540',
}

export default async function handler(req: NextRequest): Promise<Response> {
  const env = process.env as unknown as RuntimeEnv
  const compactedState = new CompactedMonitorStateWrapper(await getFromStore(env, 'state'))

  if (compactedState.data.lastUpdate === 0) {
    return new Response(JSON.stringify({ error: 'No data available' }), {
      status: 500,
      headers,
    })
  }

  const monitors: Record<
    string,
    {
      up: boolean | null
      latency: number | null
      location: string | null
      message: string
    }
  > = {}

  const workerConfig = await getEffectiveWorkerConfig(env)

  for (const monitor of workerConfig.monitors) {
    if (compactedState.incidentLen(monitor.id) === 0 || compactedState.latencyLen(monitor.id) === 0) {
      monitors[monitor.id] = {
        up: null,
        latency: null,
        location: null,
        message: 'Pending first check',
      }
      continue
    }

    const lastIncident = compactedState.getIncident(
      monitor.id,
      compactedState.incidentLen(monitor.id) - 1
    )

    const isUp = lastIncident?.end !== null
    const latency = compactedState.getLastLatency(monitor.id)
    monitors[monitor.id] = {
      up: isUp,
      latency: latency.ping,
      location: latency.loc,
      message: isUp ? 'OK' : lastIncident?.error[lastIncident.error.length - 1],
    }
  }

  const ret = {
    up: compactedState.data.overallUp,
    down: compactedState.data.overallDown,
    updatedAt: compactedState.data.lastUpdate,
    monitors,
    maintenances,
  }

  return new Response(JSON.stringify(ret), {
    headers,
  })
}
