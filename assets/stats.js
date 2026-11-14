// Uptime math shared with the client test suite (Node runs this file directly).
export function overlapLen(x1, x2, y1, y2) {
  return Math.max(0, Math.min(x2, y2) - Math.max(x1, y1))
}
export function barClass(percent) {
  if (percent < 0) return ''
  if (percent >= 99.9) return 'up'
  if (percent >= 98) return 'up-98'
  if (percent >= 95) return 'warn'
  return 'bad'
}
// Per-day uptime over the trailing `days` days ending at nowSec. Day boundaries
// follow the visitor's local calendar (DST-aware). Segments are raw seconds;
// formatting stays in app.js.
export function dayStats(incidents, startedAt, nowSec, days) {
  const start = startedAt || (incidents.length ? incidents[0].start[0] : nowSec)
  const today = new Date(nowSec * 1000)
  today.setHours(0, 0, 0, 0)
  const stats = []
  for (let i = days - 1; i >= 0; i--) {
    const from = new Date(today)
    from.setDate(from.getDate() - i)
    const to = new Date(from)
    to.setDate(to.getDate() + 1)
    const dayStart = Math.round(from.getTime() / 1000)
    const dayEnd = Math.round(to.getTime() / 1000)
    const monitorTime = overlapLen(dayStart, dayEnd, start, nowSec)
    let downTime = 0
    const segments = []
    for (const incident of incidents) {
      const incidentEnd = incident.end == null ? nowSec : incident.end
      const overlap = overlapLen(dayStart, dayEnd, incident.start[0], incidentEnd)
      downTime += overlap
      if (overlap > 0) {
        for (let e = 0; e < incident.error.length; e++) {
          const partStart = Math.max(incident.start[e], dayStart)
          const partEnd = Math.min(e === incident.error.length - 1 ? incidentEnd : incident.start[e + 1], dayEnd)
          if (overlapLen(dayStart, dayEnd, partStart, partEnd) > 0) segments.push({ start: partStart, end: partEnd, error: incident.error[e] })
        }
      }
    }
    stats.push({ dayStart, percent: monitorTime === 0 ? -1 : ((monitorTime - downTime) / monitorTime) * 100, monitorTime, downTime, segments })
  }
  return stats
}
