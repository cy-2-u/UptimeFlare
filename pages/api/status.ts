import type { NextRequest } from 'next/server'
import type { RuntimeEnv } from '@/util/runtimeConfig'
import { readCompactedStateStr } from '@/util/stateReader'

export const runtime = 'edge'

// Full compacted state for the client-side refresh loop. Same origin check as
// the upstream project, but the payload itself is public data, so it caches
// at the edge for a minute.
export default async function handler(req: NextRequest) {
  const host = req.headers.get('host')
  const origin = req.headers.get('origin')
  const referer = req.headers.get('referer')

  let isAllowed = (_url: string | null) => false

  if (host) {
    const parts = host.split(':')[0].split('.')
    let rootDomain = host.split(':')[0]
    if (parts.length > 2 && !/^\d+\.\d+\.\d+\.\d+$/.test(rootDomain)) {
      rootDomain = parts.slice(1).join('.')
    }

    isAllowed = (url: string | null) => {
      if (!url) return false
      try {
        const urlObj = new URL(url)
        return urlObj.hostname === rootDomain || urlObj.hostname.endsWith('.' + rootDomain)
      } catch {
        return false
      }
    }
  }

  const corsHeaders: Record<string, string> = {
    'content-type': 'application/json',
    'cache-control': 'public, s-maxage=60, stale-while-revalidate=300',
  }

  if (origin && isAllowed(origin)) {
    corsHeaders['Access-Control-Allow-Origin'] = origin
    corsHeaders['Access-Control-Allow-Methods'] = 'GET, OPTIONS'
  }

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  if (origin && !isAllowed(origin)) {
    return new Response('Forbidden: Origin not allowed', { status: 403 })
  }
  if (referer && !isAllowed(referer)) {
    return new Response('Forbidden: Referer not allowed', { status: 403 })
  }

  try {
    const env = process.env as unknown as RuntimeEnv
    const compactedStateStr = await readCompactedStateStr(env)
    return new Response(JSON.stringify({ compactedStateStr }), {
      status: 200,
      headers: corsHeaders,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to read status'
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    })
  }
}
