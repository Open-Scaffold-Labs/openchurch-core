// Maintenance 2026-10-25: the Assistant's product facts must match the app.
// No room booking exists (rooms are check-in spaces; the conflict check is
// member overlap only), certificate numbers are free text, Recurring on a
// task is a label, the diocese layer does not read pledges, and Viewers get
// members without notes or birth year (SP-176, routes/clients.js).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/routes/assistant.js', import.meta.url), 'utf8')
const prompt = src.slice(src.indexOf('const SYSTEM_PROMPT'), src.indexOf('async function todayCount'))

describe('assistant system prompt product facts (2026-10-25)', () => {
  it('reads the prompt', () => { expect(prompt.length).toBeGreaterThan(500) })
  it('does not offer room booking with conflict detection', () => {
    expect(prompt).not.toMatch(/room booking with conflict detection/)
    expect(prompt).toMatch(/There is no room booking/)
  })
  it('does not imply numbered or de-duplicated certificates', () => {
    expect(prompt).toMatch(/does not propose the next number or\s+check for duplicates/)
  })
  it('says Recurring on a task is only a label', () => {
    expect(prompt).toMatch(/Recurring is only a label/)
  })
  it('says the diocese layer does not read pledges', () => {
    expect(prompt).toMatch(/Pledges \(parish only; the diocese layer does not read them\)/)
  })
  it('says viewers do not see notes, birth year or giving', () => {
    expect(prompt).toMatch(/Viewers don't see a member's private notes, birth year or giving/)
  })
})
