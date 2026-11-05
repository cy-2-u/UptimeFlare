import type { MonitorTarget } from '../types'

const TIMEOUT_OPTIONS = [3, 5, 10, 15, 30, 60]
const INTERVAL_OPTIONS = [10, 20, 30, 60]

// Manage page: SSR renders the list + form skeleton; app.js handles the
// add/edit/delete flows (fetch + reload). Editing never loses history.
export function ManagePage(props: { monitors: MonitorTarget[] }) {
  return (
    <div class="manage-wrap">
      <a href="/" class="back">
        ← 返回状态页
      </a>
      <section class="manage-card">
        <div class="manage-grid">
          <div>
            <h2 class="form-title" data-form-title>
              添加站点
            </h2>
            <p class="muted" data-form-hint>
              新站点将在下一轮检查后显示状态。
            </p>

            <form class="form" id="monitor-form" data-editing="">
              <label class="field">
                <span>网站名称</span>
                <input name="name" placeholder="官网" maxlength={80} />
              </label>
              <label class="field">
                <span>网站地址</span>
                <input name="target" placeholder="https://example.com" inputmode="url" />
              </label>
              <div class="field-row">
                <label class="field">
                  <span>分组</span>
                  <div class="relative" data-group-box>
                    <input name="group" placeholder="核心服务" autocomplete="off" data-group-input />
                    <button
                      type="button"
                      class="chevron-btn"
                      aria-label="展开分组建议"
                      aria-expanded="false"
                      data-group-toggle
                    >
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M3.5 6l4.5 4.5L12.5 6" />
                      </svg>
                    </button>
                    <ul class="suggest" data-group-suggest hidden />
                  </div>
                </label>
                <label class="field">
                  <span>检查间隔</span>
                  <div class="relative" data-interval-box>
                    <button type="button" class="dropdown" data-dropdown="interval" aria-haspopup="listbox" aria-expanded="false">
                      <span data-dropdown-label>10 分钟</span>
                      <svg
                        class="chev"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.8"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M3.5 6l4.5 4.5L12.5 6" />
                      </svg>
                    </button>
                    <ul class="menu" data-menu="interval" hidden />
                  </div>
                </label>
              </div>
              <div class="field-row">
                <label class="field">
                  <span>超时时间</span>
                  <div class="relative" data-timeout-box>
                    <button type="button" class="dropdown" data-dropdown="timeout" aria-haspopup="listbox" aria-expanded="false">
                      <span data-dropdown-label>5 秒</span>
                      <svg
                        class="chev"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.8"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M3.5 6l4.5 4.5L12.5 6" />
                      </svg>
                    </button>
                    <ul class="menu" data-menu="timeout" hidden />
                  </div>
                </label>
                <label class="field">
                  <span>封面图 URL</span>
                  <input name="preview" placeholder="留空自动生成" inputmode="url" />
                  <span class="hint">可粘贴图床地址；留空时自动使用 image.thum.io 生成网站截图。</span>
                </label>
              </div>
              <label class="field">
                <span>访问链接</span>
                <input name="statusPageLink" placeholder="留空使用网站地址" inputmode="url" />
                <span class="hint">状态卡封面点击后打开的地址。</span>
              </label>

              <div class="form-actions">
                <button type="submit" class="btn primary wide" data-submit>
                  保存站点
                </button>
                <button type="button" class="btn ghost hidden" data-cancel-edit>
                  取消
                </button>
              </div>
              <p class="form-message" data-message />
            </form>
          </div>

          <div>
            <div class="list-head">
              <h3>当前监测列表</h3>
              <span class="badge" data-count>
                {props.monitors.length} 个
              </span>
            </div>
            <div class="monitor-list" data-list>
              {props.monitors.length === 0 ? (
                <p class="empty">当前还没有网站。</p>
              ) : (
                props.monitors.map((monitor) => (
                  <div class="monitor-row" data-row={monitor.id}>
                    <div class="min-w-0">
                      <div class="row-title">
                        <strong>{monitor.name}</strong>
                        <span class="badge">{monitor.group || '核心服务'}</span>
                        <span class="badge">{monitor.intervalMinutes ?? 10} 分钟</span>
                      </div>
                      <div class="row-target">{monitor.target}</div>
                    </div>
                    <div class="row-actions">
                      <button
                        type="button"
                        class="btn ghost sm"
                        data-edit={monitor.id}
                        data-name={monitor.name}
                        data-target={monitor.target}
                        data-group={monitor.group || '核心服务'}
                        data-preview={monitor.preview || ''}
                        data-link={monitor.statusPageLink || ''}
                        data-timeout={monitor.timeout ?? 4500}
                        data-interval={monitor.intervalMinutes ?? 10}
                      >
                        编辑
                      </button>
                      <button type="button" class="btn danger sm" data-remove={monitor.id}>
                        删除
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </section>
      <script
        type="application/json"
        id="bootstrap"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            timeoutOptions: TIMEOUT_OPTIONS,
            intervalOptions: INTERVAL_OPTIONS,
          }).replace(/</g, '\\u003c'),
        }}
      />
    </div>
  )
}
