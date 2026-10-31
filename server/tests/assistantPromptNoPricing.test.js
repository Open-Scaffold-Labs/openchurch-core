// C2 (#424, Vesper wave 2 P2): the free iOS app must not have the assistant
// repeat "pricing will be announced". The prompt may not promise pricing.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/routes/assistant.js', import.meta.url), 'utf8')
const prompt = src.slice(src.indexOf('const SYSTEM_PROMPT'), src.indexOf('async function todayCount'))

describe('assistant system prompt pricing (C2)', () => {
  it('reads the prompt', () => { expect(prompt.length).toBeGreaterThan(500) })
  it('does not announce future pricing and still forbids quoting a price', () => {
    expect(prompt).not.toMatch(/pricing will be announced/i)
    expect(prompt).not.toMatch(/free during the open beta/i)
    expect(prompt).toMatch(/never quote a price, tier, or pricing plans/)
  })
})
