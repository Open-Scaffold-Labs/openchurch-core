import { describe, it, expect } from 'vitest'
import { upcomingSundayISO } from './dates'

describe('upcomingSundayISO (SP-189)', () => {
  it('returns today when today is Sunday in the parish zone', () => {
    // 2026-11-01 18:00 UTC = Sunday afternoon in America/Los_Angeles
    const now = new Date('2026-11-01T18:00:00.000Z')
    expect(upcomingSundayISO('America/Los_Angeles', now)).toBe('2026-11-01')
  })

  it('returns the next Sunday on a Tuesday in the parish zone', () => {
    // 2026-10-27 20:00 UTC = Tuesday afternoon PT
    const now = new Date('2026-10-27T20:00:00.000Z')
    expect(upcomingSundayISO('America/Los_Angeles', now)).toBe('2026-11-01')
  })

  it('uses the parish zone, not UTC, near a day boundary', () => {
    // 2026-11-01 06:00 UTC is still Saturday evening in America/Los_Angeles
    const now = new Date('2026-11-01T06:00:00.000Z')
    expect(upcomingSundayISO('America/Los_Angeles', now)).toBe('2026-11-01')
    // Same instant is Sunday morning in UTC
    expect(upcomingSundayISO('UTC', now)).toBe('2026-11-01')
  })

  it('falls back to UTC when the zone is missing', () => {
    const now = new Date('2026-10-28T12:00:00.000Z') // Wednesday UTC
    expect(upcomingSundayISO(undefined, now)).toBe('2026-11-01')
  })
})
