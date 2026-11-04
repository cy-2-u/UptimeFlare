#!/usr/bin/env node
// Ensure the D1 database and table exist, then export D1_ID for later steps.
import { appendFile, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const scriptsDir = path.dirname(fileURLToPath(import.meta.url))
const API = 'https://api.cloudflare.com/client/v4'
const DATABASE_NAME = 'uptimeflare_d1'

const env = (key) => process.env[key]?.trim() ?? ''

async function api(pathname, init = {}) {
  const response = await fetch(`${API}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env('CLOUDFLARE_API_TOKEN')}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const body = await response.json()
  if (!body.success) {
    throw new Error(`Cloudflare API ${pathname} failed: ${JSON.stringify(body.errors)}`)
  }
  return body
}

async function resolveAccountId() {
  if (env('CLOUDFLARE_ACCOUNT_ID')) return env('CLOUDFLARE_ACCOUNT_ID')
  const { result } = await api('/accounts')
  if (!result?.length) throw new Error('Could not resolve account id; set CLOUDFLARE_ACCOUNT_ID')
  return result[0].id
}

async function appendGithubEnv(pairs) {
  const githubEnv = env('GITHUB_ENV')
  if (!githubEnv) return
  const content = Object.entries(pairs)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')
  await appendFile(githubEnv, `\n${content}\n`)
}

const accountId = await resolveAccountId()

// Create the database (error 7502 = already exists).
const create = await fetch(`${API}/accounts/${accountId}/d1/database`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${env('CLOUDFLARE_API_TOKEN')}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ name: DATABASE_NAME, primary_location_hint: 'wnam' }),
})
const createBody = await create.json()
if (!createBody.success && createBody.errors?.[0]?.code !== 7502) {
  throw new Error(`D1 create failed: ${JSON.stringify(createBody.errors)}`)
}
console.log(createBody.success ? 'D1 database created.' : 'D1 database already exists.')

const { result: databases } = await api(`/accounts/${accountId}/d1/database?per_page=1000`)
const database = databases.find((db) => db.name === DATABASE_NAME)
if (!database) throw new Error('D1 database not found after creation')

const initSql = await readFile(path.join(scriptsDir, 'init.sql'), 'utf8')
await api(`/accounts/${accountId}/d1/database/${database.uuid}/query`, {
  method: 'POST',
  body: JSON.stringify({ sql: initSql, params: [] }),
})
console.log('D1 table ensured.')

await appendGithubEnv({ D1_ID: database.uuid, CLOUDFLARE_ACCOUNT_ID: accountId })
console.log(`D1_ID=${database.uuid}`)
