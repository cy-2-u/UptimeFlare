import Head from 'next/head'

import { Inter } from 'next/font/google'
import { useEffect, useState } from 'react'
import { MonitorTarget } from '@/types/config'
import { maintenances, pageConfig } from '@/uptime.config'
import OverallStatus from '@/components/OverallStatus'
import MonitorList from '@/components/MonitorList'
import { Text } from '@mantine/core'
import MonitorDetail from '@/components/MonitorDetail'
import Footer from '@/components/Footer'
import { useTranslation } from 'react-i18next'
import { CompactedMonitorStateWrapper, getFromStore } from '@/worker/src/store'
import { getEffectiveWorkerConfig } from '@/util/runtimeConfig'
import type { RuntimeEnv } from '@/util/runtimeConfig'
import AuthNav from '@/components/AuthNav'
import { isAdminRequest } from '@/util/auth'

export const runtime = 'experimental-edge'
const inter = Inter({ subsets: ['latin'] })
const STATUS_REFRESH_INTERVAL_MS = 10 * 60 * 1000

export default function Home({
  compactedStateStr,
  monitors,
  isAdmin,
}: {
  compactedStateStr: string
  monitors: MonitorTarget[]
  isAdmin: boolean
  tooltip?: string
  statusPageLink?: string
}) {
  const { t } = useTranslation('common')
  const [monitorId, setMonitorId] = useState('')
  const [state, setState] = useState(() =>
    new CompactedMonitorStateWrapper(compactedStateStr).uncompact()
  )

  useEffect(() => {
    const readHash = () => {
      const nextId = window.location.hash.substring(1)
      setMonitorId(nextId === 'monitor-manager' ? '' : nextId)
    }

    readHash()

    const handleHashChange = readHash
    window.addEventListener('hashchange', handleHashChange)

    // Poll status updates every 10 minutes to match the Worker cron schedule.
    const interval = setInterval(async () => {
      try {
        const res = await fetch('/api/status')
        const data = (await res.json()) as { compactedStateStr: string }
        if (data.compactedStateStr) {
          const newState = new CompactedMonitorStateWrapper(data.compactedStateStr).uncompact()
          setState(newState)
        }
      } catch (error) {
        console.error('Failed to update status:', error)
      }
    }, STATUS_REFRESH_INTERVAL_MS)

    return () => {
      clearInterval(interval)
      window.removeEventListener('hashchange', handleHashChange)
    }
  }, [])

  // Specify monitorId in URL hash to view a specific monitor (can be used in iframe)
  if (monitorId) {
    const monitor = monitors.find((monitor) => monitor.id === monitorId)
    if (!monitor || !state) {
      return <Text fw={700}>{t('Monitor not found', { id: monitorId })}</Text>
    }
    return (
      <div style={{ maxWidth: '810px' }}>
        <MonitorDetail monitor={monitor} state={state} />
      </div>
    )
  }

  return (
    <>
      <Head>
        <title>{pageConfig.title}</title>
        <link rel="icon" href={pageConfig.favicon ?? '/favicon.ico'} />
      </Head>

      <main className={`${inter.className} status-shell min-h-screen text-slate-950`}>
        <AuthNav isAdmin={isAdmin} />
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
                  登录后添加需要监测的站点。
                </p>
              </div>
            </div>
          ) : state.lastUpdate === 0 ? (
            <div className="py-12 sm:py-16">
              <div className="max-w-2xl">
                <Text fw={800} size="xl" c="dark.8">
                  {t('Monitor State not defined')}
                </Text>
                <Text mt="sm" size="md" c="dimmed">
                  首次检查完成后显示监测数据。
                </Text>
              </div>
            </div>
          ) : (
            <>
              <OverallStatus state={state} monitors={monitors} maintenances={maintenances} />
              <MonitorList monitors={monitors} state={state} />
            </>
          )}
        </div>

        <Footer />
      </main>
    </>
  )
}

export async function getServerSideProps({ req }: { req: { headers: { cookie?: string } } }) {
  const env = process.env as unknown as RuntimeEnv
  // Read state as string from storage, to avoid hitting server-side cpu time limit
  const compactedStateStr = await getFromStore(env, 'state')

  // Only present these values to client
  const monitors = (await getEffectiveWorkerConfig(env)).monitors.map((monitor) => {
    return {
      id: monitor.id,
      name: monitor.name,
      method: monitor.method,
      target: monitor.target,
      ...(monitor.tooltip ? { tooltip: monitor.tooltip } : {}),
      ...(monitor.statusPageLink ? { statusPageLink: monitor.statusPageLink } : {}),
      ...(monitor.hideLatencyChart !== undefined ? { hideLatencyChart: monitor.hideLatencyChart } : {}),
      ...(monitor.preview ? { preview: monitor.preview } : {}),
      ...(monitor.group ? { group: monitor.group } : {}),
    }
  })

  return {
    props: {
      compactedStateStr,
      monitors,
      isAdmin: await isAdminRequest(env, req.headers.cookie),
    },
  }
}
