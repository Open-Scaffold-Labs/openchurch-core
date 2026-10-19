// Vigil-week arithmetic. Mutate vigilWeekStart back to "Sunday of the
// week that contains today" and Friday no longer opens on the vigil.
// Mutate orgTodayIso to ignore the parish zone and Sunday evening in
// America/Los_Angeles becomes Monday's next sheet.

import { describe, it, expect } from 'vitest'
import {
  addIsoDays,
  canonicalIsoDate,
  finiteSpanDays,
  orgTodayIso,
  readWeeklyDate,
  resolveWeeklyWindow,
  sheetWeekStart,
  usableTimeZone,
  vigilWeekStart,
} from '../../../server/src/utils/sheetWeek.js'

const LA = 'America/Los_Angeles'

describe('vigilWeekStart', () => {
  it('Friday opens the coming Sunday on its vigil Saturday', () => {
    expect(vigilWeekStart('2026-10-02')).toBe('2026-10-03')
    expect(resolveWeeklyWindow(null, null, '2026-10-02')).toEqual({
      start: '2026-10-03', end: '2026-10-09',
    })
  })

  it('Saturday evening and Sunday share that weekend', () => {
    expect(vigilWeekStart('2026-10-03')).toBe('2026-10-03')
    expect(vigilWeekStart('2026-10-04')).toBe('2026-10-03')
  })

  it('Monday looks forward to the next Sunday', () => {
    expect(vigilWeekStart('2026-10-05')).toBe('2026-10-10')
    expect(resolveWeeklyWindow(null, null, '2026-10-05')).toEqual({
      start: '2026-10-10', end: '2026-10-16',
    })
  })
})

describe('orgTodayIso', () => {
  it('keeps Sunday evening in the parish when UTC is already Monday', () => {
    const instant = '2026-10-05T04:00:00.000Z'
    expect(orgTodayIso(instant, LA)).toBe('2026-10-04')
    expect(vigilWeekStart(orgTodayIso(instant, LA))).toBe('2026-10-03')
    expect(orgTodayIso(instant, 'UTC')).toBe('2026-10-05')
    expect(vigilWeekStart(orgTodayIso(instant, 'UTC'))).toBe('2026-10-10')
  })

  it('reads Saturday evening as Saturday in the parish', () => {
    const instant = '2026-10-04T04:00:00.000Z'
    expect(orgTodayIso(instant, LA)).toBe('2026-10-03')
    expect(vigilWeekStart(orgTodayIso(instant, LA))).toBe('2026-10-03')
  })

  it('falls back to UTC when the zone is missing or unknown', () => {
    const instant = '2026-10-05T04:00:00.000Z'
    expect(orgTodayIso(instant, '')).toBe('2026-10-05')
    expect(orgTodayIso(instant, 'Not/AZone')).toBe('2026-10-05')
    expect(orgTodayIso('not-a-date', LA)).toBeNull()
  })
})

describe('sheetWeekStart', () => {
  it('opens the Saturday–Friday sheet that contains the date', () => {
    expect(sheetWeekStart('2026-09-13')).toBe('2026-09-12')
    expect(sheetWeekStart('2026-09-16')).toBe('2026-09-12')
    expect(sheetWeekStart('2026-10-04')).toBe('2026-10-03')
    expect(sheetWeekStart('2026-10-03')).toBe('2026-10-03')
  })
})

describe('canonicalIsoDate', () => {
  it('rejects impossible days and keeps a 4-digit year', () => {
    expect(canonicalIsoDate('2026-02-31')).toBeNull()
    expect(canonicalIsoDate('2026-13-01')).toBeNull()
    expect(readWeeklyDate('2026-02-31').invalid).toBe(true)
    expect(readWeeklyDate('2026-13-01').invalid).toBe(true)
    expect(canonicalIsoDate('0999-01-01')).toBe('0999-01-01')
    expect(addIsoDays('0999-01-01', 6)).toBe('0999-01-07')
    expect(addIsoDays('2026-02-31', 6)).toBeNull()
    expect(finiteSpanDays('2026-13-01', '2026-10-03')).toBeNull()
    expect(finiteSpanDays('0999-01-01', '0999-01-07')).toBe(6)
  })

  it('echoes an unusable stored zone as UTC', () => {
    expect(usableTimeZone('Not/AZone')).toBe('UTC')
    expect(usableTimeZone('America/Los_Angeles')).toBe('America/Los_Angeles')
    expect(usableTimeZone(null)).toBe('UTC')
  })
})

describe('resolveWeeklyWindow', () => {
  it('keeps an explicit start and fills a missing end as six days later', () => {
    expect(resolveWeeklyWindow('2026-09-16', null, '2026-10-02')).toEqual({
      start: '2026-09-16', end: '2026-09-22',
    })
    expect(resolveWeeklyWindow(null, '2026-09-22', '2026-10-02')).toEqual({
      start: '2026-09-16', end: '2026-09-22',
    })
    expect(resolveWeeklyWindow('2026-09-16', '2026-09-18', '2026-10-02')).toEqual({
      start: '2026-09-16', end: '2026-09-18',
    })
  })
})
