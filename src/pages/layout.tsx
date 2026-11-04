import type { PageConfig } from '../types'

// Shared page shell. Server renders structure and non-time text; time-aware
// widgets are filled client-side from the embedded bootstrap JSON (correct
// timezone without hydration).
export function Layout(props: {
  pageConfig: PageConfig
  title: string
  children: unknown
}) {
  return (
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title}</title>
        <link rel="icon" href={props.pageConfig.favicon ?? '/favicon.svg'} />
        <link rel="stylesheet" href="/app.css" />
      </head>
      <body>
        <div class="shell">
          <header class="topbar">
            <a href="/" class="brand">
              <span class="brand-mark" aria-hidden="true">
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
                </svg>
              </span>
              <span>{props.pageConfig.title || '服务状态'}</span>
            </a>
            <nav class="topnav">
              {/* Admin entry is resolved client-side (fetch /api/admin) so the
                  status page stays publicly cacheable at the edge. */}
              <a href="/manage" class="btn ghost hidden" data-when-admin>
                站点管理
              </a>
              <button type="button" class="btn ghost danger-hover hidden" data-action="logout" data-when-admin>
                退出
              </button>
              <a href="/login" class="btn primary" data-login>
                登录
              </a>
            </nav>
          </header>
          <div class="orb orb-a" aria-hidden="true" />
          <div class="orb orb-b" aria-hidden="true" />
          <main>{props.children}</main>
          <footer class="footer">
            <p>
              &copy; {new Date().getFullYear()} {props.pageConfig.title || '服务状态'} · 每 10
              分钟自动检查
            </p>
            <div class="footer-links">
              {(props.pageConfig.links || []).map((link) => (
                <a href={link.link} target="_blank" rel="noopener noreferrer">
                  {link.label}
                </a>
              ))}
              {props.pageConfig.customFooter && (
                <div class="custom-footer" dangerouslySetInnerHTML={{ __html: props.pageConfig.customFooter }} />
              )}
            </div>
          </footer>
        </div>
        <script src="/app.js" defer />
      </body>
    </html>
  )
}
