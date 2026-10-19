// ARG-226-15 — an invalid instant must not throw out of the civil-date
// helper. Intl.DateTimeFormat.formatToParts throws RangeError on a
// NaN instant. The guard in civilDateInTimeZone returns null instead.
// A Sunday/timezone reading of a real instant stays in this file so a
// guard that swallowed every input would fail too.

import { describe, it, expect } from 'vitest'
import { civilDateInTimeZone } from '../src/utils/timezone.js'

describe('civilDateInTimeZone invalid instant', () => {
  it('returns null instead of throwing when the instant is not a time', () => {
    expect(civilDateInTimeZone(new Date(NaN), 'America/Los_Angeles')).toBeNull()
    expect(civilDateInTimeZone(new Date('not-a-date'), 'UTC')).toBeNull()
    expect(civilDateInTimeZone('not-a-date', 'Pacific/Auckland')).toBeNull()
    expect(civilDateInTimeZone(Number.NaN, 'UTC')).toBeNull()
  })

  it('still reads a real instant as the parish wall date', () => {
    // 2026-09-27 04:30 UTC is Saturday evening in Los Angeles and
    // Sunday morning in Auckland. The day must follow the parish.
    const instant = new Date('2026-09-27T04:30:00.000Z')
    expect(civilDateInTimeZone(instant, 'America/Los_Angeles')).toBe('2026-09-26')
    expect(civilDateInTimeZone(instant, 'Pacific/Auckland')).toBe('2026-09-27')
    expect(civilDateInTimeZone(instant, 'UTC')).toBe('2026-09-27')
  })
})
