#!/usr/bin/env node
// Generate worker/wrangler.deploy.toml from worker/wrangler.toml with the real
// D1 database id injected. Replaces the old Python config generator without
// needing a full TOML parser: the source file is ours and its shape is stable.
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const workerDir = path.join(root, 'worker')

const databaseId = process.env.D1_ID?.trim() ?? ''
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

config += `\n[observability]\nenabled = true\n[observability.logs]\nenabled = true\ninvocation_logs = true\n`

await writeFile(path.join(workerDir, 'wrangler.deploy.toml'), config)
console.log('worker/wrangler.deploy.toml generated.')
