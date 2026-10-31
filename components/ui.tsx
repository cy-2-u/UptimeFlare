'use client'

import {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react'

// ---------------------------------------------------------------------------
// Lightweight Tailwind-only primitives. Replaced Mantine to cut bundle size;
// every interactive piece renders identically during SSR and on the client
// (time-based bits take a fallback "now" until mounted, see useNow).
// ---------------------------------------------------------------------------

type ButtonVariant = 'primary' | 'ghost' | 'subtle' | 'danger' | 'dangerSolid'

const buttonVariants: Record<ButtonVariant, string> = {
  primary:
    'bg-slate-950 text-white shadow-sm hover:-translate-y-0.5 hover:bg-slate-800 active:translate-y-0',
  ghost:
    'border border-slate-200/80 bg-white/80 text-slate-700 shadow-sm backdrop-blur hover:-translate-y-0.5 hover:border-slate-300 hover:bg-white active:translate-y-0',
  subtle: 'text-slate-600 hover:bg-slate-100 hover:text-slate-950',
  danger:
    'border border-slate-200 bg-white text-slate-600 hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600',
  dangerSolid: 'bg-rose-600 text-white shadow-sm hover:bg-rose-500',
}

export function Button({
  variant = 'primary',
  size = 'md',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'sm' | 'md' }) {
  const sizing = size === 'sm' ? 'h-8 px-3 text-xs' : 'h-10 px-4 text-sm'
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-1.5 rounded-xl font-semibold transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 ${sizing} ${buttonVariants[variant]} ${className}`}
    />
  )
}

export function Badge({
  tone = 'slate',
  children,
  className = '',
}: {
  tone?: 'slate' | 'emerald' | 'rose' | 'amber' | 'sky'
  children: ReactNode
  className?: string
}) {
  const tones: Record<string, string> = {
    slate: 'bg-slate-100 text-slate-600',
    emerald: 'bg-emerald-100 text-emerald-700',
    rose: 'bg-rose-100 text-rose-700',
    amber: 'bg-amber-100 text-amber-700',
    sky: 'bg-sky-100 text-sky-700',
  }
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  )
}

// CSS-only tooltip (hover), so 30+ uptime bars stay cheap. Requires the parent
// to not clip overflow.
export function Tooltip({
  label,
  children,
  className = '',
  wide = false,
}: {
  label: ReactNode
  children: ReactNode
  className?: string
  wide?: boolean
}) {
  return (
    <span className={`group/tt relative inline-flex ${className}`}>
      {children}
      <span
        role="tooltip"
        className={`pointer-events-none invisible absolute bottom-full left-1/2 z-50 mb-2 -translate-x-1/2 scale-95 rounded-xl bg-slate-950/90 px-3 py-2 text-left text-xs leading-5 text-white opacity-0 shadow-xl backdrop-blur transition-all duration-150 group-hover/tt:visible group-hover/tt:scale-100 group-hover/tt:opacity-100 ${
          wide ? 'w-max max-w-[16rem] whitespace-normal' : 'whitespace-nowrap'
        }`}
      >
        {label}
      </span>
    </span>
  )
}

export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  children,
  wide = false,
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  subtitle?: ReactNode
  children: ReactNode
  wide?: boolean
}) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (open) setVisible(true)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [open, onClose])

  if (!open && !visible) return null

  return (
    <div className={open ? '' : 'pointer-events-none'}>
      <div
        className={`fixed inset-0 z-40 bg-slate-950/25 backdrop-blur-sm transition-opacity duration-300 ${
          open ? 'opacity-100' : 'opacity-0'
        }`}
        onClick={onClose}
      />
      <aside
        className={`fixed right-0 top-0 z-50 flex h-full w-full flex-col bg-[#f8fafc] shadow-2xl transition-transform duration-300 ease-out ${
          wide ? 'max-w-2xl' : 'max-w-xl'
        } ${open ? 'translate-x-0' : 'translate-x-full'}`}
        onTransitionEnd={() => {
          if (!open) setVisible(false)
        }}
      >
        <header className="flex items-start justify-between gap-4 border-b border-slate-200/80 bg-white/85 px-6 py-5 backdrop-blur">
          <div className="min-w-0">
            {subtitle && (
              <div className="text-[11px] font-bold uppercase tracking-[0.24em] text-slate-400">
                {subtitle}
              </div>
            )}
            <div className="mt-1 text-xl font-extrabold tracking-[-0.03em] text-slate-950">
              {title}
            </div>
          </div>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-950"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
      </aside>
    </div>
  )
}

export function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div
      className={`grid transition-[grid-template-rows] duration-300 ease-out ${
        open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
      }`}
    >
      <div className="overflow-hidden">{children}</div>
    </div>
  )
}

export type DropdownOption = { value: string; label: string }

// Custom dropdown popup replacing the native <select>. Same visual language
// as the rest of the UI, chevron tucked inside (right-4), keyboard navigation
// (arrows/Enter/Escape), outside-click close, and flips up when the viewport
// bottom is too close.
export function Dropdown({
  value,
  onChange,
  options,
  placeholder = '请选择',
  ariaLabel,
  className = '',
  triggerClassName = '',
  menuClassName = '',
}: {
  value: string
  onChange: (value: string) => void
  options: DropdownOption[]
  placeholder?: string
  ariaLabel?: string
  className?: string
  triggerClassName?: string
  menuClassName?: string
}) {
  const [open, setOpen] = useState(false)
  const [flipUp, setFlipUp] = useState(false)
  const [highlight, setHighlight] = useState(-1)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLUListElement>(null)
  const selected = options.find((option) => option.value === value)

  useEffect(() => {
    if (!open) return
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  useEffect(() => {
    if (!open) setHighlight(-1)
  }, [open])

  function openMenu() {
    if (rootRef.current) {
      const rect = rootRef.current.getBoundingClientRect()
      const menuHeight = Math.min(options.length * 44 + 12, 264)
      setFlipUp(rect.bottom + menuHeight > window.innerHeight && rect.top - menuHeight > 0)
    }
    setOpen(true)
  }

  function choose(optionValue: string) {
    onChange(optionValue)
    setOpen(false)
  }

  function onKeyDown(event: ReactKeyboardEvent) {
    if (!open) {
      if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
        event.preventDefault()
        openMenu()
      }
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlight((current) => {
        const next = (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
        menuRef.current?.children[next]?.scrollIntoView({ block: 'nearest' })
        return next
      })
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (highlight >= 0) choose(options[highlight].value)
      else setOpen(false)
    }
  }

  return (
    <div ref={rootRef} className={`relative ${className}`} onKeyDown={onKeyDown}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => (open ? setOpen(false) : openMenu())}
        className={`flex h-11 w-full items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white px-4 pr-12 text-sm text-slate-800 outline-none transition hover:border-slate-300 focus:border-slate-400 ${triggerClassName}`}
      >
        <span className={`truncate ${selected ? '' : 'text-slate-400'}`}>
          {selected?.label ?? placeholder}
        </span>
      </button>
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={`pointer-events-none absolute right-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
      >
        <path d="M3.5 6l4.5 4.5L12.5 6" />
      </svg>

      {open && (
        <ul
          ref={menuRef}
          role="listbox"
          className={`absolute left-0 right-0 z-40 max-h-64 overflow-y-auto rounded-2xl border border-slate-200/80 bg-white/95 p-1.5 shadow-[0_18px_55px_rgba(15,23,42,0.14)] backdrop-blur ${
            flipUp ? 'bottom-full mb-2' : 'top-full mt-2'
          } ${menuClassName}`}
        >
          {options.map((option, index) => {
            const isSelected = option.value === value
            const isHighlighted = index === highlight
            return (
              <li key={option.value || `option-${index}`} role="option" aria-selected={isSelected}>
                <button
                  type="button"
                  onClick={() => choose(option.value)}
                  onMouseEnter={() => setHighlight(index)}
                  className={`flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2.5 text-left text-sm transition ${
                    isSelected
                      ? 'border border-sky-200 bg-sky-50 font-semibold text-sky-700'
                      : isHighlighted
                        ? 'bg-slate-100 text-slate-900'
                        : 'text-slate-600'
                  }`}
                >
                  <span className="truncate">{option.label}</span>
                  {isSelected && (
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="h-3.5 w-3.5 shrink-0"
                    >
                      <path d="M2.5 8.5l3.5 3.5L13.5 4.5" />
                    </svg>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

export function Input({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-slate-400 focus:bg-white ${className}`}
    />
  )
}

// Two-click destructive confirmation without a modal.
export function ConfirmButton({
  onConfirm,
  children,
  confirmLabel = '确认删除？',
  disabled,
  className = '',
}: {
  onConfirm: () => void
  children: ReactNode
  confirmLabel?: string
  disabled?: boolean
  className?: string
}) {
  const [arming, setArming] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  function click() {
    if (!arming) {
      setArming(true)
      timer.current = setTimeout(() => setArming(false), 3000)
      return
    }
    if (timer.current) clearTimeout(timer.current)
    setArming(false)
    onConfirm()
  }

  return (
    <Button
      type="button"
      variant={arming ? 'dangerSolid' : 'danger'}
      size="sm"
      disabled={disabled}
      onClick={click}
      className={className}
    >
      {arming ? confirmLabel : children}
    </Button>
  )
}

// Live clock that stays `fallback` until mounted, so server-rendered markup
// and the first client render always agree.
export function useNow(tickMs = 30_000, fallback = 0) {
  const [now, setNow] = useState<number>(fallback)

  useEffect(() => {
    setNow(Date.now())
    const interval = setInterval(() => setNow(Date.now()), tickMs)
    return () => clearInterval(interval)
  }, [tickMs])

  return now
}

export function formatDuration(seconds: number) {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)

  const parts = []
  if (d > 0) parts.push(`${d} 天`)
  if (h > 0) parts.push(`${h} 小时`)
  if (m > 0) parts.push(`${m} 分钟`)
  if (s > 0) parts.push(`${s} 秒`)
  return parts.join(' ') || '0 秒'
}

export function formatTimeAgo(timestampSec: number, nowMs: number) {
  const seconds = Math.max(0, Math.floor(nowMs / 1000 - timestampSec))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时`
  return `${Math.floor(hours / 24)} 天`
}
