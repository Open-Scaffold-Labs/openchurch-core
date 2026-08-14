// Lectionary resolver (LEC.1) — the Ordo lookup, computed.
//
// Given a date, answers the question a secretary opens the physical Ordo
// to answer on Thursday afternoon: WHICH Sunday is this, in which reading
// cycle? e.g. "Ninth Sunday after Pentecost · Proper 11 · Year C".
//
// Scope decision (deliberate): this resolver computes the DESIGNATION and
// CYCLE only — it does not emit scripture citations. The designation is
// the lookup key; wrong-but-confident citations in front of clergy would
// be worse than none. A verified RCL citations dataset can slot into
// `readings` later without changing this module's contract.
//
// Follows the Revised Common Lectionary conventions used by our Episcopal
// and Lutheran targets (Sundays after Pentecost + date-anchored Propers).
// All math is UTC, anchored on the same Easter computus as the liturgical
// calendar (imported, not re-implemented — they can never disagree).

import { computeEaster, adventStart } from '../routes/liturgical.js'

const DAY = 86400000
const addDays = (d, n) => new Date(d.getTime() + n * DAY)
const utc = (dateStr) => new Date(dateStr + 'T00:00:00Z')
const sameDay = (a, b) => a.getTime() === b.getTime()

const ORDINALS = [
  '', 'First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh',
  'Eighth', 'Ninth', 'Tenth', 'Eleventh', 'Twelfth', 'Thirteenth',
  'Fourteenth', 'Fifteenth', 'Sixteenth', 'Seventeenth', 'Eighteenth',
  'Nineteenth', 'Twentieth', 'Twenty-First', 'Twenty-Second',
  'Twenty-Third', 'Twenty-Fourth', 'Twenty-Fifth', 'Twenty-Sixth',
  'Twenty-Seventh', 'Twenty-Eighth', 'Twenty-Ninth',
]

// RCL cycle letter for the liturgical year that CONTAINS this date.
// Anchor: the liturgical year beginning Advent 2025 is Year A.
export function cycleFor(date) {
  const y = date.getUTCFullYear()
  const advent = adventStart(y)
  const startYear = date.getTime() >= advent.getTime() ? y : y - 1
  return 'ABC'[(((startYear - 2025) % 3) + 3) % 3]
}

// Proper number for a Sunday after Trinity: date-anchored windows,
// Proper 4 = the Sunday falling May 29 – June 4, each next proper +7d.
function properFor(sunday) {
  const base = new Date(Date.UTC(sunday.getUTCFullYear(), 4, 29)) // May 29
  const diff = Math.floor((sunday.getTime() - base.getTime()) / DAY)
  if (diff < 0) return null
  const p = 4 + Math.floor(diff / 7)
  return p >= 1 && p <= 29 ? p : null
}

// The designation for a SUNDAY (or major holy day). Returns
// { designation, proper } — proper is null outside the season after
// Pentecost.
function sundayDesignation(d) {
  const y = d.getUTCFullYear()
  const easter = computeEaster(y)
  const pentecost = addDays(easter, 49)
  const advent = adventStart(y)
  const isSunday = d.getUTCDay() === 0

  // Fixed holy days first — these resolve as themselves on any weekday.
  if (d.getUTCMonth() === 11 && d.getUTCDate() === 25) return { designation: 'Christmas Day', proper: null }
  if (d.getUTCMonth() === 0 && d.getUTCDate() === 1) return { designation: 'The Holy Name (New Year’s Day)', proper: null }
  if (d.getUTCMonth() === 0 && d.getUTCDate() === 6) return { designation: 'The Epiphany', proper: null }

  // Advent Sundays (of this calendar year)
  if (isSunday && d.getTime() >= advent.getTime() && (d.getUTCMonth() === 10 || (d.getUTCMonth() === 11 && d.getUTCDate() <= 24))) {
    const week = Math.floor((d.getTime() - advent.getTime()) / (7 * DAY)) + 1
    if (week >= 1 && week <= 4) return { designation: `${ORDINALS[week]} Sunday of Advent`, proper: null }
  }
  // Christmastide Sundays
  if (isSunday && d.getUTCMonth() === 11 && d.getUTCDate() >= 26) return { designation: 'First Sunday after Christmas', proper: null }
  if (isSunday && d.getUTCMonth() === 0 && d.getUTCDate() <= 5) return { designation: 'Second Sunday after Christmas', proper: null }

  // Epiphanytide: First Sunday after the Epiphany = Baptism of the Lord;
  // the Sunday immediately before Ash Wednesday = Last Sunday after the
  // Epiphany (Transfiguration, in RCL usage).
  const ashWed = addDays(easter, -46)
  if (isSunday) {
    const jan6 = new Date(Date.UTC(y, 0, 6))
    if (d.getTime() > jan6.getTime() && d.getTime() < ashWed.getTime()) {
      const lastEpiphanySunday = addDays(ashWed, -3) // Sunday before Ash Wednesday
      if (sameDay(d, lastEpiphanySunday)) {
        return { designation: 'Last Sunday after the Epiphany (Transfiguration)', proper: null }
      }
      const week = Math.floor((d.getTime() - jan6.getTime() - DAY) / (7 * DAY)) + 1
      if (week === 1) return { designation: 'First Sunday after the Epiphany (Baptism of the Lord)', proper: null }
      if (week >= 2 && week <= 9) return { designation: `${ORDINALS[week]} Sunday after the Epiphany`, proper: null }
    }
  }

  // Lent → Easter
  if (sameDay(d, ashWed)) return { designation: 'Ash Wednesday', proper: null }
  for (let n = 1; n <= 5; n++) {
    if (sameDay(d, addDays(easter, -49 + 7 * n))) return { designation: `${ORDINALS[n]} Sunday in Lent`, proper: null }
  }
  if (sameDay(d, addDays(easter, -7))) return { designation: 'Palm Sunday (Sunday of the Passion)', proper: null }
  if (sameDay(d, addDays(easter, -3))) return { designation: 'Maundy Thursday', proper: null }
  if (sameDay(d, addDays(easter, -2))) return { designation: 'Good Friday', proper: null }
  if (sameDay(d, addDays(easter, -1))) return { designation: 'Holy Saturday', proper: null }
  if (sameDay(d, easter)) return { designation: 'Easter Day', proper: null }
  for (let n = 2; n <= 7; n++) {
    if (sameDay(d, addDays(easter, 7 * (n - 1)))) return { designation: `${ORDINALS[n]} Sunday of Easter`, proper: null }
  }
  if (sameDay(d, addDays(easter, 39))) return { designation: 'Ascension Day', proper: null }
  if (sameDay(d, pentecost)) return { designation: 'Day of Pentecost', proper: null }
  if (sameDay(d, addDays(pentecost, 7))) return { designation: 'Trinity Sunday', proper: null }

  // Season after Pentecost — "Nth Sunday after Pentecost · Proper N".
  // Sundays only: weekdays resolve through the "Week of …" fallback.
  if (isSunday && d.getTime() > pentecost.getTime() && d.getTime() < advent.getTime()) {
    const weeks = Math.round((d.getTime() - pentecost.getTime()) / (7 * DAY))
    const proper = properFor(d)
    const name = proper === 29
      ? 'Christ the King (Reign of Christ)'
      : `${ORDINALS[weeks] ?? `${weeks}th`} Sunday after Pentecost`
    return { designation: name, proper }
  }

  return { designation: null, proper: null }
}

// Public API. For a non-Sunday date, resolves the PRECEDING Sunday's
// designation and marks it "Week of …" — the Ordo convention for
// weekday Masses in ordinary weeks. Major holy days that fall on
// weekdays (Ash Wednesday, Holy Week, Ascension, Christmas, Epiphany)
// resolve as themselves first.
export function resolveLectionary(dateStr) {
  const d = utc(dateStr)
  if (Number.isNaN(d.getTime())) return null
  const cycle = cycleFor(d)
  const own = sundayDesignation(d)
  if (own.designation) {
    return { cycle, year_label: `Year ${cycle}`, designation: own.designation, proper: own.proper, is_sunday: d.getUTCDay() === 0 }
  }
  const prevSunday = addDays(d, -d.getUTCDay())
  const wk = sundayDesignation(prevSunday)
  // "Week of the Third Sunday of Advent" reads right; "Week of the
  // Easter Day" does not — a few weeks have proper names of their own.
  let weekName = wk.designation ? `Week of the ${wk.designation}` : null
  if (wk.designation === 'Easter Day') weekName = 'Easter Week'
  else if (wk.designation === 'Palm Sunday (Sunday of the Passion)') weekName = 'Holy Week'
  else if (wk.designation === 'Christmas Day') weekName = 'Christmas Week'
  return {
    cycle,
    year_label: `Year ${cycle}`,
    designation: weekName,
    proper: wk.proper,
    is_sunday: false,
  }
}
