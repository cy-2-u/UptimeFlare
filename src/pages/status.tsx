import type { IncidentRecord, MaintenanceConfig, MonitorTarget } from '../types'
import { hostnameOf } from '../util'
import { BootstrapScript } from './bootstrap'

export type StatusBootstrap = {
  lastUpdate: number
  overallUp: number
  overallDown: number
  monitors: MonitorTarget[]
  incident: Record<string, IncidentRecord[]>
  startedAt?: Record<string, number>
  lastPing: Record<string, number>
  maintenances: MaintenanceConfig[]
}

const STATUS_LABEL: Record<string, string> = {
  up: '运行正常',
  down: '宕机',
  pending: '等待检查',
}

function statusOf(
  monitor: MonitorTarget,
  incident: Record<string, IncidentRecord[]>,
  lastStatus: Record<string, 'up' | 'down' | null>
) {
  // An open incident means down even if the latency row has not caught up.
  const incidents = incident[monitor.id]
  if (incidents?.length && incidents[incidents.length - 1].end === null) return 'down'
  return lastStatus[monitor.id] ?? 'pending'
}

function groupIcon(group: string) {
  if (group.includes('基础')) return '🖥'
  if (group.includes('AI')) return '☁'
  if (group.includes('工具')) return '🧩'
  return '🗔'
}

export function StatusPage(props: {
  pageConfigTitle: string
  monitors: MonitorTarget[]
  state: {
    incident: Record<string, IncidentRecord[]>
    lastStatus?: Record<string, 'up' | 'down' | null>
    startedAt?: Record<string, number>
  }
  bootstrap: StatusBootstrap
}) {
  const { monitors, bootstrap } = props
  const total = bootstrap.overallUp + bootstrap.overallDown

  const overall =
    bootstrap.overallUp === 0 && bootstrap.overallDown === 0
      ? { tone: '', icon: '⏳', label: '暂无监测数据' }
      : bootstrap.overallUp === 0
        ? { tone: 'bad', icon: '✖', label: '全部服务不可用' }
        : bootstrap.overallDown === 0
          ? { tone: 'ok', icon: '✔', label: '全部服务运行正常' }
          : {
              tone: 'warn',
              icon: '⚠',
              label: `${bootstrap.overallDown} / ${total} 个服务出现故障`,
            }

  const groups: { name: string; monitors: MonitorTarget[] }[] = []
  for (const monitor of monitors) {
    const name = monitor.group || '核心服务'
    let bucket = groups.find((g) => g.name === name)
    if (!bucket) {
      bucket = { name, monitors: [] }
      groups.push(bucket)
    }
    bucket.monitors.push(monitor)
  }

  return (
    <>
      <section class="hero">
        <div class="hero-left hero-enter">
          <div class="pulse-chip">
            <span
              class={`pulse-dot${overall.tone ? ' ' + overall.tone : ''}`}
              data-overall-dot
            />
            <span>持续监测中</span>
          </div>
          <h1 class="hero-title">{props.pageConfigTitle || '服务状态'}</h1>
          <div class={`overall${overall.tone ? ' ' + overall.tone : ''}`}>
            <span data-overall-icon>{overall.icon}</span>
            <span data-overall-text>{overall.label}</span>
          </div>
          <div class="hero-actions">
            <button type="button" class="btn ghost sm" data-open-incidents>
              🕘 历史故障
            </button>
          </div>
        </div>

        <div class="hero-summary hero-enter">
          <div class="summary-head">
            <span>运行概况</span>
            <span class="emblem" data-overall-icon>
              {overall.icon}
            </span>
          </div>
          <div class="summary-grid">
            <div>
              <div class="summary-num ok" data-overall-up>
                {bootstrap.overallUp}
              </div>
              <div class="summary-label">在线服务</div>
            </div>
            <div>
              <div class="summary-num">{total}</div>
              <div class="summary-label">监测总数</div>
            </div>
          </div>
          <div class="summary-foot">
            数据更新于 <span data-updated-at>—</span>
          </div>
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
                const status = statusOf(monitor, props.state.incident, props.state.lastStatus ?? {})
                const host = hostnameOf(monitor.target)
                const preview =
                  monitor.preview ||
                  (/^https?:\/\//.test(monitor.target)
                    ? `https://image.thum.io/get/width/1200/${monitor.target}`
                    : '')
                const lastPing = bootstrap.lastPing[monitor.id]
                return (
                  <article class="card" data-monitor={monitor.id}>
                    <div class="card-preview">
                      <div class="card-chrome">
                        <span />
                        <span />
                        <span />
                        <span class="chrome-host">{host}</span>
                      </div>
                      <div class="card-shot">
                        {preview ? (
                          <a
                            href={monitor.statusPageLink || monitor.target}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            <img src={preview} alt={monitor.name} loading="lazy" />
                          </a>
                        ) : (
                          <div class="shot-empty">☁</div>
                        )}
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
                      <span class={`dot dot-${status}`} data-dot />
                      <span data-status-label>{STATUS_LABEL[status]}</span>
                      <span class="muted" data-ago />
                      <span class="latency" data-latency>
                        {lastPing ? `${lastPing}ms` : '—'}
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
              当日故障
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

      <BootstrapScript data={props.bootstrap} />
    </>
  )
}
