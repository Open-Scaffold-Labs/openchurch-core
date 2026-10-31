// SP-007 — FAQ must match ROLE_TABLE: Finance is admin-only, not staff.
import { describe, it, expect } from 'vitest'
import { FAQ, ROLE_TABLE } from './helpContent.js'

const faq = q => FAQ.find(f => f.q.startsWith(q))?.a ?? ''

describe('SP-007 Help finance ACL copy', () => {
  it('ROLE_TABLE keeps Finance admin-only / staff false', () => {
    const row = ROLE_TABLE.find(r => r.area.includes('Finance'))
    expect(row).toBeTruthy()
    expect(row.admin).toBe(true)
    expect(row.staff).toBe(false)
  })

  it('viewer FAQ no longer says finance stays with staff', () => {
    const a = faq('Can volunteers see the schedule')
    expect(a).toMatch(/Finance is admin-only/)
    expect(a).not.toMatch(/finance, attendance[\s\S]*stay with staff/)
    expect(a).toMatch(/Giving, payroll, attendance/)
  })
})
