// Maintenance 2026-10-23: the Assistant's system prompt must not tell
// parishes that AI Studio has a monthly quota by plan. AI runs only on the
// parish's own key, and own-key usage has no OpenChurch monthly limit
// (billing/aiQuota.js: ownKey -> limit null; José 2026-10-23).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/routes/assistant.js', import.meta.url), 'utf8')
const prompt = src.slice(src.indexOf('const SYSTEM_PROMPT'), src.indexOf('async function todayCount'))

describe('assistant system prompt AI-limit claim', () => {
  it('does not promise a monthly quota by plan', () => {
    expect(prompt.length).toBeGreaterThan(500)
    expect(prompt).not.toMatch(/monthly quota by plan/)
  })
  it('says own-key AI has no OpenChurch monthly limit', () => {
    expect(prompt).toMatch(/OpenChurch sets no monthly AI limit/)
  })
})
