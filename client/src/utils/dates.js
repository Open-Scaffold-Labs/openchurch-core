import { canonicalParishTimeZone } from './parishTimeZone'

// Local-date helpers (1.1). Two bug families these exist to kill:
//
//   1. `new Date().toISOString().slice(0, 10)` returns the *UTC* day,
//      which flips to tomorrow (or yesterday) for anyone whose local
//      clock is on the far side of midnight from UTC. On a money or
//      schedule page that's an off-by-one that silently misfiles data.
//
//   2. `new Date('YYYY-MM-DD')` parses the string as UTC midnight, so
//      rendering it back in a negative-offset timezone shows the day
//      *before* the one the user typed.
//
// The helpers below build from the local calendar fields
// (getFullYear/getMonth/getDate) and construct dates at LOCAL midnight,
// so a 'YYYY-MM-DD' string round-trips to the same calendar day the
// user sees. Use these anywhere you need "the local day" — never
// toISOString() for a calendar date, and never new Date(str) for a
// bare date string.
//
// NOTE: these are for calendar dates, not instants. Leave server ISO
// timestamps (created_at etc.) that are genuinely UTC alone.

// Zero-pad a number to 2 digits ('3' → '03').
function pad2(n) {
  return String(n).padStart(2, '0')
}

// 'YYYY-MM-DD' for an arbitrary Date, using its LOCAL calendar fields.
export function toLocalISO(date) {
  const d = date instanceof Date ? date : new Date(date)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

// 'YYYY-MM-DD' for today's LOCAL day. Replaces
// `new Date().toISOString().slice(0, 10)`, which returns the UTC day.
export function todayLocalISO() {
  return toLocalISO(new Date())
}

// Next upcoming Sunday (today when today is Sunday) as a civil YYYY-MM-DD
// in the parish IANA zone. SP-189 / UAT SVC-16: Worship's New-plan date
// should open on the Sunday the office is planning, not a weekday. Falls
// back to UTC when the zone is missing or rejected by Intl — same rule as
// parishTodayIso / the packet default.
export function upcomingSundayISO(timeZone, now = new Date()) {
  let zone = 'UTC'
  if (typeof timeZone === 'string' && timeZone.trim()) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timeZone.trim() })
      zone = timeZone.trim()
    } catch { zone = 'UTC' }
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(now)
  const pick = (type) => parts.find((p) => p.type === type)?.value
  const today = `${pick('year')}-${pick('month')}-${pick('day')}`
  const wd = pick('weekday') // Sun, Mon, ...
  const dow = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[wd]
  if (dow == null) return today
  const daysAhead = dow === 0 ? 0 : 7 - dow
  const [y, m, d] = today.split('-').map(Number)
  const civil = new Date(y, m - 1, d)
  civil.setDate(civil.getDate() + daysAhead)
  return toLocalISO(civil)
}

// Parse a 'YYYY-MM-DD' string into a Date at LOCAL midnight. Replaces
// `new Date('YYYY-MM-DD')`, which parses as UTC and can render a day
// early. Falls back to the raw Date constructor for anything that isn't
// a bare date string (e.g. a full ISO timestamp), which is the correct
// behavior for real instants.
export function parseLocalDate(str) {
  if (typeof str === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str)
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  }
  return new Date(str)
}

// A bare civil day: 'YYYY-MM-DD'. A timestamp is an instant, including
// one that happens to fall on exact midnight UTC. created_at backfills
// of that shape must stay instants (the next local day west of UTC is
// the real clock, not a DATE column).
const BARE_DAY = /^(\d{4})-(\d{2})-(\d{2})$/

// Known DATE columns also arrive as the old node-pg JSON of a DATE on a
// UTC server: 'YYYY-MM-DDT00:00:00.000Z'. That Z is midnight of the
// stored day, not a time of day. Only parseStoredDate accepts it.
const STORED_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:$|T00:00:00(?:\.000)?Z$)/

function dateFromParts(year, month, day) {
  const date = new Date(year, month - 1, day)
  // Overflow (31 Apr, 29 Feb in a common year) must not roll forward.
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null
  return date
}

export function parseCivilDay(value) {
  if (value == null || value === '') return null
  const m = BARE_DAY.exec(String(value).trim())
  if (!m) return null
  return dateFromParts(Number(m[1]), Number(m[2]), Number(m[3]))
}

// A stored DATE column: bare civil day, or the legacy UTC-midnight JSON.
export function parseStoredDate(value) {
  if (value == null || value === '') return null
  const m = STORED_DATE.exec(String(value).trim())
  if (!m) return null
  return dateFromParts(Number(m[1]), Number(m[2]), Number(m[3]))
}

// Range-bound helpers for date-input filters that get sent to the
// server as ISO instants. A bare 'YYYY-MM-DD' parsed with `new Date()`
// is UTC midnight, so an `until` bound would exclude everything logged
// during "today" in a negative-offset zone. These anchor the bound to
// the LOCAL start / end of the selected day, then serialize to ISO.

// Local start-of-day (00:00:00.000) for a 'YYYY-MM-DD' string, as ISO.
export function startOfLocalDayISO(str) {
  const d = parseLocalDate(str)
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

// Local end-of-day (23:59:59.999) for a 'YYYY-MM-DD' string, as ISO —
// so an inclusive `until` bound actually covers the whole selected day.
export function endOfLocalDayISO(str) {
  const d = parseLocalDate(str)
  d.setHours(23, 59, 59, 999)
  return d.toISOString()
}

// Convenience: format a 'YYYY-MM-DD' string for display, at local
// midnight so the day never shifts. `opts` passes through to
// toLocaleDateString; `locale` (BCP-47) defaults to en-US so existing
// call sites are unchanged — pass useLocale().dateLocale for
// language-aware month and weekday names.
export function formatLocalDate(str, opts, locale = 'en-US') {
  if (!str) return ''
  const civil = typeof str === 'string' ? parseCivilDay(str) : null
  return (civil ?? parseLocalDate(str)).toLocaleDateString(
    locale,
    opts ?? { month: 'short', day: 'numeric', year: 'numeric' },
  )
}

// Same display as formatLocalDate, but for a known DATE column. Accepts
// the legacy midnight-Z JSON of that column. Do not use this for
// created_at or any other timestamp.
export function formatStoredDate(str, opts, locale = 'en-US') {
  if (!str) return ''
  const civil = typeof str === 'string' ? parseStoredDate(str) : null
  return (civil ?? parseLocalDate(str)).toLocaleDateString(
    locale,
    opts ?? { month: 'short', day: 'numeric', year: 'numeric' },
  )
}

// Parish calendar day stored on a DATE column (ochr_calendar_events.date,
// mass_date). The column has no time and no zone — it is the day the
// office typed, not an instant in the browser's timezone.
//
// JSON is either "YYYY-MM-DD" or the UTC-midnight form
// "YYYY-MM-DDT00:00:00.000Z". The first ten characters of that form are
// the stored day. Do not re-read them through local Date fields: west
// of UTC, local fields name the day before.
export function calendarDay(value) {
  if (value == null || value === '') return ''
  const s = value instanceof Date && !Number.isNaN(value.getTime())
    ? value.toISOString()
    : String(value).trim()
  const bare = /^(\d{4}-\d{2}-\d{2})$/.exec(s)
  if (bare) return bare[1]
  const utcMidnight = /^(\d{4}-\d{2}-\d{2})T00:00:00(?:\.0+)?Z$/.exec(s)
  return utcMidnight ? utcMidnight[1] : ''
}

// One parish-facing day: weekday, month, day, year. A civil DATE stays
// that stored day in every timezone. A real instant (anything calendarDay
// rejects) is read in the parish zone, or UTC when the zone is unusable.
export const PARISH_DAY_OPTIONS = { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }

export function formatParishDay(value, locale = 'en-US', timeZone) {
  if (value == null || value === '') return ''
  const day = calendarDay(value)
  if (day) return formatStoredDate(day, PARISH_DAY_OPTIONS, locale || 'en-US')
  const zone = canonicalParishTimeZone(typeof timeZone === 'string' ? timeZone : '') || 'UTC'
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString(locale || 'en-US', { ...PARISH_DAY_OPTIONS, timeZone: zone })
}
