// CHK-04 — historical attendance copy uses stamps, never the live Mass.
//
// A recent row or a member history row with NULL title/date must say the
// service as attended is unknown. Falling back to the picker / live
// Schedule title is the defect.

import { describe, it, expect } from 'vitest'
import {
  attendedServiceLabel,
  attendedServiceDateLabel,
  recentServiceKey,
} from './Checkin'
import { attendedHistoryLabel, attendedHistoryDateLabel } from './MemberDetail'

const t = key => ({
  'checkin.attendedUnknown': 'Service as attended is unknown',
  'checkin.attendedDateUnknown': 'Date unknown',
}[key] || key)

describe('CHK-04 attended labels', () => {
  it('uses the stamp when present', () => {
    expect(attendedServiceLabel({ title: '8am Mass', date: '2033-04-03' }, t)).toBe('8am Mass')
    expect(attendedServiceDateLabel({ date: '2033-04-03' }, t)).toMatch(/Apr/)
    expect(attendedHistoryLabel({ event_title: '8am Mass', event_date: '2033-04-03' }, t)).toBe('8am Mass')
    expect(attendedHistoryDateLabel({ event_date: '2033-04-03' }, t)).toMatch(/Apr/)
  })

  it('NULL stamps are unknown — not the live Mass title', () => {
    const live = 'Solemn Mass'
    expect(attendedServiceLabel({ title: null, date: null }, t)).toBe('Service as attended is unknown')
    expect(attendedServiceLabel({ title: '', date: null }, t)).toBe('Service as attended is unknown')
    expect(attendedServiceLabel({}, t)).toBe('Service as attended is unknown')
    expect(attendedServiceDateLabel({ date: null }, t)).toBe('Date unknown')
    expect(attendedHistoryLabel({ event_title: null, event_date: null }, t)).toBe('Service as attended is unknown')
    expect(attendedHistoryDateLabel({ event_date: null }, t)).toBe('Date unknown')
    expect(attendedServiceLabel({ title: null }, t)).not.toBe(live)
    expect(attendedHistoryLabel({ event_title: null }, t)).not.toBe(live)
  })

  it('two same-title services stay distinct keys by event_id', () => {
    const a = { event_id: 17, title: 'Sunday Mass', date: '2033-09-04', time: '08:00' }
    const b = { event_id: 18, title: 'Sunday Mass', date: '2033-09-04', time: '08:00' }
    expect(recentServiceKey(a)).not.toBe(recentServiceKey(b))
  })
})
