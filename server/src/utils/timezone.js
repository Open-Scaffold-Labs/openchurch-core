import { canonicalParishTimeZone } from '../../../client/src/utils/parishTimeZone.js'

// Resolve a wall-clock date + time in an IANA timezone to the UTC
// instant it names — without a timezone library. Used by reminder
// scheduling so "24h before the 10:00 service" means 10:00 in the
// PARISH's timezone (ochr_organizations.timezone, migration 040), not
// the server's (UTC on Vercel — audit H4).
//
// Method: start from the naive UTC reading, format that instant in the
// target zone, and correct by the observed offset. Two iterations
// handle the DST edge where the first correction lands across a
// transition. Falls back to the naive reading if Intl rejects the zone
// so a bad timezone value can never break event creation.

export function zonedDateTimeToUtc(datePart, hhmm, timeZone) {
  const naive = new Date(`${datePart}T${hhmm}:00Z`)
  if (Number.isNaN(naive.getTime())) return null
  if (!timeZone || timeZone === 'UTC') return naive

  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
    const wallAsUtcMs = (instant) => {
      const p = {}
      for (const part of fmt.formatToParts(instant)) p[part.type] = part.value
      return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second)
    }
    let guess = naive
    for (let i = 0; i < 2; i++) {
      const diff = wallAsUtcMs(guess) - naive.getTime()
      if (diff === 0) break
      guess = new Date(guess.getTime() - diff)
    }
    return guess
  } catch {
    return naive
  }
}

// Civil calendar dates for sample seeding. A DATE column is a parish
// day, not an instant. `Date#toISOString().slice(0, 10)` is the UTC
// day of that instant, so an evening in a zone west of UTC (Saturday
// 23:00 America/Los_Angeles) is stored as the next UTC morning
// (Monday, once "next Sunday" has been added in local fields).
//
// The clock is ochr_organizations.timezone when that value is a real
// IANA zone. The column is NOT NULL DEFAULT 'UTC' (migration 040).
// Signup writes the browser zone when it validates; a missing or
// invalid value stays this fallback. There is no separate app env var for a
// parish timezone — server/.env.example has none, and the packet,
// kiosk, and checklist routes already fall back with
// COALESCE(timezone, 'UTC'). Blank, missing, or invalid values use
// that same fallback.
export const PARISH_TIMEZONE_FALLBACK = 'UTC'

export {
  PARISH_TIMEZONE_ALIASES,
  canonicalParishTimeZone,
  offeredParishTimeZones,
} from '../../../client/src/utils/parishTimeZone.js'

// The same Intl check organization settings used before the Postgres
// list was added. Blank or unknown values are not a parish clock.
// Behaviour matches the helper on #229 so either PR can merge second.
export function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || tz.trim() === '') return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz.trim() })
    return true
  } catch {
    return false
  }
}

// Signup stores UTC when this is not ok. Settings returns 400.
// Call this on the pool, before BEGIN. A catalog error must not abort
// the signup transaction. The test seam replaces the catalog query.
let parishTimeZoneLookupForTests = null
export function _setParishTimeZoneLookupForTests(fn) {
  parishTimeZoneLookupForTests = fn
}

export async function acceptedParishTimeZone(db, raw) {
  const candidate = canonicalParishTimeZone(raw)
  if (!candidate) return { ok: false, zone: PARISH_TIMEZONE_FALLBACK }
  try {
    const result = parishTimeZoneLookupForTests
      ? await parishTimeZoneLookupForTests(db, candidate)
      : await db.query(
        'SELECT 1 FROM pg_timezone_names WHERE name = $1',
        [candidate]
      )
    const rows = result?.rows
    if (!rows?.length) return { ok: false, zone: PARISH_TIMEZONE_FALLBACK }
    return { ok: true, zone: candidate }
  } catch {
    return { ok: false, zone: PARISH_TIMEZONE_FALLBACK }
  }
}

export function resolveParishTimeZone(orgTimezone) {
  const tz = typeof orgTimezone === 'string' ? orgTimezone.trim() : ''
  if (!tz || !isValidTimeZone(tz)) return PARISH_TIMEZONE_FALLBACK
  return tz
}

// YYYY-MM-DD for an instant as the wall calendar reads it in the
// parish zone. Intl's timeZone option does not use the process TZ.
export function civilDateInTimeZone(instant, timeZone) {
  const date = instant instanceof Date ? instant : new Date(instant)
  if (Number.isNaN(date.getTime())) return null
  const zone = resolveParishTimeZone(timeZone)
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  })
  const p = {}
  for (const part of fmt.formatToParts(date)) p[part.type] = part.value
  return `${p.year}-${p.month}-${p.day}`
}

// 0 = Sunday … 6 = Saturday, in `timeZone`. en-US short names are
// stable (Sun, Mon, …); they are not shown to anyone.
const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

export function weekdayInTimeZone(instant, timeZone) {
  const zone = resolveParishTimeZone(timeZone)
  const name = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    weekday: 'short',
  }).format(instant)
  const idx = WEEKDAY_INDEX[name]
  if (idx === undefined) {
    throw new Error(`Could not read the weekday in ${zone}`)
  }
  return idx
}

// Add calendar days to a YYYY-MM-DD string. The arithmetic is on the
// civil date itself (UTC fields of a date-only instant), so the
// process timezone cannot move the day.
export function addCivilDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return null
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
