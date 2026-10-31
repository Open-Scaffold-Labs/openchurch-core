// SP-098: bounded Sunday displacement. A fixed-date General Calendar
// solemnity / Feast of the Lord names a numbered Sunday in Ordinary Time;
// it never displaces a movable celebration, and impeded-solemnity
// transfers are NOT modelled (deferred) — those days keep base behaviour.
// Sources: USCCB Daily Readings 2026-11-01 ("Solemnity of All Saints",
// Lectionary 667); Universal Norms on the Liturgical Year, no. 59.
import { describe, it, expect } from 'vitest'
import { resolveRomanLectionary, resolveLectionary } from '../src/services/lectionary.js'
import { lectionaryFor } from '../src/traditions/index.js'

const roman = (d) => resolveRomanLectionary(d).designation

describe('SP-098 Roman: fixed solemnity over an Ordinary Time Sunday', () => {
  it('Nov 1, 2026 (Sunday) is All Saints, Year A', () => {
    const r = resolveRomanLectionary('2026-11-01')
    expect(r.designation).toBe('All Saints')
    expect(r.year_label).toBe('Year A')
  })
  it.each([
    ['2020-11-01', 'All Saints'],
    ['2025-11-02', 'The Commemoration of All the Faithful Departed (All Souls)'],
    ['2025-11-09', 'The Dedication of the Lateran Basilica'],
    ['2025-09-14', 'The Exaltation of the Holy Cross'],
    ['2025-06-29', 'Saints Peter and Paul, Apostles'],
    ['2027-08-15', 'The Assumption of the Blessed Virgin Mary'],
  ])('%s Sunday -> %s', (d, name) => expect(roman(d)).toBe(name))
})

describe('SP-098 never displaces a movable celebration (R363-1)', () => {
  it.each(['1984-06-24', '2068-06-24'])('%s is Corpus Christi, not John the Baptist', (d) => {
    expect(roman(d)).toBe('The Most Holy Body and Blood of Christ')
  })
  it('2022-06-23/24 keep base behaviour (no fixed-date override on weekdays)', () => {
    expect(roman('2022-06-23')).toBe('Week of the The Most Holy Body and Blood of Christ')
    expect(roman('2022-06-24')).toBe('Week of the The Most Holy Body and Blood of Christ')
  })
  it('Christ the King and Advent Sundays are untouched', () => {
    expect(roman('2026-11-22')).toBe('Our Lord Jesus Christ, King of the Universe')
    expect(roman('2024-12-08')).toBe('Second Sunday of Advent')
  })
})

describe('SP-098 no transfer engine (R363-2): 2008 matches base', () => {
  it.each([
    ['2008-03-15', 'Week of the Fifth Sunday of Lent'],
    ['2008-03-19', 'Week of the Palm Sunday of the Passion of the Lord'],
    ['2008-03-25', 'Week of the Easter Sunday of the Resurrection of the Lord'],
    ['2008-03-31', 'Week of the Second Sunday of Easter'],
  ])('%s -> %s', (d, name) => expect(roman(d)).toBe(name))
})

describe('SP-098 weekdays keep the Sunday count', () => {
  it('Nov 3, 2026', () => {
    expect(roman('2026-11-03')).toBe('Week of the Thirty-first Sunday in Ordinary Time')
    expect(resolveLectionary('2026-11-03').designation).toBe('Week of the Twenty-Third Sunday after Pentecost')
  })
})

describe('SP-098 RCL (Episcopal / Lutheran)', () => {
  it("Nov 1, 2026 is All Saints' Day; tradition routing unchanged", () => {
    expect(resolveLectionary('2026-11-01').designation).toBe('All Saints’ Day')
    expect(resolveLectionary('2026-11-01').proper).toBeNull()
    expect(lectionaryFor('catholic', '2026-11-01').designation).toBe('All Saints')
    expect(lectionaryFor('general', '2026-11-01')).toBeNull()
  })
})
