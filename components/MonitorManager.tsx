import { FormEvent, useEffect, useRef, useState } from 'react'

type ManagedMonitor = {
  id: string
  name: string
  target: string
  group?: string
  preview?: string
}

type MonitorResponse = {
  monitors?: ManagedMonitor[]
  stored?: ManagedMonitor[]
  error?: string
}

export default function MonitorManager() {
  const [monitors, setMonitors] = useState<ManagedMonitor[]>([])
  const [storedIds, setStoredIds] = useState<Set<string>>(new Set())
  const [name, setName] = useState('')
  const [target, setTarget] = useState('')
  const [group, setGroup] = useState('核心服务')
  const [preview, setPreview] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const [groupOpen, setGroupOpen] = useState(false)
  const groupBoxRef = useRef<HTMLDivElement>(null)

  const groupOptions = Array.from(
    new Set(['核心服务', ...monitors.map((monitor) => monitor.group || '核心服务')])
  )

  async function loadMonitors() {
    const res = await fetch('/api/monitors')
    const data = (await res.json()) as MonitorResponse
    setMonitors(data.monitors ?? [])
    setStoredIds(new Set((data.stored ?? []).map((monitor) => monitor.id)))
  }

  function getErrorMessage(error: unknown, fallback: string) {
    return error instanceof Error ? error.message : fallback
  }

  useEffect(() => {
    loadMonitors().catch(() => setMessage('读取监测列表失败'))
  }, [])

  useEffect(() => {
    function closeGroupOptions(event: MouseEvent) {
      if (!groupBoxRef.current?.contains(event.target as Node)) setGroupOpen(false)
    }

    document.addEventListener('mousedown', closeGroupOptions)
    return () => document.removeEventListener('mousedown', closeGroupOptions)
  }, [])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setLoading(true)
    setMessage('')

    try {
      const res = await fetch('/api/monitors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, target, group, preview }),
      })
      const data = (await res.json()) as MonitorResponse

      if (!res.ok) throw new Error(data.error || '添加失败')

      setName('')
      setTarget('')
      setGroup('核心服务')
      setPreview('')
      setMessage('已添加。下一次 10 分钟自动检查后会生成状态数据。')
      await loadMonitors()
    } catch (error: unknown) {
      setMessage(getErrorMessage(error, '添加失败'))
    } finally {
      setLoading(false)
    }
  }

  async function removeMonitor(id: string) {
    setLoading(true)
    setMessage('')

    try {
      const res = await fetch('/api/monitors', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      const data = (await res.json()) as MonitorResponse

      if (!res.ok) throw new Error(data.error || '删除失败')

      setMessage('已删除该监测项。')
      await loadMonitors()
    } catch (error: unknown) {
      setMessage(getErrorMessage(error, '删除失败'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <section
      id="monitor-manager"
      className="mt-10 w-full rounded-[1.75rem] border border-slate-200/80 bg-white/85 p-5 shadow-[0_20px_60px_rgba(15,23,42,0.08)] backdrop-blur sm:p-6"
    >
      <div className="grid gap-7 lg:grid-cols-[0.95fr_1.05fr]">
        <div>
          <h2 className="text-2xl font-semibold tracking-[-0.04em] text-slate-950">
            站点管理
          </h2>
          <p className="mt-3 text-sm leading-6 text-slate-600">
            新站点将在下一轮检查后显示状态。
          </p>

          <form className="mt-6 space-y-4" onSubmit={submit}>
            <label className="block">
              <span className="text-sm font-medium text-slate-700">网站名称</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="官网"
                className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm outline-none transition focus:border-slate-400 focus:bg-white"
              />
            </label>

            <div className="relative" ref={groupBoxRef}>
              <span className="text-sm font-medium text-slate-700">分组</span>
              <div className="relative mt-2">
                <input
                  value={group}
                  onChange={(event) => setGroup(event.target.value)}
                  onFocus={() => setGroupOpen(true)}
                  placeholder="核心服务"
                  className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 pr-11 text-sm outline-none transition focus:border-slate-400 focus:bg-white"
                />
                <button
                  type="button"
                  onClick={() => setGroupOpen((open) => !open)}
                  className="absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-xl text-slate-500 transition hover:bg-white hover:text-slate-950"
                  aria-label="选择分组"
                >
                  <span className={`text-xs transition-transform ${groupOpen ? 'rotate-180' : ''}`}>▼</span>
                </button>
              </div>
              {groupOpen && (
                <div className="absolute z-20 mt-2 w-full overflow-hidden rounded-2xl border border-slate-200 bg-white/95 p-1.5 shadow-[0_18px_55px_rgba(15,23,42,0.12)] backdrop-blur">
                  {groupOptions.map((item) => (
                    <button
                      key={item}
                      type="button"
                      onClick={() => {
                        setGroup(item)
                        setGroupOpen(false)
                      }}
                      className={`flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-sm transition ${
                        item === group
                          ? 'border border-sky-200 bg-sky-50 font-semibold text-sky-700'
                          : 'text-slate-600 hover:bg-slate-100 hover:text-slate-950'
                      }`}
                    >
                      <span>{item}</span>
                      <span className="text-xs text-slate-400">已有分组</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <label className="block">
              <span className="text-sm font-medium text-slate-700">封面图 URL</span>
              <input
                value={preview}
                onChange={(event) => setPreview(event.target.value)}
                placeholder="留空自动生成网站截图"
                className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm outline-none transition focus:border-slate-400 focus:bg-white"
              />
              <span className="mt-2 block text-xs leading-5 text-slate-500">
                可粘贴图床地址；留空时自动使用 image.thum.io 生成网站截图。
              </span>
            </label>

            <label className="block">
              <span className="text-sm font-medium text-slate-700">网站地址</span>
              <input
                value={target}
                onChange={(event) => setTarget(event.target.value)}
                placeholder="https://example.com"
                className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm outline-none transition focus:border-slate-400 focus:bg-white"
              />
            </label>

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-2xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
            >
              {loading ? '处理中...' : '保存站点'}
            </button>

            {message && (
              <p className="rounded-2xl bg-slate-100 px-4 py-3 text-sm text-slate-700">{message}</p>
            )}
          </form>
        </div>

        <div>
          <div className="flex items-center justify-between gap-4">
            <h3 className="text-lg font-semibold text-slate-950">当前监测列表</h3>
            <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">
              {monitors.length} 个
            </span>
          </div>

          <div className="mt-4 space-y-3">
            {monitors.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-slate-200 p-5 text-sm text-slate-500">
                当前还没有网站。
              </p>
            ) : (
              monitors.map((monitor) => (
                <div
                  key={monitor.id}
                  className="flex flex-col gap-3 rounded-2xl border border-slate-100 bg-slate-50 p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="font-medium text-slate-950">{monitor.name}</div>
                      <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-semibold text-slate-500 ring-1 ring-slate-200">
                        {monitor.group || '核心服务'}
                      </span>
                    </div>
                    <div className="mt-1 break-all text-xs text-slate-500">{monitor.target}</div>
                  </div>
                  <button
                    type="button"
                    disabled={loading || !storedIds.has(monitor.id)}
                    onClick={() => removeMonitor(monitor.id)}
                    className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 transition hover:border-rose-200 hover:bg-rose-50 hover:text-rose-700 disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:border-slate-200 disabled:hover:bg-transparent disabled:hover:text-slate-600"
                  >
                    {storedIds.has(monitor.id) ? '删除' : '配置项'}
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </section>
  )
}
