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
  const text = await res.text()
  const colo = /^colo=(.*)$/m.exec(text)?.[1]
  if (colo) cachedColo = colo
  return colo
}

export const fetchTimeout = (
  url: string,
  ms: number,
  { signal, ...options }: RequestInit<RequestInitCfProperties> | undefined = {}
): Promise<Response> => {
  const controller = new AbortController()
  const promise = fetch(url, { signal: controller.signal, ...options })
  if (signal) signal.addEventListener('abort', () => controller.abort())
  const timeout = setTimeout(() => controller.abort(), ms)
  return promise.finally(() => clearTimeout(timeout))
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
