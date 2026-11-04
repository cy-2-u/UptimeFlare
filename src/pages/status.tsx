import type { IncidentRow, MaintenanceConfig, MonitorTarget } from '../types'

export type StatusBootstrap = {
  lastUpdate: number
  overallUp: number
  overallDown: number
  monitors: MonitorTarget[]
  incident: Record<string, IncidentRow>
  latency: Record<string, { time: number; ping: number; loc: string }[]>
  startedAt?: Record<string, number>
  maintenances: MaintenanceConfig[]
}

function hostnameOf(target: string) {
  try {
    return new URL(target).hostname
  } catch {
    return target.split('/')[0]
  }
}

function groupIcon(group: string) {
  if (group.includes('基础')) return '🖥'
  if (group.includes('AI')) return '☁'
  if (group.includes('工具')) return '🧩'
  return '🗔'
}

// Status badge text/class from the server (timezone-free judgement). The
// maintenance override is applied client-side from the bootstrap data.
function statusOf(monitor: MonitorTarget, state: StatusPageProps['state']) {
  const incidents = state.incident[monitor.id]
  if (!incidents || incidents.start.length === 0) return 'pending'
  return incidents.end[incidents.end.length - 1] === null ? 'down' : 'up'
}

type StatusPageProps = {
  pageConfigTitle: string
  monitors: MonitorTarget[]
  state: {
    incident: Record<string, IncidentRow>
    latency: Record<string, { time: number; ping: number; loc: string }[]>
    startedAt?: Record<string, number>
  }
  bootstrap: StatusBootstrap
}

const STATUS_LABEL: Record<string, string> = {
  up: '运行正常',
  down: '宕机',
  pending: '等待检查',
  maintenance: '维护中',
}

export function StatusPage(props: StatusPageProps) {
  const { monitors, state, bootstrap } = props
  const total = bootstrap.overallUp + bootstrap.overallDown

  const groups: { name: string; monitors: MonitorTarget[] }[] = []
  const grouped = new Set<string>()
  // Static config groups keep their order via the monitor.group field.
  for (const monitor of monitors) {
    const name = monitor.group || '核心服务'
    let bucket = groups.find((g) => g.name === name)
    if (!bucket) {
      bucket = { name, monitors: [] }
      groups.push(bucket)
    }
    bucket.monitors.push(monitor)
    grouped.add(monitor.id)
  }

  return (
    <>
      <section class="hero">
        <div class="hero-left hero-enter">
          <div class="pulse-chip">
            <span class="pulse-dot" data-overall-dot />
            <span>每 10 分钟检查一轮</span>
          </div>
          <h1 class="hero-title">{props.pageConfigTitle || '服务状态'}</h1>
          <div class={`overall ${bootstrap.overallDown === 0 ? 'ok' : bootstrap.overallUp === 0 ? 'bad' : 'warn'}`}>
            <span data-overall-icon>⏳</span>
            <span data-overall-text>加载中…</span>
          </div>
          <div class="hero-actions">
            <button type="button" class="btn ghost" data-open-incidents>
              🕘 历史故障
            </button>
          </div>
        </div>
        <div class="hero-summary hero-enter">
          <div class="summary-head">
            <span>运行概况</span>
            <span class="emblem" data-overall-icon>
              ⏳
            </span>
          </div>
          <div class="summary-grid">
            <div>
              <div class="summary-num" data-overall-up>
                {bootstrap.overallUp}
              </div>
              <div class="summary-label">在线服务</div>
            </div>
            <div>
              <div class="summary-num">{total}</div>
              <div class="summary-label">监测总数</div>
            </div>
          </div>
          <div class="summary-foot">数据更新于 <span data-updated-at>—</span></div>
        </div>
      </section>

      <div class="groups">
        {groups.map((group) => (
          <section class="group">
            <div class="group-head">
              <div class="group-mark">{groupIcon(group.name)}</div>
              <h2>{group.name}</h2>
            </div>
            <div class="cards">
              {group.monitors.map((monitor) => {
                const status = statusOf(monitor, state)
                const host = hostnameOf(monitor.target)
                const preview =
                  monitor.preview ||
                  (/^https?:\/\//.test(monitor.target)
                    ? `https://image.thum.io/get/width/1200/${monitor.target}`
                    : '')
                return (
                  <article class="card" data-monitor={monitor.id}>
                    <div class="card-preview">
                      <div class="card-chrome">
                        <span /> <span /> <span />
                        <span class="chrome-host">{host}</span>
                      </div>
                      <div class="card-shot">
                        {preview ? (
                          <a href={monitor.statusPageLink || monitor.target} target="_blank" rel="noopener noreferrer">
                            <img src={preview} alt={monitor.name} loading="lazy" />
                          </a>
                        ) : (
                          <div class="shot-empty">☁</div>
                        )}
                      </div>
                      <div class={`pill pill-${status}`} data-pill>
                        <span class="dot" />
                        <span data-pill-label>{STATUS_LABEL[status]}</span>
                      </div>
                    </div>
                    <div class="card-head">
                      <div class="min-w-0">
                        <h3>{monitor.name}</h3>
                        <div class="host">{host}</div>
                      </div>
                      <span class="badge">{monitor.group || '核心服务'}</span>
                    </div>
                    <div class="card-bars">
                      <div class="bars-meta">
                        <span>近 30 天</span>
                        <span class="mono" data-percent>
                          —
                        </span>
                      </div>
                      <div class="bars" data-bars />
                    </div>
                    <div class="card-foot">
                      <span class="dot" data-dot />
                      <span data-status-label>{STATUS_LABEL[status]}</span>
                      <span class="muted" data-ago />
                      <span class="latency" data-latency>
                        -
                      </span>
                    </div>
                  </article>
                )
              })}
            </div>
          </section>
        ))}
      </div>

      <div class="maint-alerts" data-maint-active />

      {/* Single-day incident dialog (opened by clicking a bar with downtime). */}
      <dialog class="dlg" id="day-dialog">
        <div class="dlg-head">
          <div>
            <div class="dlg-sub" data-day-sub />
            <div class="dlg-title" data-day-title>
              故障记录
            </div>
          </div>
          <button type="button" class="dlg-close" aria-label="关闭">
            ✕
          </button>
        </div>
        <div class="dlg-body" data-day-body />
      </dialog>

      {/* Global history dialog (opened from the hero button). */}
      <dialog class="dlg" id="history-dialog">
        <div class="dlg-head">
          <div>
            <div class="dlg-sub">History</div>
            <div class="dlg-title">历史故障</div>
          </div>
          <button type="button" class="dlg-close" aria-label="关闭">
            ✕
          </button>
        </div>
        <div class="dlg-body" data-history-body />
      </dialog>

      <script
        type="application/json"
        id="bootstrap"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(props.bootstrap).replace(/</g, '\\u003c') }}
      />
    </>
  )
}
