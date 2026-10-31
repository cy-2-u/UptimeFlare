import Head from 'next/head'
import Link from 'next/link'
import MonitorManager from '@/components/MonitorManager'
import { getRequestCookieHeader, isAdminRequest } from '@/util/auth'
import type { RuntimeEnv } from '@/util/runtimeConfig'

export const runtime = 'experimental-edge'

export default function ManagePage() {
  return (
    <>
      <Head>
        <title>站点管理 - 服务状态</title>
      </Head>
      <main className="status-shell min-h-screen px-4 py-10 text-slate-950 sm:px-6 lg:px-8">
        <div className="ambient-orb pointer-events-none absolute right-[-6rem] top-20 h-72 w-72 rounded-full bg-blue-200/30 blur-3xl" />
        <div className="mx-auto max-w-6xl">
          <Link
            href="/"
            className="text-sm font-semibold text-slate-500 transition-colors hover:text-slate-950"
          >
            返回状态页
          </Link>

          <MonitorManager />
        </div>
      </main>
    </>
  )
}

export async function getServerSideProps({
  req,
  res,
}: {
  req: { headers?: unknown; cookies?: Record<string, string> }
  res?: { setHeader?: (name: string, value: string) => void }
}) {
  res?.setHeader?.('Cache-Control', 'private, no-store')
  const env = process.env as unknown as RuntimeEnv
  if (await isAdminRequest(env, getRequestCookieHeader(req))) return { props: {} }

  return {
    redirect: {
      destination: '/login',
      permanent: false,
    },
  }
}
