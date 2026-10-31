import Head from 'next/head'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { MonitorTarget } from '@/types/config'
import { pageConfig } from '@/uptime.config'
import OverallStatus from '@/components/OverallStatus'
import MonitorList from '@/components/MonitorList'
import MonitorDetail from '@/components/MonitorDetail'
import Footer from '@/components/Footer'
import AuthNav from '@/components/AuthNav'
import { parseCompacted, uncompact } from '@/lib/state-format'
import { readCompactedStateStr } from '@/util/stateReader'
import { getEffectiveWorkerConfig } from '@/util/runtimeConfig'
import type { RuntimeEnv } from '@/util/runtimeConfig'

// Pages Router requires the (experimental) edge runtime for non-static routes;
// next-on-pages enforces this declaration on every dynamic page.
export const runtime = 'experimental-edge'

// Poll shortly after the 10-minute check cadence so the page never shows data
// older than ~12 minutes; the ticker in each card updates the "x 前" labels.
const STATUS_REFRESH_INTERVAL_MS = 2 * 60 * 1000

export default function Home({
  compactedStateStr,
  monitors,
}: {
  compactedStateStr: string
  monitors: MonitorTarget[]
}) {
  const [monitorId, setMonitorId] = useState('')
  const [state, setState] = useState(() =>
    uncompact(
      parseCompacted(compactedStateStr) ?? {
        lastUpdate: 0,
        overallUp: 0,
        overallDown: 0,
        incident: {},
        latency: {},
      }
    )
  )

  useEffect(() => {
    const readHash = () => {
      const nextId = window.location.hash.substring(1)
      setMonitorId(nextId === 'monitor-manager' ? '' : nextId)
    }

    readHash()
    window.addEventListener('hashchange', readHash)

    const interval = setInterval(async () => {
      try {
        const res = await fetch('/api/status', { cache: 'no-store' })
        const data = (await res.json()) as { compactedStateStr?: string }
        if (data.compactedStateStr) {
          const compacted = parseCompacted(data.compactedStateStr)
          if (compacted) setState(uncompact(compacted))
        }
      } catch (error) {
        console.error('Failed to update status:', error)
      }
    }, STATUS_REFRESH_INTERVAL_MS)

    return () => {
      clearInterval(interval)
      window.removeEventListener('hashchange', readHash)
    }
  }, [])

  // Specify the monitor id in the URL hash to view a single monitor (iframe-friendly).
  if (monitorId) {
    const monitor = monitors.find((item) => item.id === monitorId)
    if (!monitor) {
      return (
        <main className="status-shell flex min-h-screen items-center justify-center text-slate-500">
          未找到监测项：{monitorId}
        </main>
      )
    }
    return (
      <main className="status-shell min-h-screen px-4 py-10 text-slate-950 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-[810px]">
          <Link
            href="/"
            className="mb-6 inline-block text-sm font-semibold text-slate-500 transition-colors hover:text-slate-950"
          >
            返回状态页
          </Link>
          <MonitorDetail monitor={monitor} state={state} />
        </div>
      </main>
    )
  }

  return (
    <>
      <Head>
        <title>{pageConfig.title}</title>
        <link rel="icon" href={pageConfig.favicon ?? '/favicon.ico'} />
      </Head>

      <main className="status-shell min-h-screen text-slate-950">
        <AuthNav />
        <div className="ambient-orb pointer-events-none absolute right-[-6rem] top-20 h-72 w-72 rounded-full bg-blue-200/30 blur-3xl" />
        <div className="ambient-orb pointer-events-none absolute left-[-8rem] top-[28rem] h-80 w-80 rounded-full bg-emerald-200/25 blur-3xl" />
        <div className="mx-auto max-w-7xl px-4 pb-16 sm:px-6 lg:px-8">
          {monitors.length === 0 ? (
            <div className="py-12 sm:py-16">
              <div className="max-w-2xl">
                <p className="text-xs font-semibold uppercase tracking-[0.32em] text-slate-500">
                  Status Board
                </p>
                <h1 className="mt-5 text-5xl font-semibold tracking-[-0.065em] text-slate-950 sm:text-7xl">
                  尚未添加监测站点
                </h1>
                <p className="mt-6 max-w-xl text-base leading-7 text-slate-600">
                  登录后在站点管理中添加需要监测的网站，检查结果会自动出现在这里。
                </p>
              </div>
            </div>
          ) : state.lastUpdate === 0 ? (
            <div className="py-12 sm:py-16">
              <div className="max-w-2xl">
                <h1 className="text-3xl font-bold tracking-tight text-slate-950">
                  等待第一轮检查完成
                </h1>
                <p className="mt-4 max-w-xl text-base leading-7 text-slate-600">
                  监测数据会在第一轮检查（最多 10 分钟）后显示。
                </p>
              </div>
            </div>
          ) : (
            <>
              <OverallStatus state={state} monitors={monitors} />
              <MonitorList monitors={monitors} state={state} />
            </>
          )}
        </div>

        <Footer />
      </main>
    </>
  )
}

export async function getServerSideProps({
  res,
}: {
  res?: { setHeader?: (name: string, value: string) => void }
}) {
  // Status data is public and identical for every visitor, and only changes
  // once per check round — cache it at the edge instead of re-reading D1 for
  // every visitor. Admin-only bits (nav) are resolved client-side.
  res?.setHeader?.('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300')

  const env = process.env as unknown as RuntimeEnv
  const compactedStateStr = (await readCompactedStateStr(env)) ?? ''

  const monitors = (await getEffectiveWorkerConfig(env)).monitors.map((monitor) => ({
    id: monitor.id,
    name: monitor.name,
    method: monitor.method,
    target: monitor.target,
    ...(monitor.tooltip ? { tooltip: monitor.tooltip } : {}),
    ...(monitor.statusPageLink ? { statusPageLink: monitor.statusPageLink } : {}),
    ...(monitor.hideLatencyChart !== undefined ? { hideLatencyChart: monitor.hideLatencyChart } : {}),
    ...(monitor.preview ? { preview: monitor.preview } : {}),
    ...(monitor.group ? { group: monitor.group } : {}),
  }))

  return {
    props: {
      compactedStateStr,
      monitors,
    },
  }
}
