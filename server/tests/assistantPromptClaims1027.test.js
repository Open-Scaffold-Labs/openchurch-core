// Maintenance 2026-10-27: the Assistant's Finance line must match #432
// (balanced trial-balance import, unmapped gifts block submission,
// effective-dated mappings, no diocesan mapping screen yet).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/routes/assistant.js', import.meta.url), 'utf8')
const prompt = src.slice(src.indexOf('const SYSTEM_PROMPT'), src.indexOf('async function todayCount'))

describe('assistant system prompt finance (2026-10-27)', () => {
  it('reads the prompt', () => { expect(prompt.length).toBeGreaterThan(500) })
  it('describes the trial-balance import', () => {
    expect(prompt).toMatch(/trial-balance CSV for one period-end date/)
    expect(prompt).toMatch(/must\s+balance and is saved all or nothing/)
  })
  it('says unmapped gifts block submission', () => {
    expect(prompt).toMatch(/cannot be sent to the diocese until they are mapped/)
  })
  it('states mapping change rules and the missing diocese screen', () => {
    expect(prompt).toMatch(/starts today or later and earlier gifts keep their account/)
    expect(prompt).toMatch(/period already sent\s+is refused/)
    expect(prompt).toMatch(/no screen yet for the diocese to set it/)
  })
})
