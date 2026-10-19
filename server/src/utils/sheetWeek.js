// Calendar-date arithmetic for the sacristy sheet. ISO dates are civil
// days, so the math uses UTC fields and never the host's local offset.
//
// The printed window is Saturday through Friday so the Saturday vigil
// and the Sunday it serves sit on one sheet. A Sunday-to-Saturday
// window cannot: Saturday is its last day and the Sunday that follows
// is the first day of the next window.

const pad = (n) => String(n).padStart(2, '0')
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/

function formatUtcIso(dt) {
  const year = String(dt.getUTCFullYear()).padStart(4, '0')
  return `${year}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`
}

// A real civil day, written with a 4-digit year. Feb 31 and month 13
// match the shape and still are not days; Date.UTC would roll them
// forward, which is how an impossible start became a query instead of
// a 400. The canonical string must equal the input, so a year that
// does not survive as four digits is not a date we will query.
export function canonicalIsoDate(iso) {
  if (typeof iso !== 'string' || !ISO_RE.test(iso)) return null
  const [ys, ms, ds] = iso.split('-')
  const y = Number(ys)
  const m = Number(ms)
  const d = Number(ds)
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (Number.isNaN(dt.getTime())) return null
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null
  const canonical = formatUtcIso(dt)
  return canonical === iso ? canonical : null
}

// Absent or unrecognizable query text is "no date", the same as before.
// A string that looks like YYYY-MM-DD and is not a real day is invalid:
// the caller returns 400 instead of inventing a window or asking Postgres.
export function readWeeklyDate(value) {
  if (typeof value !== 'string' || value === '') return { date: null, invalid: false }
  if (!ISO_RE.test(value)) return { date: null, invalid: false }
  const date = canonicalIsoDate(value)
  if (!date) return { date: null, invalid: true }
  return { date, invalid: false }
}

export function finiteSpanDays(start, end) {
  const a = Date.parse(start)
  const b = Date.parse(end)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return (b - a) / 86400000
}

export function addIsoDays(iso, n) {
  const canon = canonicalIsoDate(iso)
  if (!canon) return null
  const [y, m, d] = canon.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + n)
  return canonicalIsoDate(formatUtcIso(dt))
}

export function isoWeekday(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

export function usableTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || timeZone.trim() === '') return 'UTC'
  const zone = timeZone.trim()
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return zone
  } catch {
    return 'UTC'
  }
}

// Civil today in the parish zone. en-CA parts are numeric; the zone
// decides which calendar date an instant falls on.
export function orgTodayIso(instant, timeZone) {
  const date = instant instanceof Date ? instant : new Date(instant)
  if (Number.isNaN(date.getTime())) return null
  const zone = usableTimeZone(timeZone)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const pick = (type) => parts.find((p) => p.type === type)?.value
  const y = pick('year')
  const m = pick('month')
  const d = pick('day')
  if (!y || !m || !d) return null
  return `${y}-${m}-${d}`
}

// Saturday that opens the Sat–Fri sheet containing this calendar date.
export function sheetWeekStart(iso) {
  const sinceSaturday = (isoWeekday(iso) + 1) % 7
  return addIsoDays(iso, -sinceSaturday)
}

// Default sheet when the URL has no start: the weekend of the coming
// Sunday, or of today when today is Sunday. Monday through Saturday
// look forward; Sunday stays on the weekend already underway.
// The window opens on that Sunday's vigil Saturday.
export function vigilWeekStart(todayIso) {
  const dow = isoWeekday(todayIso)
  const untilSunday = dow === 0 ? 0 : 7 - dow
  return addIsoDays(todayIso, untilSunday - 1)
}

export function sheetWeekEnd(startIso) {
  return addIsoDays(startIso, 6)
}

// Missing start and end together mean the parish's vigil week.
// One side alone stays a literal 7-day window around the date that
// was sent. An explicit pair is not re-anchored.
export function resolveWeeklyWindow(startQ, endQ, todayIso) {
  if (!startQ && !endQ) {
    const start = vigilWeekStart(todayIso)
    return { start, end: start ? sheetWeekEnd(start) : null }
  }
  if (startQ && !endQ) return { start: startQ, end: sheetWeekEnd(startQ) }
  if (!startQ && endQ) return { start: addIsoDays(endQ, -6), end: endQ }
  return { start: startQ, end: endQ }
}
