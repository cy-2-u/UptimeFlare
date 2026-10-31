#!/usr/bin/env node
// Ensure the Pages project exists and configure its bindings. This replaces
// Terraform entirely: one idempotent API call, no state files, no import run.
import { fileURLToPath } from 'node:url'

const API = 'https://api.cloudflare.com/client/v4'
const PROJECT_NAME = 'uptimeflare'
const WORKER_NAME = 'uptimeflare_worker'
const DO_CLASS = 'MonitorScheduler'

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
  return body
}

const accountId = env('CLOUDFLARE_ACCOUNT_ID')
if (!accountId) throw new Error('CLOUDFLARE_ACCOUNT_ID is missing')
const databaseId = env('D1_ID')
if (!databaseId) throw new Error('D1_ID is missing (run storage-setup.mjs first)')

// 1. Ensure the project exists.
const projectResponse = await fetch(`${API}/accounts/${accountId}/pages/projects/${PROJECT_NAME}`, {
  headers: headers(),
})
const existingProject = await projectResponse.json()
if (!existingProject.success) {
  await api(`/accounts/${accountId}/pages/projects`, {
    method: 'POST',
    body: JSON.stringify({ name: PROJECT_NAME, production_branch: 'main' }),
  })
  console.log('Pages project created.')
} else {
  console.log('Pages project already exists.')
}

// 2. Resolve the MonitorScheduler DO namespace (uploaded by the wrangler step).
const { result: namespaces } = await api(
  `/accounts/${accountId}/workers/durable_objects/namespaces?per_page=1000`
)
const scheduler = namespaces.find(
  (ns) => ns.script === WORKER_NAME && ns.class === DO_CLASS
)
if (!scheduler) {
  throw new Error(`MonitorScheduler namespace not found for ${WORKER_NAME}`)
}

// 3. Configure bindings for production and preview. The legacy KV binding
// (uptimeflare_config) is explicitly nulled: the namespace gets deleted by
// the cleanup step and a leftover binding would fail subsequent deploys.
const compatibility = {
  compatibility_date: '2025-04-02',
  compatibility_flags: ['nodejs_compat'],
  fail_open: false,
}

await api(`/accounts/${accountId}/pages/projects/${PROJECT_NAME}`, {
  method: 'PATCH',
  body: JSON.stringify({
    deployment_configs: {
      production: {
        ...compatibility,
        d1_databases: { UPTIMEFLARE_D1: { id: databaseId } },
        durable_object_namespaces: { MONITOR_SCHEDULER_DO: { namespace_id: scheduler.id } },
        kv_namespaces: { UPTIMEFLARE_CONFIG: null },
      },
      preview: {
        ...compatibility,
        durable_object_namespaces: { MONITOR_SCHEDULER_DO: { namespace_id: scheduler.id } },
        kv_namespaces: { UPTIMEFLARE_CONFIG: null },
      },
    },
  }),
})
console.log(`Pages bindings configured (DO namespace ${scheduler.id}).`)
