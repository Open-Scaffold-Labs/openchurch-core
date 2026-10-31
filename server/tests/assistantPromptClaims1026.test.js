// Maintenance 2026-10-26: since #416 the public Give page takes a card gift
// only into the parish's own saved Stripe Connect account (409 otherwise),
// and no screen lets a parish save one. The Assistant must not promise
// online giving as a working feature.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/routes/assistant.js', import.meta.url), 'utf8')
const prompt = src.slice(src.indexOf('const SYSTEM_PROMPT'), src.indexOf('async function todayCount'))

describe('assistant system prompt online giving (2026-10-26)', () => {
  it('reads the prompt', () => { expect(prompt.length).toBeGreaterThan(500) })
  it('says online giving needs the parish\'s own Stripe account', () => {
    expect(prompt).not.toMatch(/funds \(designated\/restricted\), online giving, refunds/)
    expect(prompt).toMatch(/Online giving works only once\s+the parish's own Stripe account is connected/)
    expect(prompt).toMatch(/no screen in OpenChurch yet/)
  })
  it('says recurring online gifts are not taken yet', () => {
    expect(prompt).toMatch(/Recurring online gifts are not taken yet/)
  })
})
