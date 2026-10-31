// SP-314 (José 2026-10-30): All Souls envelope with several names =
// one family-line intention, names in the Note. Help documents it.
import { describe, it, expect } from 'vitest'
import { MODULE_HELP as HELP, FAQ } from './helpContent.js'

const mi = HELP.intentions
const miAll = [mi.overview, ...mi.features, ...mi.sections.map(s => s.content || ''), ...mi.tips].join('\n')
const faqAll = FAQ.map(f => `${f.q}\n${f.a}`).join('\n')

describe('SP-314 All Souls / several names help', () => {
  it('documents the one-family-line + Note convention', () => {
    expect(miAll).toMatch(/All Souls/)
    expect(miAll).toMatch(/one intention/)
    expect(miAll).toMatch(/Note/)
    expect(miAll).toMatch(/Book of the Dead/)
  })

  it('FAQ is findable for All Souls envelopes', () => {
    expect(faqAll).toMatch(/All Souls envelope with several names/)
    expect(faqAll).toMatch(/individual departed names in the Note/)
  })
})
