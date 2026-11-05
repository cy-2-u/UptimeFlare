import type { IncidentRow, MonitorTarget } from '../types'

function hostnameOf(target: string) {
  try {
    return new URL(target).hostname
  } catch {
    return target.split('/')[0]
  }
}

// Single-monitor view (iframe friendly, linked as /m/<id>). The shell is
// server-rendered; bars/sparkline/badges are filled by app.js from the
// embedded bootstrap (visitor-local time formatting).
export function DetailPage(props: {
  monitor: MonitorTarget
  state: {
    incident: Record<string, IncidentRow>
    latency: Record<string, { time: number; ping: number; loc: string }[]>
  }
  bootstrap: string
}) {
  const { monitor, state } = props
  const incidents = state.incident[monitor.id]
  const latencies = state.latency[monitor.id] ?? []
  const hasData = (incidents ? incidents.start.length : 0) > 0 || latencies.length > 0
  const isUp = incidents ? incidents.end[incidents.end.length - 1] === null : false

  return (
    <div class="detail-wrap">
      <a href="/" class="back">
        ← 返回状态页
      </a>

      {hasData ? (
        <article class="detail-card">
          <div class="detail-head">
            <div class="detail-title">
              <span class={`emblem-sm${isUp ? '' : ' bad'}`} data-detail-icon>
                {isUp ? '✔' : '✖'}
              </span>
              <div>
                <div class="detail-name">
                  {monitor.name}
                  {monitor.statusPageLink && (
                    <a
                      href={monitor.statusPageLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      class="ext"
                      aria-label="访问站点"
                    >
                      ↗
                    </a>
                  )}
                </div>
                <p class="muted">{hostnameOf(monitor.target)}</p>
                {monitor.tooltip && <p class="muted">{monitor.tooltip}</p>}
              </div>
            </div>
            <div class="detail-badges">
              <span class="badge" data-detail-status>
                {isUp ? '运行正常' : '宕机'}
              </span>
              <span class="badge" data-detail-uptime>
                总可用率 —
              </span>
              <span class="badge" data-detail-ago>
                — 前更新
              </span>
            </div>
          </div>

          <section>
            <h3 class="sec-title">可用率历史（90 天）</h3>
            <div class="bars wide" data-bars />
          </section>

          {!monitor.hideLatencyChart && (
            <section>
              <h3 class="sec-title">响应时间（近 12 小时）</h3>
              <div class="sparkline" data-sparkline />
            </section>
          )}
        </article>
      ) : (
        <article class="detail-card">
          <h2 class="detail-name">{monitor.name}</h2>
          <p class="muted">暂无监测数据。</p>
        </article>
      )}

      <script
        type="application/json"
        id="bootstrap"
        dangerouslySetInnerHTML={{ __html: props.bootstrap }}
      />
    </div>
  )
}
