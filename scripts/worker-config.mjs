#!/usr/bin/env node
// Generate wrangler.deploy.toml from wrangler.toml with the real D1 database
// id injected. The source file is ours and its shape is stable, so targeted
// replacement is enough (no TOML parser needed).
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// wrangler.toml lives at the repo root; this script lives in scripts/.
const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const databaseId = process.env.D1_ID?.trim() ?? ''
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(databaseId)) {
  throw new Error('D1_ID must be a valid database UUID')
}

let config = await readFile(path.join(rootDir, 'wrangler.toml'), 'utf8')
config = config.replace(
  /(database_id = )"00000000-0000-0000-0000-000000000000"/,
  `$1"${databaseId}"`
)
if (!config.includes(`"${databaseId}"`)) {
  throw new Error('Failed to inject D1_ID into worker config')
}

await writeFile(path.join(rootDir, 'wrangler.deploy.toml'), config)
console.log('wrangler.deploy.toml generated.')
