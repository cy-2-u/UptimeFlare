#!/usr/bin/env node
// Runs after the health check, i.e. after the one-time migration has executed.
// Removes the legacy KV namespace (uptimeflare_config) once nothing needs it:
//   - D1 meta row exists  -> the state migration completed
//   - D1 admin_credentials exists (or KV holds no credentials)
//     -> the credential copy is done or was never needed
// If any guard fails, the namespace is kept and the script exits 0 — cleanup
// is opportunistic, the next deploy retries it.
const API = 'https://api.cloudflare.com/client/v4'
const KV_TITLE = 'uptimeflare_config'

const env = (key) => process.env[key]?.trim() ?? ''

function headers(extra = {}) {
  return {
    Authorization: `Bearer ${env('CLOUDFLARE_API_TOKEN')}`,
    'Content-Type': 'application/json',
    ...extra,
  }
}

async function api(pathname, init = {}) {
  const response = await fetch(`${API}${pathname}`, { ...init, headers: headers(init.headers) })
  const body = await response.json()
  if (!body.success) {
    throw new Error(`Cloudflare API ${pathname} failed: ${JSON.stringify(body.errors)}`)
  }
  return body.result
}

async function d1Value(databaseId, key) {
  const result = await api(`/accounts/${env('CLOUDFLARE_ACCOUNT_ID')}/d1/database/${databaseId}/query`, {
    method: 'POST',
    body: JSON.stringify({ sql: 'SELECT value FROM uptimeflare WHERE key = ?', params: [key] }),
  })
  return result[0]?.results?.[0]?.value ?? null
}

const accountId = env('CLOUDFLARE_ACCOUNT_ID')
const databaseId = env('D1_ID')
if (!accountId || !databaseId) throw new Error('CLOUDFLARE_ACCOUNT_ID / D1_ID missing')

// api() already resolves to the response body's `result` field.
const namespaces = await api(`/accounts/${accountId}/storage/kv/namespaces?per_page=1000`)
const legacy = namespaces.find((ns) => ns.title === KV_TITLE)
if (!legacy) {
  console.log('Legacy KV namespace not found; nothing to clean up.')
  process.exit(0)
}

if ((await d1Value(databaseId, 'state:meta')) === null) {
  console.log('D1 meta row missing (migration has not run); keeping KV namespace.')
  process.exit(0)
}

if ((await d1Value(databaseId, 'admin_credentials')) === null) {
  console.log('D1 admin credentials missing; keeping KV namespace as credential source.')
  process.exit(0)
}

await api(`/accounts/${accountId}/storage/kv/namespaces/${legacy.id}`, { method: 'DELETE' })
console.log(`Legacy KV namespace ${KV_TITLE} (${legacy.id}) deleted.`)
