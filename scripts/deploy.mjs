import { readFile, writeFile, unlink } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const API = 'https://api.cloudflare.com/client/v4'
const token = process.env.CLOUDFLARE_API_TOKEN
if (!token) throw Error('Set CLOUDFLARE_API_TOKEN before deploying')
async function api(endpoint, init = {}) {
  const response = await fetch(API + endpoint, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } })
  const body = await response.json()
  if (!response.ok || !body.success) throw Error(`Cloudflare ${endpoint}: ${JSON.stringify(body.errors)}`)
  return body.result
}
const account = process.env.CLOUDFLARE_ACCOUNT_ID || (await api('/accounts'))[0]?.id
if (!account) throw Error('Set CLOUDFLARE_ACCOUNT_ID')
const generated = path.join(root, 'wrangler.deploy.toml')
const config = await readFile(path.join(root, 'wrangler.toml'), 'utf8')
try {
  await writeFile(generated, config, 'utf8')
  const command = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  const deployed = spawnSync(command, ['wrangler', 'deploy', '--config', generated], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: account } })
  if (deployed.error || deployed.status !== 0) throw deployed.error ?? Error(`Deploy exited ${deployed.status}`)
  const { subdomain } = await api(`/accounts/${account}/workers/subdomain`)
  const url = `https://uptimeflare_worker.${subdomain}.workers.dev/health`
  let error
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) })
      const health = await response.json()
      if (!response.ok || !health.healthy || !health.nextAlarm) throw Error(JSON.stringify(health))
      console.log('Health check passed:', health)
      error = undefined
      break
    } catch (cause) { error = cause; if (attempt < 5) await new Promise(resolve => setTimeout(resolve, 10000)) }
  }
  if (error) throw error
} finally { await unlink(generated).catch(() => undefined) }
