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
  return parseLocalDate(str).toLocaleDateString(
    locale,
    opts ?? { month: 'short', day: 'numeric', year: 'numeric' },
  )
}
