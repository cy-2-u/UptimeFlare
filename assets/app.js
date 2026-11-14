// UptimeFlare client runtime — dependency-free vanilla JS.
//
// The server renders structure and static text (nav, cards, overall banner);
// this module fills the interactive parts from #bootstrap (uptime bars,
// dialogs, dropdowns, sparkline) and keeps counters fresh. No hydration, no
// layout swap.
import { barClass, dayStats } from './stats.js'

const $ = (sel, root) => (root || document).querySelector(sel)
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel))
const CHEV_SVG = '<svg class="chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 6l4.5 4.5L12.5 6"/></svg>'

// ---- formatting -----------------------------------------------------------

function fmtTime(sec) {
  return new Date(sec * 1000).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
}
function fmtTimeShort(sec) {
  return new Date(sec * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}
function fmtAgo(sec) {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - sec))
  if (s < 60) return s + ' 秒'
  const m = Math.floor(s / 60)
  if (m < 60) return m + ' 分钟'
  const h = Math.floor(m / 60)
  if (h < 24) return h + ' 小时'
  return Math.floor(h / 24) + ' 天'
}
function fmtDuration(seconds) {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const parts = []
  if (d > 0) parts.push(d + ' 天')
  if (h > 0) parts.push(h + ' 小时')
  if (m > 0) parts.push(m + ' 分钟')
  if (s > 0) parts.push(s + ' 秒')
  return parts.join(' ') || '0 秒'
}
function fmtDate(sec) {
  return new Date(sec * 1000).toLocaleDateString()
}

// ---- uptime bars ----------------------------------------------------------

function renderBars(container, incidents, startedAt, nowSec, days, monitorName) {
  if (!container) return { totalMonitorTime: 0, totalDownTime: 0 }
  container.textContent = ''
  const stats = dayStats(incidents, startedAt, nowSec, days)
  stats.forEach(day => {
    const bar = document.createElement('div')
    bar.className = 'bar ' + (day.percent === -1 ? '' : barClass(day.percent))
    const tip = document.createElement('span')
    tip.className = 'tip'
    tip.innerHTML =
      '<b>' + fmtDate(day.dayStart) + (day.percent === -1 ? ' · 无数据' : ' · ' + day.percent.toFixed(2) + '%') + '</b>' +
      (day.downTime > 0 ? '<br><span style="color:#fda4af;font-weight:600">宕机 ' + fmtDuration(day.downTime) + '</span><br><span style="opacity:0.7">点击查看详情</span>' : '')
    bar.appendChild(tip)
    // Keep the tooltip inside the viewport: measure on hover and shift the
    // centered bubble when it would overflow the shell.
    bar.addEventListener('mouseenter', () => {
      const tipEl = $('.tip', bar)
      if (!tipEl) return
      const barRect = bar.getBoundingClientRect()
      const tipRect = tipEl.getBoundingClientRect()
      const center = barRect.left + barRect.width / 2
      const left = center - tipRect.width / 2
      const right = center + tipRect.width / 2
      const margin = 8
      let shift = 0
      if (left < margin) shift = margin - left
      else if (right > window.innerWidth - margin) shift = window.innerWidth - margin - right
      tipEl.style.transform = 'translateX(calc(-50% + ' + shift.toFixed(1) + 'px))'
    })
    if (day.downTime > 0) bar.addEventListener('click', () => openDayDialog(day, monitorName))
    container.appendChild(bar)
  })
  const totals = { totalMonitorTime: 0, totalDownTime: 0 }
  stats.forEach(day => {
    totals.totalMonitorTime += day.monitorTime
    totals.totalDownTime += day.downTime
  })
  return totals
}

// ---- single-day incident dialog -------------------------------------------

const dayDialog = $('#day-dialog')

function openDayDialog(day, monitorName) {
  if (!dayDialog) return
  $('[data-day-sub]', dayDialog).textContent = fmtDate(day.dayStart)
  $('[data-day-title]', dayDialog).textContent = (monitorName ? monitorName + ' · ' : '') + '当日故障'
  const body = $('[data-day-body]', dayDialog)
  body.textContent = ''
  const strip = document.createElement('div')
  strip.className = 'summary-strip'
  strip.innerHTML = '<span>总宕机时间</span><span>' + fmtDuration(day.downTime) + '</span>'
  body.appendChild(strip)
  if (day.segments.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'empty-state'
    empty.textContent = '这一天没有故障记录。'
    body.appendChild(empty)
  } else {
    day.segments.slice().reverse().forEach(segment => {
      const card = document.createElement('div')
      card.className = 'incident-card'
      card.innerHTML =
        '<div class="incident-time" style="margin-top:0"><span>' + fmtTimeShort(segment.start) +
        '</span><span style="color:#cbd5e1">→</span><span>' + fmtTimeShort(segment.end) + '</span></div><div class="incident-err"></div>'
      $('.incident-err', card).textContent = segment.error
      body.appendChild(card)
    })
  }
  dayDialog.showModal()
}

// ---- history dialog -------------------------------------------------------

const historyDialog = $('#history-dialog')
const historyState = { month: null, monitor: '', page: 1 }

function monthOf(ms) {
  const d = new Date(ms)
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
}
function shiftMonth(month, delta) {
  const parts = month.split('-').map(Number)
  const d = new Date(parts[0], parts[1] - 1 + delta)
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
}

function openHistoryDialog(bootstrap) {
  if (!historyDialog) return
  historyState.month = monthOf(Date.now())
  historyState.monitor = ''
  historyState.page = 1
  renderHistory(bootstrap)
  historyDialog.showModal()
}

function renderHistory(bootstrap) {
  const body = $('[data-history-body]', historyDialog)
  body.textContent = ''
  const nowSec = Math.floor(Date.now() / 1000)

  // Monitor filter — custom dropdown, never the browser-native menu.
  const toolbar = document.createElement('div')
  toolbar.className = 'dlg-toolbar'
  const box = document.createElement('div')
  box.className = 'relative'
  const trigger = document.createElement('button')
  trigger.type = 'button'
  trigger.className = 'dropdown'
  trigger.setAttribute('data-dropdown', 'history-monitor')
  trigger.setAttribute('aria-haspopup', 'listbox')
  trigger.setAttribute('aria-expanded', 'false')
  trigger.innerHTML = '<span data-dropdown-label></span>' + CHEV_SVG
  const menu = document.createElement('ul')
  menu.className = 'menu'
  menu.setAttribute('data-menu', 'history-monitor')
  menu.hidden = true
  box.appendChild(trigger)
  box.appendChild(menu)
  toolbar.appendChild(box)
  body.appendChild(toolbar)
  setupDropdown(box, [{ value: '', label: '全部站点' }].concat(bootstrap.monitors.map(monitor => ({ value: monitor.id, label: monitor.name }))), value => {
    historyState.monitor = value
    historyState.page = 1
    renderHistory(bootstrap)
  }).value = historyState.monitor

  // Month navigation.
  const monthBar = document.createElement('div')
  monthBar.className = 'dlg-month'
  const prev = document.createElement('button')
  prev.className = 'btn ghost sm'
  prev.textContent = '‹ 上个月'
  const next = document.createElement('button')
  next.className = 'btn ghost sm'
  next.textContent = '下个月 ›'
  const title = document.createElement('strong')
  title.textContent = historyState.month
  prev.addEventListener('click', () => { historyState.month = shiftMonth(historyState.month, -1); historyState.page = 1; renderHistory(bootstrap) })
  next.addEventListener('click', () => { historyState.month = shiftMonth(historyState.month, 1); historyState.page = 1; renderHistory(bootstrap) })
  monthBar.appendChild(prev)
  monthBar.appendChild(title)
  monthBar.appendChild(next)
  body.appendChild(monthBar)

  const monthStart = new Date(Number(historyState.month.split('-')[0]), Number(historyState.month.split('-')[1]) - 1, 1).getTime() / 1000
  const monthEnd = new Date(Number(historyState.month.split('-')[0]), Number(historyState.month.split('-')[1]), 1).getTime() / 1000

  const found = []
  bootstrap.monitors.forEach(monitor => {
    const incidents = bootstrap.incident[monitor.id] || []
    incidents.forEach(incident => {
      const incidentStart = incident.start[0]
      const incidentEnd = incident.end == null ? nowSec : incident.end
      if (incidentEnd < monthStart || incidentStart >= monthEnd) return
      const errors = incident.error.map((error, index) => ({
        start: fmtTime(incident.start[index]),
        end: fmtTime(index === incident.error.length - 1 ? incidentEnd : incident.start[index + 1]),
        error,
      }))
      found.push({ monitorName: monitor.name, monitorId: monitor.id, start: incidentStart, end: incident.end, errors, duration: incidentEnd - incidentStart })
    })
  })
  found.sort((a, b) => b.start - a.start)
  const filtered = historyState.monitor ? found.filter(item => item.monitorId === historyState.monitor) : found

  const list = document.createElement('div')
  list.style.cssText = 'display:flex;flex-direction:column;gap:12px'
  if (filtered.length === 0) {
    const none = document.createElement('p')
    none.className = 'empty-state'
    none.textContent = '这个月没有故障记录 🎉'
    list.appendChild(none)
  } else {
    const perPage = 20
    const totalPages = Math.max(1, Math.ceil(filtered.length / perPage))
    if (historyState.page > totalPages) historyState.page = totalPages
    filtered.slice((historyState.page - 1) * perPage, historyState.page * perPage).forEach(incident => {
      const ongoing = incident.end == null
      const card = document.createElement('div')
      card.className = 'incident-card'
      card.innerHTML =
        '<div class="incident-head"><div class="incident-name"><span class="dot ' + (ongoing ? 'dot-down' : 'dot-pending') + '"></span>' +
        incident.monitorName + '</div><span class="badge">' + (ongoing ? '进行中' : '已恢复') + '</span></div>' +
        '<div class="incident-time"><span>' + fmtTime(incident.start) + '</span><span style="color:#cbd5e1">→</span><span>' +
        (ongoing ? '进行中' : fmtTime(incident.end)) + '</span><span style="color:#cbd5e1">|</span><span>' + fmtDuration(incident.duration) + '</span></div>'
      incident.errors.forEach(err => {
        const div = document.createElement('div')
        div.className = 'incident-err'
        div.textContent = err.error
        card.appendChild(div)
      })
      list.appendChild(card)
    })
    if (totalPages > 1) {
      const pager = document.createElement('div')
      pager.style.cssText = 'display:flex;justify-content:center;align-items:center;gap:8px;padding-top:8px'
      const prevBtn = document.createElement('button')
      prevBtn.className = 'btn ghost sm'
      prevBtn.textContent = '‹'
      prevBtn.disabled = historyState.page <= 1
      prevBtn.addEventListener('click', () => { historyState.page -= 1; renderHistory(bootstrap) })
      const label = document.createElement('span')
      label.style.cssText = 'font-size:12px;color:#64748b'
      label.textContent = historyState.page + ' / ' + totalPages
      const nextBtn = document.createElement('button')
      nextBtn.className = 'btn ghost sm'
      nextBtn.textContent = '›'
      nextBtn.disabled = historyState.page >= totalPages
      nextBtn.addEventListener('click', () => { historyState.page += 1; renderHistory(bootstrap) })
      pager.appendChild(prevBtn)
      pager.appendChild(label)
      pager.appendChild(nextBtn)
      list.appendChild(pager)
    }
  }
  body.appendChild(list)
}

// ---- status page ----------------------------------------------------------

function initStatusPage(bootstrap) {
  let overallUp = bootstrap.overallUp
  let overallDown = bootstrap.overallDown
  let lastUpdateSec = bootstrap.lastUpdate || 0

  function paintOverall() {
    let tone = 'ok'
    let label = '全部服务运行正常'
    let glyph = '✔'
    if (overallUp === 0 && overallDown === 0) {
      tone = ''
      label = '暂无监测数据'
      glyph = '⏳'
    } else if (overallUp === 0) {
      tone = 'bad'
      label = '全部服务不可用'
      glyph = '✖'
    } else if (overallDown > 0) {
      tone = 'warn'
      label = overallDown + ' / ' + (overallUp + overallDown) + ' 个服务出现故障'
      glyph = '⚠'
    }
    const text = $('[data-overall-text]')
    if (text) {
      text.textContent = label
      if (text.parentElement) text.parentElement.className = 'overall' + (tone ? ' ' + tone : '')
    }
    const dot = $('[data-overall-dot]')
    if (dot) dot.className = 'pulse-dot' + (tone ? ' ' + tone : '')
    $$('[data-overall-icon]').forEach(el => { el.textContent = glyph })
    const up = $('[data-overall-up]')
    if (up) {
      up.textContent = overallUp
      up.className = 'summary-num' + (overallUp > 0 ? ' ok' : '')
    }
    const updated = $('[data-updated-at]')
    if (updated && lastUpdateSec) updated.textContent = new Date(lastUpdateSec * 1000).toLocaleString('zh-CN', { hour12: false })
  }

  function paintAgo() {
    if (!lastUpdateSec) return
    $$('[data-ago]').forEach(el => { el.textContent = fmtAgo(lastUpdateSec) + '前' })
  }

  function inMaintenance(monitorId, nowMs) {
    return bootstrap.maintenances.some(m => nowMs >= new Date(m.start).getTime() && (!m.end || nowMs <= new Date(m.end).getTime()) && (m.monitors || []).indexOf(monitorId) !== -1)
  }

  // Cards: bars, percent, maintenance-override status, latency, ago.
  bootstrap.monitors.forEach(monitor => {
    const card = $('[data-monitor="' + monitor.id + '"]')
    if (!card) return
    const incidents = bootstrap.incident[monitor.id] || []
    const totals = renderBars($('[data-bars]', card), incidents, (bootstrap.startedAt || {})[monitor.id], Math.floor(Date.now() / 1000), 30, monitor.name)
    const percent = $('[data-percent]', card)
    if (percent) {
      const value = totals.totalMonitorTime > 0 ? (((totals.totalMonitorTime - totals.totalDownTime) / totals.totalMonitorTime) * 100).toFixed(2) : '—'
      percent.textContent = value
      if (value !== '—') percent.innerHTML += '<span style="color:#94a3b8">%</span>'
    }
    if (inMaintenance(monitor.id, Date.now())) {
      const dot = $('[data-dot]', card)
      if (dot) dot.className = 'dot dot-maintenance'
      const statusLabel = $('[data-status-label]', card)
      if (statusLabel) statusLabel.textContent = '维护中'
    }
    const ago = $('[data-ago]', card)
    if (ago && lastUpdateSec) ago.textContent = fmtAgo(lastUpdateSec) + '前'
  })

  // Maintenance alerts: active (time-based) and upcoming previews.
  const alertBox = $('[data-maint-active]')
  const upcomingBox = $('[data-maint-upcoming]')
  const nowMs = Date.now()
  bootstrap.maintenances.forEach(m => {
    const startMs = new Date(m.start).getTime()
    const endOk = !m.end || nowMs <= new Date(m.end).getTime()
    const active = nowMs >= startMs && endOk
    const upcoming = nowMs < startMs
    if (!active && !upcoming) return
    const box = active ? alertBox : upcomingBox
    if (!box) return
    const div = document.createElement('div')
    div.className = 'maint' + (active ? '' : ' upcoming') + ' ' + (m.color || 'amber')
    div.innerHTML =
      '<span class="maint-title">' + (m.title || (active ? '计划维护' : '维护预告')) + '</span>' +
      '<span class="maint-time">' + (active ? '' : '开始于 ') + fmtTime(Math.round(startMs / 1000)) + (m.end ? ' → ' + fmtTime(Math.round(new Date(m.end).getTime() / 1000)) : '') + '</span>' +
      '<span class="maint-body"></span>'
    $('.maint-body', div).textContent = m.body
    box.appendChild(div)
  })

  paintOverall()
  paintAgo()
  setInterval(() => {
    paintOverall()
    paintAgo()
  }, 30000)

  const openHistory = $('[data-open-incidents]')
  if (openHistory) openHistory.addEventListener('click', () => openHistoryDialog(bootstrap))

  // Light live updates (overall counters, latency, ago) from the cached API.
  setInterval(async () => {
    try {
      const res = await fetch('/api/data', { cache: 'no-store' })
      if (!res.ok) return
      const data = await res.json()
      overallUp = data.up
      overallDown = data.down
      lastUpdateSec = data.updatedAt || lastUpdateSec
      paintOverall()
      paintAgo()
      data.monitors && Object.keys(data.monitors).forEach(id => {
        const card = $('[data-monitor="' + id + '"]')
        const summary = data.monitors[id]
        if (!card || !summary || summary.latency == null) return
        const latency = $('[data-latency]', card)
        latency.textContent = summary.latency + 'ms'
        latency.style.color = summary.latency > 500 ? '#d97706' : '#334155'
      })
    } catch (e) {
      /* offline is fine; the next tick retries */
    }
  }, 120000)
}

// ---- detail page ----------------------------------------------------------

function initDetailPage(bootstrap) {
  const monitor = bootstrap.monitor
  const incidents = bootstrap.incident || []
  const latencies = bootstrap.latency || []
  const nowSec = Math.floor(Date.now() / 1000)

  const inMaintenance = (bootstrap.maintenances || []).some(m => {
    const t = Date.now()
    return t >= new Date(m.start).getTime() && (!m.end || t <= new Date(m.end).getTime()) && (m.monitors || []).indexOf(monitor.id) !== -1
  })
  if (inMaintenance) {
    const statusBadge = $('[data-detail-status]')
    if (statusBadge) statusBadge.textContent = '维护中'
    const icon = $('[data-detail-icon]')
    if (icon) {
      icon.textContent = '⚠'
      icon.classList.add('warn')
    }
  }

  const totals = renderBars($('[data-bars]'), incidents, bootstrap.startedAt, nowSec, 90, monitor.name)
  const uptime = $('[data-detail-uptime]')
  if (uptime) {
    uptime.textContent = totals.totalMonitorTime > 0 ? '总可用率 ' + (((totals.totalMonitorTime - totals.totalDownTime) / totals.totalMonitorTime) * 100).toPrecision(4) + '%' : '总可用率 —'
  }
  const ago = $('[data-detail-ago]')
  if (ago && bootstrap.lastUpdate) ago.textContent = fmtAgo(bootstrap.lastUpdate) + '前更新'

  // Sparkline with hover crosshair + tooltip.
  const spark = $('[data-sparkline]')
  if (spark && latencies.length >= 2) {
    const width = 720
    const height = 180
    const padX = 10
    const padTop = 14
    const padBottom = 22
    const maxPing = Math.max(...latencies.map(p => p.ping), 50)
    const yMax = maxPing * 1.15
    const startTime = latencies[0].time * 1000
    const endTime = latencies[latencies.length - 1].time * 1000
    const span = Math.max(1, endTime - startTime)
    const x = ms => padX + ((ms - startTime) / span) * (width - padX * 2)
    const y = ping => padTop + (1 - ping / yMax) * (height - padTop - padBottom)
    const line = latencies.map((p, i) => (i === 0 ? 'M' : 'L') + x(p.time * 1000).toFixed(1) + ',' + y(p.ping).toFixed(1)).join(' ')

    spark.innerHTML =
      '<svg viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none">' +
      '<defs><linearGradient id="sg" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="#14b8a6" stop-opacity="0.28"/><stop offset="100%" stop-color="#14b8a6" stop-opacity="0"/></linearGradient></defs>' +
      '<path d="' + line + ' L' + (width - padX) + ',' + (height - padBottom) + ' L' + padX + ',' + (height - padBottom) + ' Z" fill="url(#sg)"/>' +
      '<path d="' + line + '" fill="none" stroke="#0d9488" stroke-width="2" vector-effect="non-scaling-stroke"/>' +
      '<g data-hover display="none">' +
      '<line x1="0" x2="0" y1="' + padTop + '" y2="' + (height - padBottom) + '" stroke="#0d9488" stroke-opacity="0.35" stroke-width="1" vector-effect="non-scaling-stroke"/>' +
      '<circle r="4" fill="#0d9488" stroke="#fff" stroke-width="2"/></g></svg>' +
      '<div class="spark-tip" hidden></div>' +
      '<div style="position:absolute;left:0;right:0;bottom:0;display:flex;justify-content:space-between;font-size:10px;color:#94a3b8"><span>12 小时前</span><span>现在</span></div>'

    const svg = $('svg', spark)
    const hoverGroup = $('[data-hover]', spark)
    const hoverLine = $('line', hoverGroup)
    const hoverDot = $('circle', hoverGroup)
    const tip = $('.spark-tip', spark)

    svg.addEventListener('mousemove', event => {
      const rect = svg.getBoundingClientRect()
      const vx = ((event.clientX - rect.left) / rect.width) * width
      let nearest = 0
      let best = Infinity
      latencies.forEach((p, i) => {
        const distance = Math.abs(x(p.time * 1000) - vx)
        if (distance < best) {
          best = distance
          nearest = i
        }
      })
      const point = latencies[nearest]
      const cx = x(point.time * 1000)
      const cy = y(point.ping)
      hoverGroup.setAttribute('display', 'inline')
      hoverLine.setAttribute('x1', cx)
      hoverLine.setAttribute('x2', cx)
      hoverDot.setAttribute('cx', cx)
      hoverDot.setAttribute('cy', cy)
      tip.hidden = false
      tip.textContent = ''
      tip.appendChild(document.createTextNode(point.ping + 'ms · ' + point.loc + ' '))
      const time = document.createElement('span')
      time.style.cssText = 'opacity:0.7;font-weight:400'
      time.textContent = fmtTimeShort(point.time)
      tip.appendChild(time)
      tip.style.left = (cx / width) * 100 + '%'
      tip.style.top = (cy / height) * 100 + '%'
    })
    svg.addEventListener('mouseleave', () => {
      hoverGroup.setAttribute('display', 'none')
      tip.hidden = true
    })
  }
}

// ---- dropdown factory -----------------------------------------------------

function setupDropdown(box, options, onChange) {
  const trigger = $('[data-dropdown]', box)
  const menu = $('[data-menu]', box)
  const label = $('[data-dropdown-label]', trigger)
  let open = false
  let value = options.length ? options[0].value : ''

  function paint() {
    const selected = options.filter(o => o.value === value)[0]
    label.textContent = selected ? selected.label : '请选择'
    $$('button', menu).forEach(button => button.classList.toggle('selected', button.dataset.value === String(value)))
  }
  // The popup stays in the DOM but [hidden] until opened. Outside-click/Esc
  // listeners exist only while open, so dynamic instances (history dialog)
  // never leak listeners.
  function onOutside(event) {
    if (open && !box.contains(event.target)) setOpen(false)
  }
  function onKey(event) {
    if (open && event.key === 'Escape') setOpen(false)
  }
  function setOpen(next) {
    if (next) {
      const rect = box.getBoundingClientRect()
      const menuHeight = Math.min(options.length * 44 + 12, 264)
      menu.classList.toggle('flip-up', rect.bottom + menuHeight > window.innerHeight && rect.top - menuHeight > 0)
      document.addEventListener('mousedown', onOutside)
      document.addEventListener('keydown', onKey)
    } else {
      document.removeEventListener('mousedown', onOutside)
      document.removeEventListener('keydown', onKey)
    }
    open = next
    trigger.setAttribute('aria-expanded', String(open))
    menu.hidden = !open
  }
  trigger.setAttribute('aria-haspopup', 'listbox')
  trigger.setAttribute('aria-expanded', 'false')
  menu.hidden = true
  trigger.addEventListener('click', () => setOpen(!open))
  options.forEach(option => {
    const item = document.createElement('li')
    const button = document.createElement('button')
    button.type = 'button'
    button.dataset.value = option.value
    button.textContent = option.label
    button.addEventListener('click', () => {
      value = option.value
      paint()
      setOpen(false)
      onChange(value)
    })
    item.appendChild(button)
    menu.appendChild(item)
  })
  paint()
  return {
    get value() { return value },
    set value(next) {
      value = String(next)
      paint()
    },
  }
}

// ---- manage page ----------------------------------------------------------

function initManagePage(bootstrap) {
  const form = $('#monitor-form')
  if (!form) return
  const message = $('[data-message]', form)
  const submitButton = $('[data-submit]', form)
  const cancelButton = $('[data-cancel-edit]', form)
  let loading = false
  let editingId = ''

  const groups = Array.from(new Set(['核心服务'].concat(bootstrap.monitors.map(monitor => monitor.group || '核心服务'))))

  const intervalDropdown = setupDropdown($('[data-interval-box]'), bootstrap.intervalOptions.map(minutes => ({ value: String(minutes), label: minutes + ' 分钟' })), () => {})
  const timeoutDropdown = setupDropdown($('[data-timeout-box]'), bootstrap.timeoutOptions.map(seconds => ({ value: String(seconds), label: seconds + ' 秒' })), () => {})

  // Group suggestion popup.
  const groupBox = $('[data-group-box]', form)
  const groupInput = $('[data-group-input]', form)
  const groupToggle = $('[data-group-toggle]', form)
  const groupSuggest = $('[data-group-suggest]', form)

  function renderGroupSuggestions() {
    const query = groupInput.value.trim().toLowerCase()
    const suggestions = groups.filter(group => group !== groupInput.value.trim() && (query === '' || group.toLowerCase().indexOf(query) !== -1))
    groupSuggest.textContent = ''
    suggestions.forEach(group => {
      const li = document.createElement('li')
      const button = document.createElement('button')
      button.type = 'button'
      const name = document.createElement('span')
      name.textContent = group
      const tag = document.createElement('span')
      tag.style.cssText = 'color:#94a3b8;font-size:12px'
      tag.textContent = '已有分组'
      button.appendChild(name)
      button.appendChild(tag)
      button.addEventListener('click', () => {
        groupInput.value = group
        setGroupSuggestOpen(false)
      })
      li.appendChild(button)
      groupSuggest.appendChild(li)
    })
    groupSuggest.hidden = suggestions.length === 0
  }
  function setGroupSuggestOpen(open) {
    groupToggle.setAttribute('aria-expanded', String(open))
    if (open) renderGroupSuggestions()
    else groupSuggest.hidden = true
  }
  groupInput.addEventListener('focus', () => setGroupSuggestOpen(true))
  groupInput.addEventListener('input', () => setGroupSuggestOpen(true))
  groupToggle.addEventListener('click', () => setGroupSuggestOpen(groupSuggest.hidden))
  document.addEventListener('mousedown', event => {
    if (!groupBox.contains(event.target)) setGroupSuggestOpen(false)
  })
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') setGroupSuggestOpen(false)
  })

  function setMessage(text) {
    message.textContent = text || ''
    message.classList.toggle('show', Boolean(text))
  }
  function setEditing(id) {
    editingId = id
    $('[data-form-title]').textContent = id ? '编辑站点' : '添加站点'
    $('[data-form-hint]').textContent = id ? '修改名称或地址不会丢失历史数据。' : '新站点将在下一轮检查后显示状态。'
    submitButton.textContent = id ? '保存修改' : '保存站点'
    cancelButton.classList.toggle('hidden', !id)
    $$('.monitor-row').forEach(row => row.classList.toggle('editing', row.dataset.row === id))
  }
  // Leave edit mode AND restore pristine defaults (fields + dropdowns).
  function clearEditMode() {
    setEditing('')
    form.reset()
    intervalDropdown.value = 10
    timeoutDropdown.value = 3
    setMessage('')
  }

  bootstrap.monitors.forEach(monitor => {
    const button = $('[data-edit="' + monitor.id + '"]')
    if (!button) return
    button.addEventListener('click', () => {
      if (editingId === monitor.id) {
        clearEditMode()
        return
      }
      setEditing(monitor.id)
      form.elements.name.value = monitor.name
      form.elements.target.value = monitor.target
      form.elements.group.value = monitor.group || '核心服务'
      form.elements.preview.value = monitor.preview || ''
      form.elements.statusPageLink.value = monitor.statusPageLink && monitor.statusPageLink !== monitor.target ? monitor.statusPageLink : ''
      intervalDropdown.value = monitor.intervalMinutes || 10
      timeoutDropdown.value = String(Math.round((monitor.timeout || 3000) / 1000))
      setMessage('正在编辑「' + monitor.name + '」，修改不会影响历史数据。')
      form.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  })
  cancelButton.addEventListener('click', clearEditMode)

  form.addEventListener('submit', async event => {
    event.preventDefault()
    if (loading) return
    loading = true
    setMessage('')
    const payload = {
      name: form.elements.name.value,
      target: form.elements.target.value,
      group: form.elements.group.value,
      preview: form.elements.preview.value,
      statusPageLink: form.elements.statusPageLink.value,
      timeout: Number(timeoutDropdown.value) * 1000,
      intervalMinutes: Number(intervalDropdown.value),
    }
    if (editingId) payload.id = editingId
    try {
      const res = await fetch('/api/monitors', {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || '操作失败')
      location.reload()
    } catch (error) {
      setMessage(error.message)
      loading = false
    }
  })

  $$('[data-remove]').forEach(button => {
    let armed = false
    let timer = null
    button.addEventListener('click', async () => {
      if (!armed) {
        armed = true
        button.textContent = '确认删除？'
        button.classList.add('armed')
        timer = setTimeout(() => {
          armed = false
          button.textContent = '删除'
          button.classList.remove('armed')
        }, 3000)
        return
      }
      clearTimeout(timer)
      if (loading) return
      loading = true
      try {
        const res = await fetch('/api/monitors', {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: button.dataset.remove }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || '删除失败')
        location.reload()
      } catch (error) {
        setMessage(error.message)
        loading = false
        armed = false
        button.textContent = '删除'
        button.classList.remove('armed')
      }
    })
  })
}

// ---- login page -----------------------------------------------------------

function initLoginPage() {
  const form = $('#login-form')
  if (!form) return
  const submitButton = $('[data-submit]', form)
  submitButton.disabled = false
  form.addEventListener('submit', async event => {
    event.preventDefault()
    const message = $('[data-message]', form)
    try {
      const res = await fetch('/api/admin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: form.dataset.hasAdmin === 'true' ? 'login' : 'setup',
          username: form.elements.username.value,
          password: form.elements.password.value,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || '操作失败')
      location.assign('/')
    } catch (error) {
      message.textContent = error.message
      message.classList.add('show')
    }
  })
}

// ---- logout (delegated; the button only exists in the admin nav) -----------

document.addEventListener('click', event => {
  const target = event.target.closest('[data-action="logout"]')
  if (!target) return
  fetch('/api/admin', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'logout' }),
  }).then(() => {
    location.assign('/')
  })
})

// ---- bootstrap -------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  if ($('#login-form')) initLoginPage()

  const el = $('#bootstrap')
  if (!el) return
  let bootstrap
  try {
    bootstrap = JSON.parse(el.textContent)
  } catch (e) {
    return
  }

  if (bootstrap.monitors && $('[data-overall-text]')) initStatusPage(bootstrap)
  else if (bootstrap.monitor && $('[data-detail-status]')) initDetailPage(bootstrap)
  if ($('[data-interval-box]') && $('[data-timeout-box]')) initManagePage(bootstrap)

  // Dialog chrome: close buttons + backdrop click.
  $$('dialog.dlg').forEach(dialog => {
    const close = $('.dlg-close', dialog)
    if (close) close.addEventListener('click', () => dialog.close())
    dialog.addEventListener('click', event => {
      if (event.target === dialog) dialog.close()
    })
  })
})
