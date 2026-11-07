// Push this project to github.com/cy-2-u/UptimeFlare main via the Git Data
// API — for machines without git installed (uses `gh auth token`).
// Skips local-only paths: node_modules, .wrangler, dist, .git, .dev.vars.
// Usage: node scripts/push-root.mjs "<commit message>"
import { execSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const OWNER = 'cy-2-u'
const REPO = 'UptimeFlare'
const BRANCH = 'main'
const SRC = 'D:\\work\\jianche'
const SKIP_DIRS = new Set(['node_modules', '.wrangler', 'dist', '.git'])
const SKIP_FILES = new Set(['.dev.vars'])
const message = process.argv[2]
if (!message) {
  console.error('usage: node push-root.mjs "<message>"')
  process.exit(1)
}

const token = execSync('gh auth token', { encoding: 'utf8' }).trim()
const api = (path, opts = {}) => {
  const run = () =>
    fetch(`https://api.github.com${path}`, {
      ...opts,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        ...(opts.headers || {}),
      },
    })
  return run().then(async (res) => {
    if ((res.status === 502 || res.status === 503 || res.status === 504) && !opts._retried) {
      await new Promise((r) => setTimeout(r, 3000))
      return api(path, { ...opts, _retried: true })
    }
    if (!res.ok) throw new Error(`${opts.method || 'GET'} ${path} -> ${res.status}: ${await res.text()}`)
    return res.json()
  })
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue
      yield* walk(full)
    } else {
      if (SKIP_FILES.has(entry)) continue
      yield full
    }
  }
}

const ref = await api(`/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`)
const baseCommit = await api(`/repos/${OWNER}/${REPO}/git/commits/${ref.object.sha}`)
const baseTree = baseCommit.tree.sha

const existingTree = await api(`/repos/${OWNER}/${REPO}/git/trees/${baseTree}?recursive=1`)
const existingBlobs = new Map(existingTree.tree.filter((t) => t.type === 'blob').map((t) => [t.path, t.sha]))

const tree = []
let changed = 0
for (const file of walk(SRC)) {
  const path = relative(SRC, file).split(sep).join('/')
  const content = readFileSync(file)
  const blob = await api(`/repos/${OWNER}/${REPO}/git/blobs`, {
    method: 'POST',
    body: JSON.stringify({ content: content.toString('base64'), encoding: 'base64' }),
  })
  if (existingBlobs.get(path) !== blob.sha) changed++
  tree.push({ path, mode: '100644', type: 'blob', sha: blob.sha })
}
for (const path of existingBlobs.keys()) {
  const top = path.split('/')[0]
  if (!SKIP_DIRS.has(top) && !tree.some((t) => t.path === path)) {
    tree.push({ path, mode: '100644', type: 'blob', sha: null })
    changed++
  }
}
if (changed === 0) {
  console.log('No changes to push.')
  process.exit(0)
}

const newTree = await api(`/repos/${OWNER}/${REPO}/git/trees`, {
  method: 'POST',
  body: JSON.stringify({ base_tree: baseTree, tree }),
})
const commit = await api(`/repos/${OWNER}/${REPO}/git/commits`, {
  method: 'POST',
  body: JSON.stringify({ message, tree: newTree.sha, parents: [baseCommit.sha] }),
})
await api(`/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, {
  method: 'PATCH',
  body: JSON.stringify({ sha: commit.sha }),
})
console.log(`Pushed ${changed} changed file(s): ${commit.sha}`)
