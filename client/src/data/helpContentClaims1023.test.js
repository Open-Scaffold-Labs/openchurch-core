// Maintenance 2026-10-23: Help tips and FAQ must match what the app does.
// ⌘K search covers members, events, tasks, staff and donations (server
// routes/search.js), not register entries; the Billing page has no
// diocesan-sponsorship view; and a few screens (parts of Donations and
// Check-in) still render English for Spanish users.
import { describe, it, expect } from 'vitest'
import { MODULE_HELP, TIPS, FAQ } from './helpContent'

describe('help content claims match the app (2026-10-23)', () => {
  it('⌘K tip does not promise register-entry search', () => {
    const tip = TIPS.find(t => t.includes('\u2318K'))
    expect(tip).toBeTruthy()
    expect(tip).not.toMatch(/donations, register entries/)
    expect(tip).toMatch(/Register\u2019s own search/)
  })

  it('Billing help does not claim the page shows diocesan sponsorship', () => {
    const billing = JSON.stringify(MODULE_HELP.billing)
    expect(billing).not.toMatch(/this page will show that sponsorship/)
    expect(billing).toMatch(/doesn\u2019t show that sponsorship yet/)
  })

  it('Spanish FAQ names the screens that are still English-only', () => {
    const faq = FAQ.find(f => /in Spanish\?/.test(f.q))
    expect(faq).toBeTruthy()
    expect(faq.a).not.toMatch(/the interface is bilingual English\/Spanish\./)
    expect(faq.a).toMatch(/still English-only/)
  })
})
