import { describe, it, expect } from 'vitest'
import { plansForDateAscending, readingLinesFromElements } from './bulletinReadingsPull'

describe('SP-308 plansForDateAscending', () => {
  it('orders same-date plans by id ascending (API is id DESC)', () => {
    const plans = [
      { id: 56, date: '2026-11-01' },
      { id: 55, date: '2026-11-01' },
      { id: 40, date: '2026-10-25' },
    ]
    expect(plansForDateAscending(plans, '2026-11-01').map(p => p.id)).toEqual([55, 56])
  })

  it('returns empty when no plan matches the date', () => {
    expect(plansForDateAscending([{ id: 1, date: '2026-11-02' }], '2026-11-01')).toEqual([])
  })
})

describe('readingLinesFromElements', () => {
  it('keeps reading and psalm; drops hymns', () => {
    expect(readingLinesFromElements([
      { kind: 'hymn', title: 'Entrance', reference: '#1' },
      { kind: 'reading', title: 'First Reading', reference: 'Rev 7:2-4' },
      { kind: 'psalm', title: 'Responsorial Psalm', reference: 'Ps 24' },
    ])).toEqual([
      'First Reading — Rev 7:2-4',
      'Responsorial Psalm — Ps 24',
    ])
  })
})
