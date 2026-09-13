import Head from 'next/head'
import Link from 'next/link'
import { FormEvent, useEffect, useState } from 'react'
import { useRouter } from 'next/router'

type AdminStatus = {
  hasAdmin: boolean
  isAuthenticated: boolean
  error?: string
}

export default function LoginPage() {
  const router = useRouter()
  const [status, setStatus] = useState<AdminStatus | null>(null)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    fetch('/api/admin')
      .then(async (res) => (await res.json()) as AdminStatus)
      .then((data) => {
        setStatus(data)
        if (data.isAuthenticated) router.replace('/')
      })
      .catch(() => setMessage('读取管理员状态失败'))
  }, [router])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setLoading(true)
    setMessage('')

    try {
      const action = status?.hasAdmin ? 'login' : 'setup'
      const res = await fetch('/api/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, username, password }),
      })
      const data = (await res.json()) as AdminStatus
      if (!res.ok) throw new Error(data.error || '登录失败')
      router.replace('/')
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : '登录失败')
    } finally {
      setLoading(false)
    }
  }

  const isSetup = status ? !status.hasAdmin : false

  return (
    <>
      <Head>
        <title>{isSetup ? '设置管理员' : '管理员登录'} - 服务状态</title>
      </Head>
      <main className="status-shell min-h-screen px-4 py-8 text-slate-950 sm:px-6 lg:px-8">
        <div className="ambient-orb pointer-events-none absolute right-[-6rem] top-20 h-72 w-72 rounded-full bg-blue-200/30 blur-3xl" />
        <div className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-7xl items-center justify-center">
          <section className="w-full max-w-md rounded-[2rem] border border-white/70 bg-white/85 p-6 shadow-[0_24px_70px_rgba(15,23,42,0.10)] backdrop-blur-xl sm:p-8">
            <Link href="/" className="text-sm font-semibold text-slate-500 transition hover:text-slate-950">
              返回状态页
            </Link>
            <h1 className="mt-8 text-4xl font-semibold tracking-[-0.055em] text-slate-950">
              {isSetup ? '设置管理员' : '管理员登录'}
            </h1>
            <p className="mt-3 text-sm leading-6 text-slate-600">
              {isSetup
                ? '创建账号，开始管理站点。'
                : '登录你的管理账号。'}
            </p>

            <form className="mt-7 space-y-4" onSubmit={submit}>
              <label className="block">
                <span className="text-sm font-medium text-slate-700">账号</span>
                <input
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoComplete="username"
                  className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm outline-none transition focus:border-slate-400 focus:bg-white"
                />
              </label>
              <label className="block">
                <span className="text-sm font-medium text-slate-700">密码</span>
                <input
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  type="password"
                  autoComplete={isSetup ? 'new-password' : 'current-password'}
                  className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm outline-none transition focus:border-slate-400 focus:bg-white"
                />
              </label>
              <button
                type="submit"
                disabled={loading || !status}
                className="w-full rounded-2xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
              >
                {loading ? '处理中...' : isSetup ? '创建管理员' : '登录'}
              </button>
              {message && (
                <p className="rounded-2xl bg-slate-100 px-4 py-3 text-sm text-slate-700">{message}</p>
              )}
            </form>
          </section>
        </div>
      </main>
    </>
  )
}
