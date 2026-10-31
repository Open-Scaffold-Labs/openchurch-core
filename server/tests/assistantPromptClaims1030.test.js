// Maintenance 2026-10-30: the Assistant prompt must know the Parish page
// publish screen from OC-WEB-1 PR-D (#465): admin-only, under Org details,
// Publish / Take the page down / Restore the previous page, each confirmed,
// and visible only while the public address switch (page_published) is on.
// Without it the prompt's "never invent features" rule makes it deny the screen.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/routes/assistant.js', import.meta.url), 'utf8')
const prompt = src.slice(src.indexOf('const SYSTEM_PROMPT'), src.indexOf('async function todayCount'))

describe('assistant system prompt parish page publishing (2026-10-30)', () => {
  it('reads the prompt', () => { expect(prompt.length).toBeGreaterThan(500) })
  it('names the publish screen and its actions', () => {
    expect(prompt).toMatch(/Org details → Publish the parish page/)
    expect(prompt).toMatch(/Publish,\s+Take the page down or Restore the previous page, each confirmed/)
  })
  it('says visitors see it only while the public address switch is on', () => {
    expect(prompt).toMatch(/visitors see it only while\s+the public address switch is on/)
  })
})
