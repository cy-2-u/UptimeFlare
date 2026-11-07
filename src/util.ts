let cachedColo: string | undefined

function coloFromRequest(request?: Request): string | undefined {
  const colo = request?.cf?.colo
  return typeof colo === 'string' && colo ? colo : undefined
}

export async function getWorkerLocation(request?: Request): Promise<string | undefined> {
  const fromRequest = coloFromRequest(request)
  if (fromRequest) {
    cachedColo = fromRequest
    return fromRequest
  }
  if (cachedColo) return cachedColo

  const res = await fetch('https://cloudflare.com/cdn-cgi/trace')
  const colo = /^colo=(.*)$/m.exec(await res.text())?.[1]
  if (colo) cachedColo = colo
  return colo
}

export const fetchTimeout = (
  url: string,
  ms: number,
  options: RequestInit<RequestInitCfProperties> = {}
): Promise<Response> => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), ms)
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timeout))
}

// Hostname of a monitor target for display; falls back to the raw string
// when the target is not a parseable URL.
export function hostnameOf(target: string): string {
  try {
    return new URL(target).hostname
  } catch {
    return target.split('/')[0]
  }
}

// Serialize overlapping runs/mutations inside one Durable Object.
export class RunCoordinator {
  private pending: Promise<void> | null = null
  private tail: Promise<void> = Promise.resolve()

  run(run: () => Promise<void>): Promise<void> {
    if (this.pending) return this.pending
    const task = this.tail.then(run)
    this.pending = task
    task
      .finally(() => {
        if (this.pending === task) this.pending = null
      })
      .catch(() => undefined)
    this.tail = task.catch(() => undefined)
    return task
  }

  mutate<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task)
    this.tail = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }
}
