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
