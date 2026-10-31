// Maintenance 2026-10-28: the Assistant's Intentions and Finance lines must
// match #442 (SP-250 stipend liability, void disposition, delete refusal) and
// the deposit-adjustment submission hold.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/routes/assistant.js', import.meta.url), 'utf8')
const prompt = src.slice(src.indexOf('const SYSTEM_PROMPT'), src.indexOf('async function todayCount'))

describe('assistant system prompt intentions and finance (2026-10-28)', () => {
  it('reads the prompt', () => { expect(prompt.length).toBeGreaterThan(500) })
  it('describes the 2330 stipend liability', () => {
    expect(prompt).toMatch(/account 2330, Mass Stipends Payable\),\s+not income/)
  })
  it('states delete and void rules; Release stipend is not available yet', () => {
    expect(prompt).toMatch(/cannot be deleted/)
    expect(prompt).toMatch(/refund, transfer, or pastor-directed apply/)
    expect(prompt).toMatch(/Administrators\s+use Void on the Intentions screen/)
    expect(prompt).toMatch(/Release stipend is not available yet/)
    expect(prompt).toMatch(/voiding a fulfilled intention that\s+still holds the stipend is refused/)
    expect(prompt).not.toMatch(/they can Release the held stipend/)
  })
  it('states the two submission holds', () => {
    expect(prompt).toMatch(/offering is still held with no disposition/)
    expect(prompt).toMatch(/deposit adjustments\s+that are not in the diocesan roll-up yet/)
  })
})
