'use client'

import { useEffect, useRef, useState } from 'react'
import { ConfirmButton, Input } from './ui'

type ManagedMonitor = {
  id: string
  name: string
  target: string
  group?: string
  preview?: string
  statusPageLink?: string
  timeout?: number
}

type MonitorResponse = {
  monitors?: ManagedMonitor[]
  stored?: ManagedMonitor[]
  error?: string
}

type FormState = {
  name: string
  target: string
  group: string
  preview: string
  statusPageLink: string
  timeout: number // seconds
}

const emptyForm: FormState = {
  name: '',
  target: '',
  group: '核心服务',
  preview: '',
  statusPageLink: '',
  timeout: 5,
}

const timeoutOptions = [3, 5, 10, 15, 30, 60]

export default function MonitorManager() {
  const [monitors, setMonitors] = useState<ManagedMonitor[]>([])
  const [storedIds, setStoredIds] = useState<Set<string>>(new Set())
  const [form, setForm] = useState<FormState>(emptyForm)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)

  const groupOptions = Array.from(
    new Set(['核心服务', ...monitors.map((monitor) => monitor.group || '核心服务')])
  )

  useEffect(() => {
    loadMonitors().catch(() => setMessage('读取监测列表失败'))
  }, [])

  async function loadMonitors() {
    const res = await fetch('/api/monitors', { cache: 'no-store' })
    const data = (await res.json()) as MonitorResponse
    setMonitors(data.monitors ?? [])
    setStoredIds(new Set((data.stored ?? []).map((monitor) => monitor.id)))
  }

  function updateField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  function startEdit(monitor: ManagedMonitor) {
    setEditingId(monitor.id)
    setForm({
      name: monitor.name,
      target: monitor.target,
      group: monitor.group || '核心服务',
      preview: monitor.preview || '',
      statusPageLink:
        monitor.statusPageLink && monitor.statusPageLink !== monitor.target
          ? monitor.statusPageLink
          : '',
      timeout: Math.round((monitor.timeout ?? 4500) / 1000),
    })
    setMessage(`正在编辑「${monitor.name}」，修改不会影响历史数据。`)
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  function cancelEdit() {
    setEditingId(null)
    setForm(emptyForm)
    setMessage('')
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setLoading(true)
    setMessage('')

    try {
      const payload = {
        ...(editingId ? { id: editingId } : {}),
        name: form.name,
        target: form.target,
        group: form.group,
        preview: form.preview,
        statusPageLink: form.statusPageLink,
        timeout: form.timeout * 1000,
      }
      const res = await fetch('/api/monitors', {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = (await res.json()) as MonitorResponse

      if (!res.ok) throw new Error(data.error || (editingId ? '保存失败' : '添加失败'))

      setMessage(
        editingId
          ? '已保存修改。'
          : '已添加。下一轮自动检查（最多 10 分钟）后会生成状态数据。'
      )
      if (!editingId) setForm(emptyForm)
      setEditingId(null)
      await loadMonitors()
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : '操作失败')
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

      if (editingId === id) cancelEdit()
      setMessage('已删除该监测项及其历史数据。')
      await loadMonitors()
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : '删除失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <section
      id="monitor-manager"
      className="mt-10 w-full rounded-[1.75rem] border border-slate-200/80 bg-white/85 p-5 shadow-[0_20px_60px_rgba(15,23,42,0.08)] backdrop-blur sm:p-6"
    >
      <div className="grid gap-8 lg:grid-cols-[0.95fr_1.05fr]">
        <div>
          <h2 className="text-2xl font-semibold tracking-[-0.04em] text-slate-950">
            {editingId ? '编辑站点' : '添加站点'}
          </h2>
          <p className="mt-3 text-sm leading-6 text-slate-600">
            {editingId
              ? '修改名称或地址不会丢失历史数据。'
              : '新站点将在下一轮检查后显示状态。'}
          </p>

          <form ref={formRef} className="mt-6 space-y-4" onSubmit={submit}>
            <Field label="网站名称">
              <Input
                value={form.name}
                onChange={(event) => updateField('name', event.target.value)}
                placeholder="官网"
                maxLength={80}
                className="mt-2"
              />
            </Field>

            <Field label="网站地址">
              <Input
                value={form.target}
                onChange={(event) => updateField('target', event.target.value)}
                placeholder="https://example.com"
                inputMode="url"
                className="mt-2"
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="分组">
                <Input
                  value={form.group}
                  onChange={(event) => updateField('group', event.target.value)}
                  placeholder="核心服务"
                  list="monitor-group-options"
                  className="mt-2"
                />
                <datalist id="monitor-group-options">
                  {groupOptions.map((group) => (
                    <option key={group} value={group} />
                  ))}
                </datalist>
              </Field>

              <Field label="超时时间">
                <select
                  value={form.timeout}
                  onChange={(event) => updateField('timeout', Number(event.target.value))}
                  className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:bg-white"
                >
                  {timeoutOptions.map((seconds) => (
                    <option key={seconds} value={seconds}>
                      {seconds} 秒
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            <Field label="封面图 URL" hint="可粘贴图床地址；留空时自动使用 image.thum.io 生成网站截图。">
              <Input
                value={form.preview}
                onChange={(event) => updateField('preview', event.target.value)}
                placeholder="留空自动生成"
                inputMode="url"
                className="mt-2"
              />
            </Field>

            <Field label="访问链接" hint="状态卡封面点击后打开的地址，留空则使用网站地址。">
              <Input
                value={form.statusPageLink}
                onChange={(event) => updateField('statusPageLink', event.target.value)}
                placeholder="留空使用网站地址"
                inputMode="url"
                className="mt-2"
              />
            </Field>

            <div className="flex gap-2 pt-1">
              <button
                type="submit"
                disabled={loading}
                className="h-11 flex-1 rounded-2xl bg-slate-950 px-5 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
              >
                {loading ? '处理中...' : editingId ? '保存修改' : '保存站点'}
              </button>
              {editingId && (
                <button
                  type="button"
                  onClick={cancelEdit}
                  disabled={loading}
                  className="h-11 rounded-2xl border border-slate-200 bg-white px-5 text-sm font-semibold text-slate-600 transition hover:bg-slate-50 disabled:opacity-50"
                >
                  取消
                </button>
              )}
            </div>

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
              monitors.map((monitor) => {
                const editing = editingId === monitor.id
                return (
                  <div
                    key={monitor.id}
                    className={`flex flex-col gap-3 rounded-2xl border p-4 transition sm:flex-row sm:items-center sm:justify-between ${
                      editing
                        ? 'border-sky-300 bg-sky-50/60 ring-1 ring-sky-200'
                        : 'border-slate-100 bg-slate-50'
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="font-medium text-slate-950">{monitor.name}</div>
                        <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-semibold text-slate-500 ring-1 ring-slate-200">
                          {monitor.group || '核心服务'}
                        </span>
                        {editing && (
                          <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-semibold text-sky-700">
                            编辑中
                          </span>
                        )}
                      </div>
                      <div className="mt-1 break-all text-xs text-slate-500">{monitor.target}</div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        type="button"
                        disabled={loading || !storedIds.has(monitor.id)}
                        onClick={() => (editing ? cancelEdit() : startEdit(monitor))}
                        className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 transition hover:border-sky-200 hover:bg-sky-50 hover:text-sky-700 disabled:cursor-not-allowed disabled:opacity-45"
                      >
                        {editing ? '取消编辑' : '编辑'}
                      </button>
                      {storedIds.has(monitor.id) && (
                        <ConfirmButton onConfirm={() => removeMonitor(monitor.id)} disabled={loading}>
                          删除
                        </ConfirmButton>
                      )}
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>
      </div>
    </section>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-slate-700">{label}</span>
      {children}
      {hint && <span className="mt-2 block text-xs leading-5 text-slate-500">{hint}</span>}
    </label>
  )
}
