import { describe, it, expect } from 'vitest'
import { feastLabelForDay } from './feastLabel'

describe('SP-315 feastLabelForDay', () => {
  const lit = {
    '2026-11-01': { feast_name: 'All Saints', color: 'White' },
    '2026-11-02': { feast_name: 'All Souls', color: 'Purple' },
    '2026-11-03': { feast_name: null, color: 'Green' },
  }

  it('names All Souls on Monday Nov 2, 2026', () => {
    expect(feastLabelForDay('2026-11-02', lit)).toBe('All Souls')
  })

  it('returns empty when the day has no feast (known empty)', () => {
    expect(feastLabelForDay('2026-11-03', lit)).toBe('')
  })

  it('UNKNOWN is not EMPTY: null map yields no label', () => {
    expect(feastLabelForDay('2026-11-02', null)).toBe('')
    expect(feastLabelForDay('2026-11-02', undefined)).toBe('')
  })
})
