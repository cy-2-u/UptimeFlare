import type { MonitorTarget, RuntimeBindings } from '../types/config'

export class SchedulerError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message)
  }
}

export async function schedulerMonitors(
  env: RuntimeBindings,
  method: 'GET' | 'POST' | 'DELETE' = 'GET',
  body?: MonitorTarget | { id: string }
): Promise<MonitorTarget[]> {
  const namespace = env.MONITOR_SCHEDULER_DO
  if (!namespace) throw new Error('MONITOR_SCHEDULER_DO binding is missing')
  const response = await namespace
    .get(namespace.idFromName('default'))
    .fetch('https://scheduler/monitors', {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  const result = await response.json<{ monitors?: MonitorTarget[]; error?: string }>()
  if (!response.ok || !result.monitors) {
    throw new SchedulerError(
      result.error || 'Scheduler request failed',
      response.ok ? 502 : response.status
    )
  }
  return result.monitors
}
