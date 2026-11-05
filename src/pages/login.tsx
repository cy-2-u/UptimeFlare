// Login / first-time admin setup. app.js submits to /api/admin; the button
// stays disabled until JS is live so a no-JS visit never dead-ends.
export function LoginPage(props: { hasAdmin: boolean }) {
  const isSetup = !props.hasAdmin
  return (
    <div class="login-wrap">
      <a href="/" class="back">
        ← 返回状态页
      </a>

      <section class="login-card hero-enter">
        <h1>{isSetup ? '设置管理员' : '管理员登录'}</h1>
        <p class="muted">{isSetup ? '创建账号，开始管理站点。' : '登录你的管理账号。'}</p>

        <form class="form" id="login-form" data-has-admin={String(props.hasAdmin)}>
          <label class="field">
            <span>账号</span>
            <input name="username" autocomplete="username" />
          </label>
          <label class="field">
            <span>密码</span>
            <input
              name="password"
              type="password"
              autocomplete={isSetup ? 'new-password' : 'current-password'}
            />
          </label>
          <button type="submit" class="btn primary wide" data-submit disabled>
            {isSetup ? '创建管理员' : '登录'}
          </button>
          <p class="form-message" data-message />
        </form>
      </section>
    </div>
  )
}
