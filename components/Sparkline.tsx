'use client'

import { useMemo, useState } from 'react'
import { LatencyRecord } from '@/types/config'

// Dependency-free SVG latency chart. Replaced chart.js + moment (~100KB gz)
// with ~5KB of code that renders the same line + area and shows the check
// location on hover.
export default function Sparkline({
  points,
  height = 180,
  hours = 12,
}: {
  points: LatencyRecord[]
  height?: number
  hours?: number
}) {
  const [hover, setHover] = useState<number | null>(null)

  const width = 720
  const padX = 10
  const padTop = 14
  const padBottom = 22

  const chart = useMemo(() => {
    if (points.length < 2) return null

    const maxPing = Math.max(...points.map((p) => p.ping), 50)
    const yMax = maxPing * 1.15
    const startTime = points[0].time * 1000
    const endTime = points[points.length - 1].time * 1000
    const timeSpan = Math.max(1, endTime - startTime)

    const x = (timeMs: number) => padX + ((timeMs - startTime) / timeSpan) * (width - padX * 2)
    const y = (ping: number) => padTop + (1 - ping / yMax) * (height - padTop - padBottom)

    const coords = points.map((point) => ({ ...point, cx: x(point.time * 1000), cy: y(point.ping) }))
    const line = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.cx.toFixed(1)},${c.cy.toFixed(1)}`).join(' ')
    const area = `${line} L${coords[coords.length - 1].cx.toFixed(1)},${height - padBottom} L${coords[0].cx.toFixed(1)},${height - padBottom} Z`

    const gridLines = [0.25, 0.5, 0.75].map((fraction) => ({
      y: padTop + fraction * (height - padTop - padBottom),
      ping: Math.round(yMax * (1 - fraction)),
    }))

    return { coords, line, area, gridLines, yMax }
  }, [points, height])

  if (!chart) {
    return (
      <div
        className="flex items-center justify-center rounded-2xl border border-dashed border-slate-200 text-sm text-slate-400"
        style={{ height }}
      >
        暂无足够的延迟数据
      </div>
    )
  }

  const hoverPoint = hover !== null ? chart.coords[hover] : null

  return (
    <div className="relative select-none" style={{ height }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-full w-full overflow-visible"
        preserveAspectRatio="none"
        onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          const ratio = (event.clientX - rect.left) / rect.width
          const x = ratio * width
          let nearest = 0
          let best = Infinity
          chart.coords.forEach((coord, index) => {
            const distance = Math.abs(coord.cx - x)
            if (distance < best) {
              best = distance
              nearest = index
            }
          })
          setHover(nearest)
        }}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id="sparkline-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#14b8a6" stopOpacity="0.28" />
            <stop offset="100%" stopColor="#14b8a6" stopOpacity="0" />
          </linearGradient>
        </defs>

        {chart.gridLines.map((grid) => (
          <g key={grid.y}>
            <line
              x1={padX}
              x2={width - padX}
              y1={grid.y}
              y2={grid.y}
              stroke="#e2e8f0"
              strokeDasharray="5 6"
              strokeWidth="1"
            />
            <text x={padX + 4} y={grid.y - 4} fontSize="10" fill="#94a3b8">
              {grid.ping}ms
            </text>
          </g>
        ))}

        <path d={chart.area} fill="url(#sparkline-fill)" />
        <path d={chart.line} fill="none" stroke="#0d9488" strokeWidth="2" vectorEffect="non-scaling-stroke" />

        {hoverPoint && (
          <g>
            <line
              x1={hoverPoint.cx}
              x2={hoverPoint.cx}
              y1={padTop}
              y2={height - padBottom}
              stroke="#0d9488"
              strokeOpacity="0.35"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
            <circle cx={hoverPoint.cx} cy={hoverPoint.cy} r="4" fill="#0d9488" stroke="#fff" strokeWidth="2" />
          </g>
        )}
      </svg>

      {hoverPoint && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-xl bg-slate-950/90 px-3 py-1.5 text-xs font-semibold text-white shadow-xl"
          style={{
            left: `${(hoverPoint.cx / width) * 100}%`,
            top: `${(hoverPoint.cy / height) * 100}%`,
            marginTop: '-8px',
          }}
        >
          {hoverPoint.ping}ms · {hoverPoint.loc}
          <span className="ml-1 font-normal text-slate-300">
            {new Date(hoverPoint.time * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
      )}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-between px-1 text-[10px] text-slate-400">
        <span>{hours} 小时前</span>
        <span>现在</span>
      </div>
    </div>
  )
}
