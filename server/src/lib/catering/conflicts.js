// Liturgical and schedule conflict rules for a parish hall hold.
//
// A conflict is a time (or, for the register, a day) we can place in
// this room. A row whose room we cannot name is reported as unplaced.
// Unplaced is not a conflict, and it is not "nothing that day".
// A feast on the liturgical calendar is context. It does not by itself
// hold a room — the Mass on the parish schedule does.

import { zonedDateTimeToUtc } from '../../utils/timezone.js'

export const SANCTUARY_MASS_TYPES = new Set(['service', 'mass', 'liturgy'])

const MASS_WORD = /mass|worship|liturgy|eucharist|misa/i

export function normPlace(value) {
  return String(value ?? '').trim().toLowerCase()
}

export function intervalsOverlap(aStart, aEnd, bStart, bEnd) {
  if (![aStart, aEnd, bStart, bEnd].every(d => d instanceof Date && Number.isFinite(d.getTime()))) return false
  return aStart < bEnd && bStart < aEnd
}

function parts(instant, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone || 'UTC',
    hourCycle: 'h23',
    weekday: 'long',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const p = {}
  for (const part of fmt.formatToParts(instant)) p[part.type] = part.value
  return p
}

export function civilDateIso(instant, timeZone) {
  const p = parts(instant, timeZone)
  return `${p.year}-${p.month}-${p.day}`
}

export function civilDatesTouched(start, end, timeZone) {
  const dates = []
  const seen = new Set()
  const cursor = new Date(start.getTime())
  // Step by 12 hours so a DST day is not skipped, and cap the walk.
  for (let i = 0; i < 16 && cursor < end; i++) {
    const iso = civilDateIso(cursor, timeZone)
    if (!seen.has(iso)) {
      seen.add(iso)
      dates.push(iso)
    }
    cursor.setTime(cursor.getTime() + 12 * 60 * 60 * 1000)
  }
  const last = civilDateIso(new Date(end.getTime() - 1), timeZone)
  if (!seen.has(last)) dates.push(last)
  return dates
}

function hhmm(value) {
  if (typeof value !== 'string') return null
  const m = /^(\d{2}):(\d{2})/.exec(value.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return `${m[1]}:${m[2]}`
}

function looksLikeMass(row) {
  const type = String(row.service_type ?? row.type ?? '').trim().toLowerCase()
  if (SANCTUARY_MASS_TYPES.has(type)) return true
  const title = String(row.title ?? '')
  const service = String(row.service_type ?? '')
  return MASS_WORD.test(title) || MASS_WORD.test(service)
}

function rowApplies(row, dateIso, weekday) {
  if (row.specific_date) return String(row.specific_date).slice(0, 10) === dateIso
  const recurrence = String(row.recurrence || 'Weekly').trim().toLowerCase()
  if (recurrence === 'once' || recurrence === 'none') return false
  return String(row.day_of_week || '') === weekday
}

function placeRelation(space, location) {
  if (location == null || String(location).trim() === '') return 'blank'
  return normPlace(location) === normPlace(space.name) ? 'match' : 'other'
}

// One schedule row against one civil day. conflict, unplaced, or neither.
export function judgeScheduleRow({ space, dateIso, weekday, bookingStart, bookingEnd, row, timeZone }) {
  if (!rowApplies(row, dateIso, weekday)) return null
  const start = hhmm(row.start_time)
  const end = hhmm(row.end_time)
  if (!start || !end) {
    return { unplaced: { source: 'schedule', title: row.title, date: dateIso, room: 'unknown' } }
  }
  const massStart = zonedDateTimeToUtc(dateIso, start, timeZone)
  const massEnd = zonedDateTimeToUtc(dateIso, end, timeZone)
  if (!massStart || !massEnd || massEnd <= massStart) {
    return { unplaced: { source: 'schedule', title: row.title, date: dateIso, room: 'unknown' } }
  }
  if (!intervalsOverlap(bookingStart, bookingEnd, massStart, massEnd)) return null
  const place = placeRelation(space, row.location)
  if ((place === 'other' || place === 'blank') && weekday === 'Sunday' && looksLikeMass(row) && space.space_kind !== 'sanctuary') {
    return {
      warning: {
        source: 'schedule',
        title: row.title,
        date: dateIso,
        during: 'sunday_mass',
      },
    }
  }
  if (place === 'other') return null
  if (place === 'match') {
    return {
      conflict: {
        source: 'schedule',
        title: row.title,
        date: dateIso,
        starts_at: massStart.toISOString(),
        ends_at: massEnd.toISOString(),
      },
    }
  }
  if (space.space_kind === 'sanctuary' && looksLikeMass(row)) {
    return {
      conflict: {
        source: 'schedule',
        title: row.title,
        date: dateIso,
        starts_at: massStart.toISOString(),
        ends_at: massEnd.toISOString(),
      },
    }
  }
  return { unplaced: { source: 'schedule', title: row.title, date: dateIso, room: 'unknown' } }
}

export function judgeCalendarRow({ space, bookingStart, bookingEnd, row, timeZone }) {
  const dateIso = String(row.date).slice(0, 10)
  const type = String(row.type ?? '').trim().toLowerCase()
  if (type === 'meeting') return null
  const start = hhmm(row.start_time)
  const end = hhmm(row.end_time)
  if (!start || !end) {
    return { unplaced: { source: 'calendar', title: row.title, date: dateIso, room: 'unknown' } }
  }
  const massStart = zonedDateTimeToUtc(dateIso, start, timeZone)
  const massEnd = zonedDateTimeToUtc(dateIso, end, timeZone)
  if (!massStart || !massEnd || massEnd <= massStart) {
    return { unplaced: { source: 'calendar', title: row.title, date: dateIso, room: 'unknown' } }
  }
  if (!intervalsOverlap(bookingStart, bookingEnd, massStart, massEnd)) return null
  if (space.space_kind === 'sanctuary' && SANCTUARY_MASS_TYPES.has(type)) {
    return {
      conflict: {
        source: 'calendar',
        title: row.title,
        date: dateIso,
        starts_at: massStart.toISOString(),
        ends_at: massEnd.toISOString(),
      },
    }
  }
  // SP-224: a one-off Mass on the parish calendar on a Sunday is the same
  // warning a weekly Sunday Mass on the schedule gives a non-sanctuary room.
  // A civil date's weekday does not depend on the zone.
  const sunday = new Date(`${dateIso}T12:00:00Z`).getUTCDay() === 0
  if (sunday && space.space_kind !== 'sanctuary' && looksLikeMass(row)) {
    return { warning: { source: 'calendar', title: row.title, date: dateIso, during: 'sunday_mass' } }
  }
  return { unplaced: { source: 'calendar', title: row.title, date: dateIso, room: 'unknown' } }
}

export function judgeSacramentRow({ space, dates, row, ignoreSacramentId }) {
  if (row.voided_at) return null
  if (ignoreSacramentId != null && Number(row.id) === Number(ignoreSacramentId)) return null
  const dateIso = String(row.date).slice(0, 10)
  if (!dates.includes(dateIso)) return null
  const place = placeRelation(space, row.place)
  if (place === 'other') return null
  if (place === 'blank') {
    return { unplaced: { source: 'sacrament', title: row.type, date: dateIso, room: 'unknown' } }
  }
  return {
    conflict: {
      source: 'sacrament',
      title: row.type,
      date: dateIso,
      // The register names the day and the place, not an hour.
      hour: 'unknown',
    },
  }
}

export function evaluateBookingConflicts({
  space, bookingStart, bookingEnd, timeZone, scheduleRows, calendarRows, sacramentRows,
  liturgicalRows, ignoreSacramentId,
}) {
  const conflicts = []
  const unplaced = []
  const warnings = []
  const dates = civilDatesTouched(bookingStart, bookingEnd, timeZone)
  for (const dateIso of dates) {
    const weekday = parts(zonedDateTimeToUtc(dateIso, '12:00', timeZone) ?? new Date(`${dateIso}T12:00:00Z`), timeZone).weekday
    for (const row of scheduleRows) {
      const judged = judgeScheduleRow({
        space, dateIso, weekday, bookingStart, bookingEnd, row, timeZone,
      })
      if (judged?.conflict) conflicts.push(judged.conflict)
      else if (judged?.warning) warnings.push(judged.warning)
      else if (judged?.unplaced) unplaced.push(judged.unplaced)
    }
  }
  for (const row of calendarRows) {
    const judged = judgeCalendarRow({ space, bookingStart, bookingEnd, row, timeZone })
    if (judged?.conflict) conflicts.push(judged.conflict)
    else if (judged?.warning) warnings.push(judged.warning)
    else if (judged?.unplaced) unplaced.push(judged.unplaced)
  }
  for (const row of sacramentRows) {
    const judged = judgeSacramentRow({ space, dates, row, ignoreSacramentId })
    if (judged?.conflict) conflicts.push(judged.conflict)
    else if (judged?.unplaced) unplaced.push(judged.unplaced)
  }
  const liturgicalStatus = liturgicalRows == null ? 'unknown' : 'known'
  return {
    conflicts,
    warnings,
    unplaced,
    dates,
    liturgical: liturgicalStatus === 'known' ? liturgicalRows : null,
    liturgical_status: liturgicalStatus,
  }
}
