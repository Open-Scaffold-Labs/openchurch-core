// Maintenance 2026-10-29: the Assistant prompt must describe the church-page
// branding fields from OC-WEB-1 PR-B (#452: display name, https logo, accent
// color; church page only) and the Assistant's own daily question limit,
// which starts over at midnight in the parish timezone (todayCount).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/routes/assistant.js', import.meta.url), 'utf8')
const prompt = src.slice(src.indexOf('const SYSTEM_PROMPT'), src.indexOf('async function todayCount'))

describe('assistant system prompt branding and daily limit (2026-10-29)', () => {
  it('reads the prompt', () => { expect(prompt.length).toBeGreaterThan(500) })
  it('names the church page branding fields and their reach', () => {
    expect(prompt).toMatch(/display name, https logo link and accent color/)
    expect(prompt).toMatch(/church page only, not public forms, giving or bulletin pages/)
  })
  it('states the daily Assistant limit and when it starts over', () => {
    expect(prompt).toMatch(/set number of questions per parish each day/)
    expect(prompt).toMatch(/midnight in the parish's timezone/)
  })
  it('the limit refusal names the parish timezone', () => {
    expect(src).toMatch(/resets at midnight in your parish\\u2019s timezone/)
  })
})
