// Maintenance 2026-10-24 — Help must describe what the app actually does.
// Each case failed on the copy at origin/main 15d6cf8a.
import { describe, it, expect } from 'vitest'
import { MODULE_HELP, FAQ } from './helpContent.js'

const faq = q => FAQ.find(f => f.q.startsWith(q))?.a ?? ''
const allText = () => JSON.stringify({ MODULE_HELP, FAQ })

describe('help claims (2026-10-24)', () => {
  it('swaps: no "qualified member" promise — routes/swap.js checks no role or training', () => {
    expect(allText()).not.toMatch(/qualified member/)
    expect(faq('A lector can')).toMatch(/specific member/)
    expect(faq('A lector can')).toMatch(/doesn\u2019t check/)
  })

  it('swap reminders: only queued, eligible reminders move; no delivery guarantee (R384-1)', () => {
    const a = faq('A lector can')
    expect(a).not.toMatch(/serving reminder goes to the new person/)
    expect(a).toMatch(/any queued serving reminder/)
    expect(a).toMatch(/email on file/)
    expect(a).toMatch(/never undoes the swap/)
  })

  it('Report a Problem: triage is conditional (no AI key leaves a ticket untriaged)', () => {
    const a = faq('Where do I report a bug')
    expect(a).not.toMatch(/diagnostic runs automatically/)
    expect(a).toMatch(/only when/)
  })

  it('Audit log: does not claim every change is logged, and names what is not', () => {
    const audit = MODULE_HELP.audit ?? Object.values(MODULE_HELP).find(m => m.name === 'Audit log')
    const text = JSON.stringify(audit)
    expect(text).not.toMatch(/Every change|Every successful mutation/)
    expect(text).toMatch(/swaps accepted from a swap link/)
    expect(text).toMatch(/recurring service templates/)
  })
})
