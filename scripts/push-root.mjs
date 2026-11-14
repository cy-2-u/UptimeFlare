import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const repo = 'cy-2-u/UptimeFlare'
const message = process.argv[2]
if (!message || /[\r\n]/.test(message)) throw Error('Usage: node scripts/push-root.mjs "why this change is needed"')
const ignored = new Set(['node_modules', '.wrangler', '.git'])
const local = name => name === '.dev.vars' || name.startsWith('.dev.vars.') || name === 'wrangler.deploy.toml' || name.endsWith('.log') || name === '.DS_Store'
const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim()
async function api(endpoint, method = 'GET', data) {
  const response = await fetch(`https://api.github.com/repos/${repo}${endpoint}`, {
    method, headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' },
    ...(data ? { body: JSON.stringify(data) } : {}),
  })
  if (!response.ok) throw Error(`GitHub ${method} ${endpoint}: ${response.status} ${await response.text()}`)
  return response.json()
}
async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name) || local(entry.name)) continue
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(file)
    else if (entry.isFile()) yield file
    else throw Error(`Unsupported file: ${file}`)
  }
}
const ref = await api('/git/ref/heads/main')
const base = await api(`/git/commits/${ref.object.sha}`)
const remote = await api(`/git/trees/${base.tree.sha}?recursive=1`)
if (remote.truncated) throw Error('Remote tree is incomplete')
const existing = new Map(remote.tree.filter(entry => entry.type === 'blob').map(entry => [entry.path, entry.sha]))
const changes = []
for await (const file of walk(root)) {
  const name = path.relative(root, file).split(path.sep).join('/')
  const content = await readFile(file)
  const sha = createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex')
  if (existing.get(name) !== sha) {
    const blob = await api('/git/blobs', 'POST', { content: content.toString('base64'), encoding: 'base64' })
    changes.push({ path: name, mode: '100644', type: 'blob', sha: blob.sha })
  }
  existing.delete(name)
}
for (const name of existing.keys()) changes.push({ path: name, mode: '100644', type: 'blob', sha: null })
if (!changes.length) console.log('No changes to push.')
else {
  const tree = await api('/git/trees', 'POST', { base_tree: base.tree.sha, tree: changes })
  const commit = await api('/git/commits', 'POST', { message, tree: tree.sha, parents: [base.sha] })
  await api('/git/refs/heads/main', 'PATCH', { sha: commit.sha, force: false })
  console.log(`Pushed ${changes.length} changed files: https://github.com/${repo}/commit/${commit.sha}`)
}
