// Maintenance 2026-10-26: Donations Help must not say online gifts simply
// arrive. Since #416 the Give page takes card gifts only into the parish's
// own saved Stripe Connect account, and no screen saves one yet.
import { describe, it, expect } from 'vitest'
import { MODULE_HELP as HELP } from './helpContent.js'

const d = HELP.donations
const all = [d.overview, ...d.features, ...d.tips].join('\n')

describe('Donations help: online giving (2026-10-26)', () => {
  it('does not promise online gifts unconditionally', () => {
    expect(all).not.toMatch(/online gifts arrive automatically/)
    expect(d.overview).toMatch(/online giving once your parish\u2019s own Stripe account is connected/)
  })
  it('says the Give page takes no card gift until the account is connected', () => {
    expect(all).toMatch(/takes no card gift/)
    expect(all).toMatch(/no screen in OpenChurch yet/)
  })
  it('does not list recurring online gifts as available (live Give refuses a frequency)', () => {
    expect(d.features).not.toContain('Recurring online gifts')
    expect(all).toMatch(/Recurring online gifts are not taken yet/)
  })
})
