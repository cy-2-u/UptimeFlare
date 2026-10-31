import type { MonitorTarget } from '../types/config'

export function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/https?:\/\//, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

function readString(data: Record<string, unknown>, key: string) {
  return String(data[key] ?? '').trim()
}

function validateTarget(target: string): URL {
  if (!target) throw new Error('请输入网站地址')
  let url: URL
  try {
    url = new URL(target)
  } catch {
    throw new Error('网站地址格式无效')
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('网站地址需要使用 http 或 https')
  }
  return url
}

function validateTimeout(timeout: number) {
  if (!Number.isFinite(timeout) || timeout < 1000 || timeout > 60000) {
    throw new Error('超时时间需要在 1 到 60 秒之间')
  }
  return timeout
}

function validatePreview(preview: string) {
  if (!preview) return undefined
  try {
    const previewUrl = new URL(preview)
    if (!['http:', 'https:'].includes(previewUrl.protocol)) throw new Error('invalid preview')
  } catch {
    throw new Error('封面图地址格式无效')
  }
  return preview
}

function validateStatusPageLink(statusPageLink: string) {
  if (!statusPageLink) return undefined
  try {
    const linkUrl = new URL(statusPageLink)
    if (!['http:', 'https:'].includes(linkUrl.protocol)) throw new Error('invalid link')
  } catch {
    throw new Error('访问链接格式无效')
  }
  return statusPageLink
}

// Validate and build a brand-new page-managed monitor.
export function parseNewMonitor(input: unknown): MonitorTarget {
  const data = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const name = readString(data, 'name')
  const group = readString(data, 'group') || '核心服务'
  const preview = readString(data, 'preview')
  const statusPageLink = readString(data, 'statusPageLink')
  const timeout = Number(data.timeout ?? 4500)

  if (!name) throw new Error('请输入网站名称')
  if (name.length > 80) throw new Error('网站名称最多 80 个字符')

  const url = validateTarget(readString(data, 'target'))
  validateTimeout(timeout)
  const validatedPreview = validatePreview(preview)
  const validatedLink = validateStatusPageLink(statusPageLink)

  const id = slugify(readString(data, 'id') || `${url.hostname}-${name}`)
  if (!id) throw new Error('无法生成监测 ID')

  return {
    id,
    name,
    method: 'GET',
    target: url.toString(),
    statusPageLink: validatedLink ?? url.toString(),
    preview: validatedPreview,
    group,
    expectedCodes: [200],
    timeout,
    hideLatencyChart: false,
  }
}

// Merge validated edits into an existing monitor. The id is immutable — it is
// the history key for incidents and latency.
export function mergeMonitorUpdate(existing: MonitorTarget, input: unknown): MonitorTarget {
  const data = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const next: MonitorTarget = { ...existing }

  if (data.name !== undefined) {
    const name = readString(data, 'name')
    if (!name) throw new Error('请输入网站名称')
    if (name.length > 80) throw new Error('网站名称最多 80 个字符')
    next.name = name
  }

  if (data.target !== undefined && readString(data, 'target') !== '') {
    next.target = validateTarget(readString(data, 'target')).toString()
  }

  if (data.group !== undefined) {
    next.group = readString(data, 'group') || '核心服务'
  }

  if (data.preview !== undefined) {
    next.preview = validatePreview(readString(data, 'preview'))
  }

  if (data.statusPageLink !== undefined) {
    const link = readString(data, 'statusPageLink')
    next.statusPageLink = link ? validateStatusPageLink(link) : next.target
  }

  if (data.timeout !== undefined) {
    next.timeout = validateTimeout(Number(data.timeout))
  }

  return next
}
