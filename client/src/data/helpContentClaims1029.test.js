// Maintenance 2026-10-29: Org details Help must describe the church-page
// branding fields from OC-WEB-1 PR-B (#452; OrgSettings.jsx display name,
// logo URL, accent color; only PublicChurch.jsx reads branding), and Help
// must say the Assistant has a daily question limit that starts over at
// midnight in the parish timezone (server/src/routes/assistant.js todayCount).
import { describe, it, expect } from 'vitest'
import { MODULE_HELP as HELP, FAQ } from './helpContent.js'

const s = HELP.settings
const sAll = [s.overview, ...s.features, ...s.tips].join('\n')
const faqAll = FAQ.map(f => `${f.q}\n${f.a}`).join('\n')

describe('Org details and Assistant help (2026-10-29)', () => {
  it('names the church page display name, https logo and accent color', () => {
    expect(sAll).toMatch(/public display name, a logo \(an https image link\) and an accent color \(#RRGGBB\)/)
  })
  it('says branding applies to the church page only', () => {
    expect(sAll).toMatch(/church page only; public forms, giving and bulletin pages keep the standard look/)
  })
  it('says the Assistant has a daily question limit', () => {
    expect(faqAll).toMatch(/Is there a limit on Assistant questions\?/)
    expect(faqAll).toMatch(/set number of Assistant questions per parish each day/)
  })
  it('says the limit starts over at midnight in the parish timezone', () => {
    expect(faqAll).toMatch(/midnight in your parish\u2019s timezone/)
  })
})
