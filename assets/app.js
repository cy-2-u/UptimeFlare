/* ================================================================
   UptimeFlare v3.1 client runtime — dependency-free vanilla JS.

   Page branches (by bootstrap + markers):
     status  — hero counters, uptime bars, live poll, dialogs
     detail  — 90d bars, sparkline, badges
     manage  — dropdowns, group suggestions, add/edit/delete
     login   — setup/login submit

   Everything is filled after DOMContentLoaded; the server already
   rendered structure and static text (including nav + per-card
   status), so there is no hydration and no layout swap.
   ================================================================ */
(function () {
  'use strict'

  var $ = function (sel, root) {
    return (root || document).querySelector(sel)
  }
  var $$ = function (sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel))
  }

  // ---- formatting -----------------------------------------------------------

  function fmtTime(sec) {
    return new Date(sec * 1000).toLocaleString('zh-CN', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
  }
  function fmtTimeShort(sec) {
    return new Date(sec * 1000).toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
  }
  function fmtAgo(sec) {
    var s = Math.max(0, Math.floor(Date.now() / 1000 - sec))
    if (s < 60) return s + ' 秒'
    var m = Math.floor(s / 60)
    if (m < 60) return m + ' 分钟'
    var h = Math.floor(m / 60)
    if (h < 24) return h + ' 小时'
    return Math.floor(h / 24) + ' 天'
  }
  function fmtDuration(seconds) {
    var d = Math.floor(seconds / 86400)
    var h = Math.floor((seconds % 86400) / 3600)
    var m = Math.floor((seconds % 3600) / 60)
    var s = Math.floor(seconds % 60)
    var parts = []
    if (d > 0) parts.push(d + ' 天')
    if (h > 0) parts.push(h + ' 小时')
    if (m > 0) parts.push(m + ' 分钟')
    if (s > 0) parts.push(s + ' 秒')
    return parts.join(' ') || '0 秒'
  }
  function fmtDate(sec) {
    return new Date(sec * 1000).toLocaleDateString()
  }

  // ---- uptime math ------------------------------------------------------------

  function overlapLen(x1, x2, y1, y2) {
    return Math.max(0, Math.min(x2, y2) - Math.max(x1, y1))
  }

  function barClass(percent) {
    if (percent < 0) return ''
    if (percent >= 99.9) return 'up'
    if (percent >= 98) return 'up-98'
    if (percent >= 95) return 'warn'
    return 'bad'
  }

  function computeDayStats(incidents, startedAt, nowSec, days) {
    var startTime = startedAt || (incidents.length ? incidents[0].start[0] : nowSec)
    var today = new Date(nowSec * 1000)
    today.setHours(0, 0, 0, 0)
    var todayStart = Math.round(today.getTime() / 1000)
    var stats = []

    for (var i = days - 1; i >= 0; i--) {
      var dayStart = todayStart - i * 86400
      var dayEnd = dayStart + 86400
      var monitorTime = overlapLen(dayStart, dayEnd, startTime, nowSec)
      var downTime = 0
      var dayIncidents = []

      for (var k = 0; k < incidents.length; k++) {
        var incStart = incidents[k].start[0]
        var incEnd = incidents[k].end == null ? nowSec : incidents[k].end
        var overlap = overlapLen(dayStart, dayEnd, incStart, incEnd)
        downTime += overlap

        if (overlap > 0) {
          for (var e = 0; e < incidents[k].error.length; e++) {
            var partStart = Math.max(incidents[k].start[e], dayStart)
            var partEnd = Math.min(
              e === incidents[k].error.length - 1 ? incEnd : incidents[k].start[e + 1],
              dayEnd
            )
            if (overlapLen(dayStart, dayEnd, partStart, partEnd) > 0) {
              dayIncidents.push({
                start: fmtTimeShort(partStart),
                end: fmtTimeShort(partEnd),
                error: incidents[k].error[e],
              })
            }
          }
        }
      }

      stats.push({
        dayStart: dayStart,
        percent: monitorTime === 0 ? -1 : ((monitorTime - downTime) / monitorTime) * 100,
        monitorTime: monitorTime,
        downTime: downTime,
        incidents: dayIncidents,
      })
    }
    return stats
  }

  function renderBars(container, incidents, startedAt, nowSec, days, monitorName) {
    if (!container) return { totalMonitorTime: 0, totalDownTime: 0 }
    container.textContent = ''
    var stats = computeDayStats(incidents, startedAt, nowSec, days)

    stats.forEach(function (day) {
      var bar = document.createElement('div')
      bar.className = 'bar ' + (day.percent === -1 ? '' : barClass(day.percent))

      var tip = document.createElement('span')
      tip.className = 'tip'
      tip.innerHTML =
        '<b>' +
        fmtDate(day.dayStart) +
        (day.percent === -1 ? ' · 无数据' : ' · ' + day.percent.toFixed(2) + '%') +
        '</b>' +
        (day.downTime > 0
          ? '<br><span style="color:#fda4af;font-weight:600">宕机 ' +
            fmtDuration(day.downTime) +
            '</span><br><span style="opacity:0.7">点击查看详情</span>'
          : '')
      bar.appendChild(tip)

      // Keep the tooltip inside the viewport (the shell clips at its edges):
      // measure on hover and shift the centered bubble when it would overflow.
      bar.addEventListener('mouseenter', function () {
        var tipEl = $('.tip', bar)
        if (!tipEl) return
        var barRect = bar.getBoundingClientRect()
        var tipRect = tipEl.getBoundingClientRect()
        var center = barRect.left + barRect.width / 2
        var left = center - tipRect.width / 2
        var right = center + tipRect.width / 2
        var margin = 8
        var shift = 0
        if (left < margin) {
          shift = margin - left
        } else if (right > window.innerWidth - margin) {
          shift = window.innerWidth - margin - right
        }
        tipEl.style.transform = 'translateX(calc(-50% + ' + shift.toFixed(1) + 'px))'
      })

      if (day.downTime > 0) {
        bar.addEventListener('click', function () {
          openDayDialog(day, monitorName)
        })
      }
      container.appendChild(bar)
    })

    var totals = { totalMonitorTime: 0, totalDownTime: 0 }
    stats.forEach(function (day) {
      totals.totalMonitorTime += day.monitorTime
      totals.totalDownTime += day.downTime
    })
    return totals
  }

  // ---- single-day incident dialog ------------------------------------------------

  var dayDialog = $('#day-dialog')

  function openDayDialog(day, monitorName) {
    if (!dayDialog) return
    $('[data-day-sub]', dayDialog).textContent = fmtDate(day.dayStart)
    $('[data-day-title]', dayDialog).textContent = (monitorName ? monitorName + ' · ' : '') + '当日故障'

    var body = $('[data-day-body]', dayDialog)
    body.textContent = ''

    var strip = document.createElement('div')
    strip.className = 'summary-strip'
    strip.innerHTML = '<span>总宕机时间</span><span>' + fmtDuration(day.downTime) + '</span>'
    body.appendChild(strip)

    if (day.incidents.length === 0) {
      var empty = document.createElement('p')
      empty.className = 'empty-state'
      empty.textContent = '这一天没有故障记录。'
      body.appendChild(empty)
    } else {
      day.incidents
        .slice()
        .reverse()
        .forEach(function (incident) {
          var card = document.createElement('div')
          card.className = 'incident-card'
          card.innerHTML =
            '<div class="incident-time" style="margin-top:0"><span>' +
            incident.start +
            '</span><span style="color:#cbd5e1">→</span><span>' +
            incident.end +
            '</span></div><div class="incident-err"></div>'
          $('.incident-err', card).textContent = incident.error
          body.appendChild(card)
        })
    }
    dayDialog.showModal()
  }

  // ---- history dialog ---------------------------------------------------------------

  var historyDialog = $('#history-dialog')
  var historyState = { month: null, monitor: '', page: 1 }

  function monthOf(ms) {
    var d = new Date(ms)
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
  }
  function shiftMonth(month, delta) {
    var parts = month.split('-').map(Number)
    var d = new Date(parts[0], parts[1] - 1 + delta)
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
    var body = $('[data-history-body]', historyDialog)
    body.textContent = ''
    var nowSec = Math.floor(Date.now() / 1000)

    // Monitor filter.
    var toolbar = document.createElement('div')
    toolbar.className = 'dlg-toolbar'
    var select = document.createElement('select')
    select.className = 'dropdown-input'
    var all = document.createElement('option')
    all.value = ''
    all.textContent = '全部站点'
    select.appendChild(all)
    bootstrap.monitors.forEach(function (monitor) {
      var option = document.createElement('option')
      option.value = monitor.id
      option.textContent = monitor.name
      select.appendChild(option)
    })
    select.value = historyState.monitor
    select.addEventListener('change', function () {
      historyState.monitor = select.value
      historyState.page = 1
      renderHistory(bootstrap)
    })
    toolbar.appendChild(select)
    body.appendChild(toolbar)

    // Month navigation.
    var monthBar = document.createElement('div')
    monthBar.className = 'dlg-month'
    var prev = document.createElement('button')
    prev.className = 'btn ghost sm'
    prev.textContent = '‹ 上个月'
    var next = document.createElement('button')
    next.className = 'btn ghost sm'
    next.textContent = '下个月 ›'
    var title = document.createElement('strong')
    title.textContent = historyState.month
    prev.addEventListener('click', function () {
      historyState.month = shiftMonth(historyState.month, -1)
      historyState.page = 1
      renderHistory(bootstrap)
    })
    next.addEventListener('click', function () {
      historyState.month = shiftMonth(historyState.month, 1)
      historyState.page = 1
      renderHistory(bootstrap)
    })
    monthBar.appendChild(prev)
    monthBar.appendChild(title)
    monthBar.appendChild(next)
    body.appendChild(monthBar)

    // Incident list for the month.
    var monthStart = new Date(
      Number(historyState.month.split('-')[0]),
      Number(historyState.month.split('-')[1]) - 1,
      1
    ).getTime() / 1000
    var monthEnd = new Date(
      Number(historyState.month.split('-')[0]),
      Number(historyState.month.split('-')[1]),
      1
    ).getTime() / 1000

    var found = []
    bootstrap.monitors.forEach(function (monitor) {
      var incidents = bootstrap.incident[monitor.id] || []
      incidents.forEach(function (incident) {
        var incidentStart = incident.start[0]
        var incidentEnd = incident.end == null ? nowSec : incident.end
        if (incidentEnd < monthStart || incidentStart >= monthEnd) return
        var errors = incident.error.map(function (error, index) {
          return {
            start: fmtTime(incident.start[index]),
            end: fmtTime(
              index === incident.error.length - 1 ? incidentEnd : incident.start[index + 1]
            ),
            error: error,
          }
        })
        found.push({
          monitorName: monitor.name,
          monitorId: monitor.id,
          start: incidentStart,
          end: incident.end,
          errors: errors,
          duration: incidentEnd - incidentStart,
        })
      })
    })
    found.sort(function (a, b) {
      return b.start - a.start
    })
    var filtered = historyState.monitor
      ? found.filter(function (item) {
          return item.monitorId === historyState.monitor
        })
      : found

    var list = document.createElement('div')
    list.style.cssText = 'display:flex;flex-direction:column;gap:12px'

    if (filtered.length === 0) {
      var none = document.createElement('p')
      none.className = 'empty-state'
      none.textContent = '这个月没有故障记录 🎉'
      list.appendChild(none)
    } else {
      var perPage = 20
      var totalPages = Math.max(1, Math.ceil(filtered.length / perPage))
      if (historyState.page > totalPages) historyState.page = totalPages
      filtered
        .slice((historyState.page - 1) * perPage, historyState.page * perPage)
        .forEach(function (incident) {
          var ongoing = incident.end == null
          var card = document.createElement('div')
          card.className = 'incident-card'
          card.innerHTML =
            '<div class="incident-head"><div class="incident-name">' +
            '<span class="dot ' + (ongoing ? 'dot-down' : 'dot-pending') + '"></span>' +
            incident.monitorName +
            '</div><span class="badge">' +
            (ongoing ? '进行中' : '已恢复') +
            '</span></div>' +
            '<div class="incident-time"><span>' +
            fmtTime(incident.start) +
            '</span><span style="color:#cbd5e1">→</span><span>' +
            (ongoing ? '进行中' : fmtTime(incident.end)) +
            '</span><span style="color:#cbd5e1">|</span><span>' +
            fmtDuration(incident.duration) +
            '</span></div>'
          incident.errors.forEach(function (err) {
            var div = document.createElement('div')
            div.className = 'incident-err'
            div.textContent = err.error
            card.appendChild(div)
          })
          list.appendChild(card)
        })

      if (totalPages > 1) {
        var pager = document.createElement('div')
        pager.style.cssText = 'display:flex;justify-content:center;align-items:center;gap:8px;padding-top:8px'
        var prevBtn = document.createElement('button')
        prevBtn.className = 'btn ghost sm'
        prevBtn.textContent = '‹'
        prevBtn.disabled = historyState.page <= 1
        prevBtn.addEventListener('click', function () {
          historyState.page -= 1
          renderHistory(bootstrap)
        })
        var label = document.createElement('span')
        label.style.cssText = 'font-size:12px;color:#64748b'
        label.textContent = historyState.page + ' / ' + totalPages
        var nextBtn = document.createElement('button')
        nextBtn.className = 'btn ghost sm'
        nextBtn.textContent = '›'
        nextBtn.disabled = historyState.page >= totalPages
        nextBtn.addEventListener('click', function () {
          historyState.page += 1
          renderHistory(bootstrap)
        })
        pager.appendChild(prevBtn)
        pager.appendChild(label)
        pager.appendChild(nextBtn)
        list.appendChild(pager)
      }
    }
    body.appendChild(list)
  }

  // ---- status page ---------------------------------------------------------------------

  function initStatusPage(bootstrap) {
    var overallUp = bootstrap.overallUp
    var overallDown = bootstrap.overallDown
    var lastUpdateSec = bootstrap.lastUpdate || 0

    function paintOverall() {
      var text = $('[data-overall-text]')
      var tone = 'ok'
      var label = '全部服务运行正常'
      var glyph = '✔'
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
      if (text) {
        text.textContent = label
        if (text.parentElement) {
          text.parentElement.className = 'overall' + (tone ? ' ' + tone : '')
        }
      }
      var dot = $('[data-overall-dot]')
      if (dot) dot.className = 'pulse-dot' + (tone ? ' ' + tone : '')
      $$('[data-overall-icon]').forEach(function (el) {
        el.textContent = glyph
      })
      var up = $('[data-overall-up]')
      if (up) {
        up.textContent = overallUp
        up.className = 'summary-num' + (overallUp > 0 ? ' ok' : '')
      }
      var updated = $('[data-updated-at]')
      if (updated && lastUpdateSec) {
        updated.textContent = new Date(lastUpdateSec * 1000).toLocaleString('zh-CN', { hour12: false })
      }
    }

    function paintAgo() {
      if (!lastUpdateSec) return
      $$('[data-ago]').forEach(function (el) {
        el.textContent = fmtAgo(lastUpdateSec) + '前'
      })
    }

    function inMaintenance(monitorId, nowMs) {
      return bootstrap.maintenances.some(function (m) {
        return (
          nowMs >= new Date(m.start).getTime() &&
          (!m.end || nowMs <= new Date(m.end).getTime()) &&
          (m.monitors || []).indexOf(monitorId) !== -1
        )
      })
    }

    // Cards: bars, percent, maintenance-override status, latency, ago.
    bootstrap.monitors.forEach(function (monitor) {
      var card = $('[data-monitor="' + monitor.id + '"]')
      if (!card) return
      var incidents = bootstrap.incident[monitor.id] || []

      var totals = renderBars(
        $('[data-bars]', card),
        incidents,
        (bootstrap.startedAt || {})[monitor.id],
        Math.floor(Date.now() / 1000),
        30,
        monitor.name
      )
      var percent = $('[data-percent]', card)
      if (percent) {
        var value =
          totals.totalMonitorTime > 0
            ? (
                ((totals.totalMonitorTime - totals.totalDownTime) / totals.totalMonitorTime) * 100
              ).toFixed(2)
            : '—'
        percent.textContent = value
        if (value !== '—') percent.innerHTML += '<span style="color:#94a3b8">%</span>'
      }

      if (inMaintenance(monitor.id, Date.now())) {
        var dot = $('[data-dot]', card)
        if (dot) dot.className = 'dot dot-maintenance'
        var statusLabel = $('[data-status-label]', card)
        if (statusLabel) statusLabel.textContent = '维护中'
      }

      var ago = $('[data-ago]', card)
      if (ago && lastUpdateSec) ago.textContent = fmtAgo(lastUpdateSec) + '前'
    })

    // Active maintenance alerts (time-based, regardless of monitor list).
    var alertBox = $('[data-maint-active]')
    if (alertBox) {
      var nowMs = Date.now()
      bootstrap.maintenances
        .filter(function (m) {
          return (
            nowMs >= new Date(m.start).getTime() &&
            (!m.end || nowMs <= new Date(m.end).getTime())
          )
        })
        .forEach(function (m) {
          var div = document.createElement('div')
          div.className = 'maint ' + (m.color || 'amber')
          div.innerHTML =
            '<span class="maint-title">' +
            (m.title || '计划维护') +
            '</span><span class="maint-time">' +
            fmtTime(Math.round(new Date(m.start).getTime() / 1000)) +
            (m.end ? ' → ' + fmtTime(Math.round(new Date(m.end).getTime() / 1000)) : '') +
            '</span><span class="maint-body"></span>'
          $('.maint-body', div).textContent = m.body
          alertBox.appendChild(div)
        })
    }

    paintOverall()
    paintAgo()
    setInterval(function () {
      paintOverall()
      paintAgo()
    }, 30_000)

    var openHistory = $('[data-open-incidents]')
    if (openHistory) {
      openHistory.addEventListener('click', function () {
        openHistoryDialog(bootstrap)
      })
    }

    // Light live updates (overall counters, latency, ago) from the cached API.
    setInterval(async function () {
      try {
        var res = await fetch('/api/data', { cache: 'no-store' })
        if (!res.ok) return
        var data = await res.json()
        overallUp = data.up
        overallDown = data.down
        lastUpdateSec = data.updatedAt || lastUpdateSec
        paintOverall()
        paintAgo()
        data.monitors &&
          Object.keys(data.monitors).forEach(function (id) {
            var card = $('[data-monitor="' + id + '"]')
            var summary = data.monitors[id]
            if (!card || !summary || summary.latency == null) return
            var latency = $('[data-latency]', card)
            latency.textContent = summary.latency + 'ms'
            latency.style.color = summary.latency > 500 ? '#d97706' : '#334155'
          })
      } catch (e) {
        /* offline is fine; the next tick retries */
      }
    }, 120_000)
  }

  // ---- detail page -----------------------------------------------------------------------

  function initDetailPage(bootstrap) {
    var monitor = bootstrap.monitor
    var incidents = bootstrap.incident || []
    var latencies = bootstrap.latency || []
    var nowSec = Math.floor(Date.now() / 1000)

    // Maintenance override for the badge.
    var inMaintenance = (bootstrap.maintenances || []).some(function (m) {
      var t = Date.now()
      return (
        t >= new Date(m.start).getTime() &&
        (!m.end || t <= new Date(m.end).getTime()) &&
        (m.monitors || []).indexOf(monitor.id) !== -1
      )
    })
    if (inMaintenance) {
      var statusBadge = $('[data-detail-status]')
      if (statusBadge) statusBadge.textContent = '维护中'
      var icon = $('[data-detail-icon]')
      if (icon) {
        icon.textContent = '⚠'
        icon.classList.add('warn')
      }
    }

    var totals = renderBars($('[data-bars]'), incidents, bootstrap.startedAt, nowSec, 90, monitor.name)
    var uptime = $('[data-detail-uptime]')
    if (uptime) {
      uptime.textContent =
        totals.totalMonitorTime > 0
          ? '总可用率 ' +
            (
              ((totals.totalMonitorTime - totals.totalDownTime) / totals.totalMonitorTime) * 100
            ).toPrecision(4) +
            '%'
          : '总可用率 —'
    }
    var ago = $('[data-detail-ago]')
    if (ago && bootstrap.lastUpdate) ago.textContent = fmtAgo(bootstrap.lastUpdate) + '前更新'

    // Sparkline with hover crosshair + tooltip.
    var spark = $('[data-sparkline]')
    if (spark && latencies.length >= 2) {
      var width = 720
      var height = 180
      var padX = 10
      var padTop = 14
      var padBottom = 22
      var maxPing = Math.max.apply(
        null,
        latencies
          .map(function (p) {
            return p.ping
          })
          .concat([50])
      )
      var yMax = maxPing * 1.15
      var startTime = latencies[0].time * 1000
      var endTime = latencies[latencies.length - 1].time * 1000
      var span = Math.max(1, endTime - startTime)
      var x = function (ms) {
        return padX + ((ms - startTime) / span) * (width - padX * 2)
      }
      var y = function (ping) {
        return padTop + (1 - ping / yMax) * (height - padTop - padBottom)
      }
      var line = latencies
        .map(function (p, i) {
          return (i === 0 ? 'M' : 'L') + x(p.time * 1000).toFixed(1) + ',' + y(p.ping).toFixed(1)
        })
        .join(' ')

      spark.innerHTML =
        '<svg viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none">' +
        '<defs><linearGradient id="sg" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0%" stop-color="#14b8a6" stop-opacity="0.28"/>' +
        '<stop offset="100%" stop-color="#14b8a6" stop-opacity="0"/></linearGradient></defs>' +
        '<path d="' + line + ' L' + (width - padX) + ',' + (height - padBottom) +
        ' L' + padX + ',' + (height - padBottom) + ' Z" fill="url(#sg)"/>' +
        '<path d="' + line + '" fill="none" stroke="#0d9488" stroke-width="2" vector-effect="non-scaling-stroke"/>' +
        '<g data-hover display="none">' +
        '<line x1="0" x2="0" y1="' + padTop + '" y2="' + (height - padBottom) +
        '" stroke="#0d9488" stroke-opacity="0.35" stroke-width="1" vector-effect="non-scaling-stroke"/>' +
        '<circle r="4" fill="#0d9488" stroke="#fff" stroke-width="2"/>' +
        '</g></svg>' +
        '<div class="spark-tip" hidden></div>' +
        '<div style="position:absolute;left:0;right:0;bottom:0;display:flex;justify-content:space-between;font-size:10px;color:#94a3b8">' +
        '<span>12 小时前</span><span>现在</span></div>'

      var svg = $('svg', spark)
      var hoverGroup = $('[data-hover]', spark)
      var hoverLine = $('line', hoverGroup)
      var hoverDot = $('circle', hoverGroup)
      var tip = $('.spark-tip', spark)

      svg.addEventListener('mousemove', function (event) {
        var rect = svg.getBoundingClientRect()
        var vx = ((event.clientX - rect.left) / rect.width) * width
        var nearest = 0
        var best = Infinity
        latencies.forEach(function (p, i) {
          var distance = Math.abs(x(p.time * 1000) - vx)
          if (distance < best) {
            best = distance
            nearest = i
          }
        })
        var point = latencies[nearest]
        var cx = x(point.time * 1000)
        var cy = y(point.ping)

        hoverGroup.setAttribute('display', 'inline')
        hoverLine.setAttribute('x1', cx)
        hoverLine.setAttribute('x2', cx)
        hoverDot.setAttribute('cx', cx)
        hoverDot.setAttribute('cy', cy)

        tip.hidden = false
        tip.textContent = ''
        tip.appendChild(document.createTextNode(point.ping + 'ms · ' + point.loc + ' '))
        var time = document.createElement('span')
        time.style.cssText = 'opacity:0.7;font-weight:400'
        time.textContent = fmtTimeShort(point.time)
        tip.appendChild(time)
        tip.style.left = (cx / width) * 100 + '%'
        tip.style.top = (cy / height) * 100 + '%'
      })
      svg.addEventListener('mouseleave', function () {
        hoverGroup.setAttribute('display', 'none')
        tip.hidden = true
      })
    }
  }

  // ---- dropdown factory --------------------------------------------------------------------

  function setupDropdown(box, options, onChange) {
    var trigger = $('[data-dropdown]', box)
    var menu = $('[data-menu]', box)
    var label = $('[data-dropdown-label]', trigger)
    var open = false
    var value = options.length ? options[0].value : ''

    function paint() {
      var selected = options.filter(function (o) {
        return o.value === value
      })[0]
      label.textContent = selected ? selected.label : '请选择'
      $$('button', menu).forEach(function (button) {
        button.classList.toggle('selected', button.dataset.value === String(value))
      })
    }

    // The popup lives in the DOM from SSR but stays [hidden] until opened.
    function setOpen(next) {
      if (next) {
        var rect = box.getBoundingClientRect()
        var menuHeight = Math.min(options.length * 44 + 12, 264)
        menu.classList.toggle(
          'flip-up',
          rect.bottom + menuHeight > window.innerHeight && rect.top - menuHeight > 0
        )
      }
      open = next
      trigger.setAttribute('aria-expanded', String(open))
      menu.hidden = !open
    }

    trigger.setAttribute('aria-haspopup', 'listbox')
    trigger.setAttribute('aria-expanded', 'false')
    menu.hidden = true
    trigger.addEventListener('click', function () {
      setOpen(!open)
    })
    document.addEventListener('mousedown', function (event) {
      if (open && !box.contains(event.target)) setOpen(false)
    })
    document.addEventListener('keydown', function (event) {
      if (open && event.key === 'Escape') setOpen(false)
    })

    options.forEach(function (option) {
      var item = document.createElement('li')
      var button = document.createElement('button')
      button.type = 'button'
      button.dataset.value = option.value
      button.textContent = option.label
      button.addEventListener('click', function () {
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
      get value() {
        return value
      },
      set value(next) {
        value = String(next)
        paint()
      },
    }
  }

  // ---- manage page ---------------------------------------------------------------------------

  function initManagePage(bootstrap) {
    var form = $('#monitor-form')
    if (!form) return
    var message = $('[data-message]', form)
    var submitButton = $('[data-submit]', form)
    var cancelButton = $('[data-cancel-edit]', form)
    var loading = false
    var editingId = ''

    // Existing groups for the suggestion popup (list badges + default).
    var groups = Array.from(
      new Set(
        ['核心服务'].concat(
          $$('[data-row]').map(function (row) {
            var badge = $$('.badge', row)[0]
            return badge ? badge.textContent : '核心服务'
          })
        )
      )
    )

    var intervalDropdown = setupDropdown(
      $('[data-interval-box]'),
      bootstrap.intervalOptions.map(function (minutes) {
        return { value: String(minutes), label: minutes + ' 分钟' }
      }),
      function () {}
    )
    var timeoutDropdown = setupDropdown(
      $('[data-timeout-box]'),
      bootstrap.timeoutOptions.map(function (seconds) {
        return { value: String(seconds), label: seconds + ' 秒' }
      }),
      function () {}
    )

    // Group suggestion popup.
    var groupBox = $('[data-group-box]', form)
    var groupInput = $('[data-group-input]', form)
    var groupToggle = $('[data-group-toggle]', form)
    var groupSuggest = $('[data-group-suggest]', form)

    function renderGroupSuggestions() {
      var query = groupInput.value.trim().toLowerCase()
      var suggestions = groups.filter(function (group) {
        return (
          group !== groupInput.value.trim() &&
          (query === '' || group.toLowerCase().indexOf(query) !== -1)
        )
      })
      groupSuggest.textContent = ''
      suggestions.forEach(function (group) {
        var li = document.createElement('li')
        var button = document.createElement('button')
        button.type = 'button'
        var name = document.createElement('span')
        name.textContent = group
        var tag = document.createElement('span')
        tag.style.cssText = 'color:#94a3b8;font-size:12px'
        tag.textContent = '已有分组'
        button.appendChild(name)
        button.appendChild(tag)
        button.addEventListener('click', function () {
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
    groupInput.addEventListener('focus', function () {
      setGroupSuggestOpen(true)
    })
    groupInput.addEventListener('input', function () {
      setGroupSuggestOpen(true)
    })
    groupToggle.addEventListener('click', function () {
      setGroupSuggestOpen(groupSuggest.hidden)
    })
    document.addEventListener('mousedown', function (event) {
      if (!groupBox.contains(event.target)) setGroupSuggestOpen(false)
    })
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') setGroupSuggestOpen(false)
    })

    function setMessage(text) {
      message.textContent = text || ''
      message.classList.toggle('show', Boolean(text))
    }
    function setEditing(id) {
      editingId = id
      $('[data-form-title]').textContent = id ? '编辑站点' : '添加站点'
      $('[data-form-hint]').textContent = id
        ? '修改名称或地址不会丢失历史数据。'
        : '新站点将在下一轮检查后显示状态。'
      submitButton.textContent = id ? '保存修改' : '保存站点'
      cancelButton.classList.toggle('hidden', !id)
      $$('.monitor-row').forEach(function (row) {
        row.classList.toggle('editing', row.dataset.row === id)
      })
    }
    // Leave edit mode AND restore pristine defaults (fields + dropdowns).
    function clearEditMode() {
      setEditing('')
      form.reset()
      intervalDropdown.value = 10
      timeoutDropdown.value = 5
      setMessage('')
    }

    $$('[data-edit]').forEach(function (button) {
      button.addEventListener('click', function () {
        if (editingId === button.dataset.edit) {
          clearEditMode()
          return
        }
        setEditing(button.dataset.edit)
        form.elements.name.value = button.dataset.name
        form.elements.target.value = button.dataset.target
        form.elements.group.value = button.dataset.group
        form.elements.preview.value = button.dataset.preview
        form.elements.statusPageLink.value =
          button.dataset.link && button.dataset.link !== button.dataset.target
            ? button.dataset.link
            : ''
        intervalDropdown.value = button.dataset.interval
        timeoutDropdown.value = String(Math.round(Number(button.dataset.timeout) / 1000))
        setMessage('正在编辑「' + button.dataset.name + '」，修改不会影响历史数据。')
        form.scrollIntoView({ behavior: 'smooth', block: 'start' })
      })
    })
    cancelButton.addEventListener('click', clearEditMode)

    form.addEventListener('submit', async function (event) {
      event.preventDefault()
      if (loading) return
      loading = true
      setMessage('')
      var payload = {
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
        var res = await fetch('/api/monitors', {
          method: editingId ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        var data = await res.json()
        if (!res.ok) throw new Error(data.error || '操作失败')
        location.reload()
      } catch (error) {
        setMessage(error.message)
        loading = false
      }
    })

    $$('[data-remove]').forEach(function (button) {
      var armed = false
      var timer = null
      button.addEventListener('click', async function () {
        if (!armed) {
          armed = true
          button.textContent = '确认删除？'
          button.classList.add('armed')
          timer = setTimeout(function () {
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
          var res = await fetch('/api/monitors', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: button.dataset.remove }),
          })
          var data = await res.json()
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

  // ---- login page ------------------------------------------------------------------------------

  function initLoginPage() {
    var form = $('#login-form')
    if (!form) return
    var submitButton = $('[data-submit]', form)
    submitButton.disabled = false
    form.addEventListener('submit', async function (event) {
      event.preventDefault()
      var message = $('[data-message]', form)
      try {
        var res = await fetch('/api/admin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: form.dataset.hasAdmin === 'true' ? 'login' : 'setup',
            username: form.elements.username.value,
            password: form.elements.password.value,
          }),
        })
        var data = await res.json()
        if (!res.ok) throw new Error(data.error || '操作失败')
        location.assign('/')
      } catch (error) {
        message.textContent = error.message
        message.classList.add('show')
      }
    })
  }

  // ---- logout (delegated; the button only exists in the admin nav) -------------------------------

  document.addEventListener('click', function (event) {
    var target = event.target.closest('[data-action="logout"]')
    if (!target) return
    fetch('/api/admin', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'logout' }),
    }).then(function () {
      location.assign('/')
    })
  })

  // ---- bootstrap ----------------------------------------------------------------------------------

  document.addEventListener('DOMContentLoaded', function () {
    var el = $('#bootstrap')
    if (!el) return
    var bootstrap
    try {
      bootstrap = JSON.parse(el.textContent)
    } catch (e) {
      return
    }

    if (bootstrap.monitors && $('[data-overall-text]')) {
      initStatusPage(bootstrap)
    } else if (bootstrap.monitor && $('[data-detail-status]')) {
      initDetailPage(bootstrap)
    }

    if ($('[data-interval-box]') && $('[data-timeout-box]')) {
      initManagePage(bootstrap)
    }
    if ($('#login-form')) {
      initLoginPage()
    }

    // Dialog chrome: close buttons + backdrop click.
    $$('dialog.dlg').forEach(function (dialog) {
      var close = $('.dlg-close', dialog)
      if (close) {
        close.addEventListener('click', function () {
          dialog.close()
        })
      }
      dialog.addEventListener('click', function (event) {
        if (event.target === dialog) dialog.close()
      })
    })
  })
})()
