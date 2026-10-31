let cachedColo: string | undefined

function coloFromRequest(request?: Request): string | undefined {
  const colo = request?.cf?.colo
  return typeof colo === 'string' && colo ? colo : undefined
}

async function getWorkerLocation(request?: Request) {
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

const fetchTimeout = (
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

function withTimeout<T>(millis: number, promise: Promise<T>): Promise<T> {
  const timeout = new Promise<T>((resolve, reject) =>
    setTimeout(() => reject(new Error(`Promise timed out after ${millis}ms`)), millis)
  )

  return Promise.race([promise, timeout])
}

export { fetchTimeout, getWorkerLocation, withTimeout }
