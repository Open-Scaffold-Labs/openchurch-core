// Whole civil days between DATE values. The arithmetic uses UTC fields
// of the YYYY-MM-DD parts, never a Date at local midnight, so the
// process timezone cannot move the count.
//
// "Today" is the civil date in the organization's IANA timezone.
// A missing or invalid zone falls back to UTC.

import { civilDateInTimeZone } from './timezone.js'

export function isoDatePrefix(value) {
  if (value == null || value === '') return null
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null
    const y = value.getUTCFullYear()
    const m = String(value.getUTCMonth() + 1).padStart(2, '0')
    const d = String(value.getUTCDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value).trim())
  if (!match) return null
  return `${match[1]}-${match[2]}-${match[3]}`
}

function utcMidnight(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!match) return NaN
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
}

// Signed whole days from startIso to endIso. Same day is 0.
export function civilDaysBetween(startIso, endIso) {
  const start = utcMidnight(startIso)
  const end = utcMidnight(endIso)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return NaN
  return Math.round((end - start) / 86400000)
}

// Inclusive span. 2026-09-27 through 2026-09-27 is 1.
export function inclusiveCivilDays(startIso, endIso) {
  const days = civilDaysBetween(startIso, endIso)
  if (!Number.isFinite(days)) return NaN
  return days + 1
}

// Days from a stored civil day to today's civil day in `timeZone`.
// Same local day is 0. A missing date is null, not zero.
export function daysSinceCivilDay(value, now = new Date(), timeZone) {
  const start = isoDatePrefix(value)
  if (!start) return null
  const today = civilDateInTimeZone(now, timeZone)
  if (!today) return null
  const days = civilDaysBetween(start, today)
  return Number.isFinite(days) ? days : null
}
