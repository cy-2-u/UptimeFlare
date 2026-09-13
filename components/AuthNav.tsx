import Link from 'next/link'
import { useRouter } from 'next/router'
import { IconActivity } from '@tabler/icons-react'
import { pageConfig } from '@/uptime.config'

export default function AuthNav({ isAdmin }: { isAdmin: boolean }) {
  const router = useRouter()

  async function logout() {
    await fetch('/api/admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'logout' }),
    })
    router.replace('/')
  }

  return (
    <header className="relative z-20 mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 pt-7 sm:px-6 lg:px-8">
      <Link href="/" className="flex items-center gap-3 text-sm font-semibold tracking-wide text-slate-700">
        <span className="brand-mark"><IconActivity size={23} stroke={1.7} /></span>
        <span>{pageConfig.title || '服务状态'}</span>
      </Link>
      <div className="flex items-center gap-2">
      {isAdmin && (
        <Link
          href="/manage"
          className="inline-flex h-9 items-center rounded-full border border-slate-200/80 bg-white/80 px-4 text-sm font-semibold text-slate-700 shadow-sm backdrop-blur transition hover:-translate-y-0.5 hover:border-slate-300 hover:bg-white"
        >
          站点管理
        </Link>
      )}
      {isAdmin ? (
        <button
          type="button"
          onClick={logout}
          className="inline-flex h-9 items-center rounded-full bg-slate-950 px-4 text-sm font-semibold text-white shadow-sm transition hover:-translate-y-0.5 hover:bg-slate-800"
        >
          退出
        </button>
      ) : (
        <Link
          href="/login"
          className="inline-flex h-9 items-center rounded-full bg-slate-950 px-4 text-sm font-semibold text-white shadow-sm transition hover:-translate-y-0.5 hover:bg-slate-800"
        >
          登录
        </Link>
      )}
      </div>
    </header>
  )
}
