#!/usr/bin/env node
// Generate worker/wrangler.deploy.toml from worker/wrangler.toml with the real
// resource ids injected. Replaces the old Python config generator without
// needing a full TOML parser: the source file is ours and its shape is stable.
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const workerDir = path.join(root, 'worker')
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

const databaseId = env('D1_ID')
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(databaseId)) {
  throw new Error('D1_ID must be a valid database UUID')
}

let config = await readFile(path.join(workerDir, 'wrangler.toml'), 'utf8')
config = config.replace(
  /(database_id = )"00000000-0000-0000-0000-000000000000"/,
  `$1"${databaseId}"`
)
if (!config.includes(`"${databaseId}"`)) {
  throw new Error('Failed to inject D1_ID into worker config')
}

// The KV binding is optional (only the one-time migrator reads it). Keep it
// while the legacy namespace exists; drop the whole block otherwise.
const KV_BLOCK_RE =
  /\n# Optional: only used once by the migrator[^\n]*\n# The deploy script omits[^\n]*\n\[\[kv_namespaces\]\]\nbinding = "UPTIMEFLARE_CONFIG"\nid = "[^"]*"\n/
const accountId = env('CLOUDFLARE_ACCOUNT_ID')
const namespaces = await api(`/accounts/${accountId}/storage/kv/namespaces?per_page=1000`)
const legacy = namespaces.find((ns) => ns.title === 'uptimeflare_config')

if (legacy) {
  config = config.replace(
    'id = "00000000000000000000000000000000"',
    `id = "${legacy.id}"`
  )
  console.log(`KV migration binding kept (${legacy.id}).`)
} else {
  config = config.replace(KV_BLOCK_RE, '\n')
  if (config.includes('00000000000000000000000000000000')) {
    throw new Error('KV namespace lookup failed and placeholder remains')
  }
  console.log('KV namespace not found; migration binding omitted.')
}

config += `\n[observability]\nenabled = true\n[observability.logs]\nenabled = true\ninvocation_logs = true\n`

await writeFile(path.join(workerDir, 'wrangler.deploy.toml'), config)
console.log('worker/wrangler.deploy.toml generated.')
