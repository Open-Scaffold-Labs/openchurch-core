// SP-315: Nov 2 is All Souls (Purple) on the liturgical API, including when
// it falls on Sunday (2025-11-02). Transfers of impeded solemnities are not
// modelled (same as SP-098 lectionary note).
import { describe, it, expect } from 'vitest'
import { getLiturgicalInfo } from '../src/routes/liturgical.js'
import { resolveRomanLectionary } from '../src/services/lectionary.js'

describe('SP-315 All Souls liturgical day', () => {
  it('2026-11-02 (Monday) is All Souls · Purple', () => {
    const d = getLiturgicalInfo('2026-11-02')
    expect(d.feast_name).toBe('All Souls')
    expect(d.color).toBe('Purple')
    expect(d.season).toBe('Ordinary Time')
  })

  it('2026-11-01 (Sunday) remains All Saints · White', () => {
    const d = getLiturgicalInfo('2026-11-01')
    expect(d.feast_name).toBe('All Saints')
    expect(d.color).toBe('White')
  })

  it('when Nov 2 is Sunday (2025), All Souls still names the day', () => {
    const d = getLiturgicalInfo('2025-11-02')
    expect(d.feast_name).toBe('All Souls')
    expect(d.color).toBe('Purple')
    expect(resolveRomanLectionary('2025-11-02').designation)
      .toBe('The Commemoration of All the Faithful Departed (All Souls)')
  })
})
