#!/usr/bin/env node
// Post-deploy smoke test: hit /health on the deployed worker. This also arms
// the Durable Object alarm right after a fresh deployment.
const API = 'https://api.cloudflare.com/client/v4'

const env = (key) => process.env[key]?.trim() ?? ''

async function api(pathname) {
  const response = await fetch(`${API}${pathname}`, {
    headers: { Authorization: `Bearer ${env('CLOUDFLARE_API_TOKEN')}` },
  })
  const body = await response.json()
  if (!body.success) {
    throw new Error(`Cloudflare API ${pathname} failed: ${JSON.stringify(body.errors)}`)
  }
  return body.result
}

const accountId = env('CLOUDFLARE_ACCOUNT_ID')
const { subdomain } = await api(`/accounts/${accountId}/workers/subdomain`)
if (!subdomain) throw new Error('Could not resolve workers.dev subdomain')

const url = `https://uptimeflare_worker.${subdomain}.workers.dev/health`
console.log(`Health check: ${url}`)

let lastError = null
for (let attempt = 1; attempt <= 5; attempt += 1) {
  try {
    const response = await fetch(url, { headers: { 'cache-control': 'no-store' } })
    const body = await response.json()
    if (!body.healthy) throw new Error(`health reported healthy=false: ${JSON.stringify(body)}`)
    console.log('Health check passed:', JSON.stringify(body))
    process.exit(0)
  } catch (error) {
    lastError = error
    console.log(`Attempt ${attempt} failed: ${error.message}`)
    if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 10_000))
  }
}

throw new Error(`Health check failed after 5 attempts: ${lastError}`)
