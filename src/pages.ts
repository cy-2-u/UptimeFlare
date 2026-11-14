import type { Incident, Maintenance, Monitor } from './types'

export const TIMEOUT_OPTIONS = [3, 5, 10, 15, 30, 60]
export const INTERVAL_OPTIONS = [10, 20, 30, 60]

const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
const hostnameOf = (target: string) => new URL(target).hostname
// Boot data rides inside <script type="application/json">; escaping "<" keeps
// the payload from closing its own tag.
const bootScript = (data: unknown) => `<script id="bootstrap" type="application/json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`
const CHEV = `<svg class="chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 6l4.5 4.5L12.5 6"/></svg>`
const BRAND = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>`

const STATUS_LABEL: Record<string, string> = { up: '运行正常', down: '宕机', pending: '等待检查' }
const groupIcon = (group: string) => group.includes('基础') ? '🖥' : group.includes('AI') ? '☁' : group.includes('工具') ? '🧰' : '🗔'

// Page shell. The nav is rendered from the validated session — no client swap,
// no flash, no extra fetch. On the manage page "站点管理" becomes "返回".
export function layout(opts: { title: string; isAdmin: boolean; manage?: boolean; boot?: unknown; links?: { link: string; label: string }[] }, content: string) {
  const nav = opts.isAdmin
    ? `${opts.manage ? `<a href="/" class="btn ghost sm">← 返回</a>` : `<a href="/manage" class="btn ghost sm">站点管理</a>`}<button type="button" class="btn ghost sm danger-hover" data-action="logout">退出</button>`
    : `<a href="/login" class="btn primary sm">登录</a>`
  const links = (opts.links ?? []).map(link => `<a href="${esc(link.link)}" target="_blank" rel="noopener noreferrer">${esc(link.label)}</a>`).join('')
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(opts.title)}</title>
<link rel="icon" href="/favicon.svg">
<link rel="stylesheet" href="/app.css">
</head>
<body>
<div class="shell">
<header class="topbar">
<a href="/" class="brand"><span class="brand-mark" aria-hidden="true">${BRAND}</span><span>${esc(opts.title)}</span></a>
<nav class="topnav">${nav}</nav>
</header>
<div class="orb orb-a" aria-hidden="true"></div>
<div class="orb orb-b" aria-hidden="true"></div>
<main>${content}</main>
<footer class="footer"><p>© ${new Date().getFullYear()} ${esc(opts.title)} · 持续监测</p><div class="footer-links">${links}</div></footer>
</div>
${opts.boot === undefined ? '' : bootScript(opts.boot)}
<script type="module" src="/app.js"></script>
</body>
</html>`
}

export type StatusBoot = {
  title: string
  lastUpdate: number
  overallUp: number
  overallDown: number
  monitors: Monitor[]
  up: Record<string, boolean | null>
  incident: Record<string, Incident[]>
  startedAt: Record<string, number>
  lastPing: Record<string, number>
  maintenances: Maintenance[]
}

export function statusPage(boot: StatusBoot) {
  const total = boot.overallUp + boot.overallDown
  const overall = total === 0
    ? { tone: '', icon: '⏳', label: '暂无监测数据' }
    : boot.overallUp === 0
      ? { tone: 'bad', icon: '✖', label: '全部服务不可用' }
      : boot.overallDown === 0
        ? { tone: 'ok', icon: '✔', label: '全部服务运行正常' }
        : { tone: 'warn', icon: '⚠', label: `${boot.overallDown} / ${total} 个服务出现故障` }

  const groups = new Map<string, Monitor[]>()
  for (const monitor of boot.monitors) {
    const name = monitor.group || '核心服务'
    if (!groups.has(name)) groups.set(name, [])
    groups.get(name)!.push(monitor)
  }

  const cards = [...groups.entries()].map(([name, monitors]) => `<section class="group"><div class="group-head"><div class="group-mark">${groupIcon(name)}</div><h2>${esc(name)}</h2></div><div class="cards">${monitors.map(monitor => {
    const status = boot.up[monitor.id] === undefined || boot.up[monitor.id] === null ? 'pending' : boot.up[monitor.id] ? 'up' : 'down'
    const preview = monitor.preview || (monitor.target.startsWith('https://') ? `https://image.thum.io/get/width/1200/${monitor.target}` : '')
    const shot = preview
      ? `<a href="${esc(monitor.statusPageLink || monitor.target)}" target="_blank" rel="noopener noreferrer"><img src="${esc(preview)}" alt="${esc(monitor.name)}" loading="lazy"></a>`
      : `<div class="shot-empty">☁</div>`
    const ping = boot.lastPing[monitor.id]
    return `<article class="card" data-monitor="${esc(monitor.id)}">
<div class="card-preview"><div class="card-chrome"><span></span><span></span><span></span><span class="chrome-host">${esc(hostnameOf(monitor.target))}</span></div><div class="card-shot">${shot}</div></div>
<div class="card-head"><div class="min-w-0"><h3>${esc(monitor.name)}</h3><div class="host">${esc(hostnameOf(monitor.target))}</div></div><span class="badge">${esc(monitor.group || '核心服务')}</span></div>
<div class="card-bars"><div class="bars-meta"><span>近 30 天</span><span class="mono" data-percent>—</span></div><div class="bars" data-bars></div></div>
<div class="card-foot"><span class="dot dot-${status}" data-dot></span><span data-status-label>${STATUS_LABEL[status]}</span><span class="muted" data-ago></span><span class="latency" data-latency>${ping ? `${ping}ms` : '—'}</span></div>
</article>`
  }).join('')}</div></section>`).join('')

  return `<section class="hero">
<div class="hero-left hero-enter">
<div class="pulse-chip"><span class="pulse-dot${overall.tone ? ' ' + overall.tone : ''}" data-overall-dot></span><span>持续监测中</span></div>
<h1 class="hero-title">${esc(boot.title ?? '服务状态')}</h1>
<div class="overall${overall.tone ? ' ' + overall.tone : ''}"><span data-overall-icon>${overall.icon}</span><span data-overall-text>${overall.label}</span></div>
<div class="hero-actions"><button type="button" class="btn ghost sm" data-open-incidents>🕘 历史故障</button></div>
</div>
<div class="hero-summary hero-enter">
<div class="summary-head"><span>运行概况</span><span class="emblem" data-overall-icon>${overall.icon}</span></div>
<div class="summary-grid"><div><div class="summary-num ok" data-overall-up>${boot.overallUp}</div><div class="summary-label">在线服务</div></div><div><div class="summary-num">${total}</div><div class="summary-label">监测总数</div></div></div>
<div class="summary-foot">数据更新于 <span data-updated-at>—</span></div>
</div>
</section>
<div class="groups">${cards}</div>
<div class="maint-alerts" data-maint-active></div>
<div data-maint-upcoming></div>
<dialog class="dlg" id="day-dialog">
<div class="dlg-head"><div><div class="dlg-sub" data-day-sub></div><div class="dlg-title" data-day-title>当日故障</div></div><button type="button" class="dlg-close" aria-label="关闭">✕</button></div>
<div class="dlg-body" data-day-body></div>
</dialog>
<dialog class="dlg" id="history-dialog">
<div class="dlg-head"><div><div class="dlg-sub">History</div><div class="dlg-title">历史故障</div></div><button type="button" class="dlg-close" aria-label="关闭">✕</button></div>
<div class="dlg-body" data-history-body></div>
</dialog>`
}

export type DetailBoot = { monitor: Monitor; up: boolean | null; incident: Incident[]; latency: { time: number; ping: number; loc: string }[]; startedAt?: number; lastUpdate: number; maintenances: Maintenance[] }

export function detailPage(boot: DetailBoot | null, found: boolean, id: string) {
  if (!found || !boot) return `<div class="detail-wrap"><a href="/" class="back">← 返回状态页</a><p class="empty">未找到监测项：${esc(id)}</p></div>`
  const hasData = boot.incident.length > 0 || boot.latency.length > 0
  if (!hasData) return `<div class="detail-wrap"><a href="/" class="back">← 返回状态页</a><article class="detail-card"><h2 class="detail-name">${esc(boot.monitor.name)}</h2><p class="muted">暂无监测数据。</p></article></div>`
  const isUp = boot.up !== false
  const host = hostnameOf(boot.monitor.target)
  return `<div class="detail-wrap"><a href="/" class="back">← 返回状态页</a>
<article class="detail-card">
<div class="detail-head">
<div class="detail-title"><span class="emblem-sm${isUp ? '' : ' bad'}" data-detail-icon>${isUp ? '✔' : '✖'}</span><div><div class="detail-name">${esc(boot.monitor.name)}${boot.monitor.statusPageLink ? `<a href="${esc(boot.monitor.statusPageLink)}" target="_blank" rel="noopener noreferrer" class="ext" aria-label="访问站点">↗</a>` : ''}</div><p class="muted">${esc(host)}</p>${boot.monitor.tooltip ? `<p class="muted">${esc(boot.monitor.tooltip)}</p>` : ''}</div></div>
<div class="detail-badges"><span class="badge" data-detail-status>${isUp ? '运行正常' : '宕机'}</span><span class="badge" data-detail-uptime>总可用率 —</span><span class="badge" data-detail-ago>— 前更新</span></div>
</div>
<section><h3 class="sec-title">可用率历史（90 天）</h3><div class="bars wide" data-bars></div></section>
<section><h3 class="sec-title">响应时间（近 12 小时）</h3><div class="sparkline" data-sparkline></div></section>
</article></div>`
}

export function managePage(monitors: Monitor[]) {
  const rows = monitors.length === 0
    ? `<p class="empty-state">当前还没有网站。</p>`
    : monitors.map(monitor => `<div class="monitor-row" data-row="${esc(monitor.id)}"><div class="min-w-0"><div class="row-title"><strong>${esc(monitor.name)}</strong><span class="badge">${esc(monitor.group || '核心服务')}</span><span class="badge">${monitor.intervalMinutes ?? 10} 分钟</span></div><div class="row-target">${esc(monitor.target)}</div></div><div class="row-actions"><button type="button" class="btn ghost sm" data-edit="${esc(monitor.id)}">编辑</button><button type="button" class="btn danger sm" data-remove="${esc(monitor.id)}">删除</button></div></div>`).join('')
  const dropdown = (name: string, label: string, initial: string) => `<div class="relative" data-${name}-box><button type="button" class="dropdown" data-dropdown="${name}" aria-haspopup="listbox" aria-expanded="false"><span data-dropdown-label>${label}</span>${CHEV}</button><ul class="menu" data-menu="${name}" hidden></ul></div>`
  return `<div class="manage-wrap"><a href="/" class="back">← 返回状态页</a>
<section class="manage-card">
<div class="manage-grid">
<div>
<h2 class="form-title" data-form-title>添加站点</h2>
<p class="muted" data-form-hint>新站点将在下一轮检查后显示状态。</p>
<form class="form" id="monitor-form">
<label class="field"><span>网站名称</span><input name="name" placeholder="官网" maxlength="80"></label>
<label class="field"><span>网站地址</span><input name="target" placeholder="https://example.com" inputmode="url"></label>
<div class="field-row">
<label class="field"><span>分组</span><div class="relative" data-group-box><input name="group" placeholder="核心服务" autocomplete="off" data-group-input><button type="button" class="chevron-btn" aria-label="展开分组建议" aria-expanded="false" data-group-toggle>${CHEV}</button><ul class="menu" data-group-suggest hidden></ul></div></label>
<label class="field"><span>检查间隔</span>${dropdown('interval', '10 分钟', '')}</label>
</div>
<div class="field-row">
<label class="field"><span>超时时间</span>${dropdown('timeout', '3 秒', '')}</label>
<label class="field"><span>封面图 URL</span><input name="preview" placeholder="留空自动生成" inputmode="url"></label>
</div>
<label class="field"><span>访问链接</span><input name="statusPageLink" placeholder="留空使用网站地址" inputmode="url"></label>
<div class="form-actions"><button type="submit" class="btn primary" data-submit>保存站点</button><button type="button" class="btn ghost hidden" data-cancel-edit>取消</button></div>
<p class="form-message" data-message></p>
</form>
</div>
<div>
<div class="list-head"><h3>当前监测列表</h3><span class="badge" data-count>${monitors.length} 个</span></div>
<div class="monitor-list" data-list>${rows}</div>
</div>
</div>
</section></div>`
}

export function loginPage(hasAdmin: boolean) {
  const isSetup = !hasAdmin
  return `<div class="login-wrap"><a href="/" class="back">← 返回状态页</a>
<section class="login-card hero-enter">
<h1>${isSetup ? '设置管理员' : '管理员登录'}</h1>
<p class="muted">${isSetup ? '创建账号，开始管理站点。' : '登录你的管理账号。'}</p>
<form class="form" id="login-form" data-has-admin="${isSetup ? 'false' : 'true'}">
<label class="field"><span>账号</span><input name="username" autocomplete="username"></label>
<label class="field"><span>密码</span><input name="password" type="password" autocomplete="${isSetup ? 'new-password' : 'current-password'}"></label>
<button type="submit" class="btn primary wide" data-submit disabled>${isSetup ? '创建管理员' : '登录'}</button>
<p class="form-message" data-message></p>
</form>
</section></div>`
}
