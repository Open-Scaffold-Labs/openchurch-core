// SP-125/127/128 (Saint 390px recheck at 91a30ba, 2026-10-23). jsdom cannot
// lay out or print, so these pin the class/copy contracts behind each fix.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { STRINGS } from '../i18n/strings'
const { en, es } = STRINGS
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = rel => readFileSync(join(SRC, rel), 'utf8')

describe('SP-127 print', () => {
  for (const f of ['pages/Clients.jsx', 'pages/Events.jsx']) {
    it(`${f}: swipe hint is hidden in print`, () => {
      const line = read(f).split('\n').find(l => l.includes('data-testid="table-scroll-hint"'))
      expect(line).toMatch(/\bprint:hidden\b/)
    })
  }
  it('Events table is not clipped by its scroller or min width in print', () => {
    const s = read('pages/Events.jsx')
    expect(s).toMatch(/overflow-hidden print:overflow-visible shadow-card">\s*<p data-testid="table-scroll-hint"/)
    expect(s).toMatch(/className="overflow-x-auto print:overflow-visible"[^>]*aria-label=\{t\('ev.tableRegion'\)\}/)
    expect(s).toMatch(/min-w-\[52rem\] print:min-w-0/)
  })
})

describe('SP-128 Events header is localized', () => {
  const keys = ['ev.title', 'ev.sub', 'ev.importCsv', 'ev.add']
  it('has EN and distinct ES copy', () => {
    for (const k of keys) {
      expect(en[k], k).toBeTruthy()
      expect(es[k], k).toBeTruthy()
      expect(es[k], k).not.toBe(en[k])
    }
    expect(en['ev.sub']).toContain('{n}')
    expect(es['ev.sub']).toContain('{n}')
  })
  it('Events.jsx uses t() rather than hardcoded English', () => {
    const s = read('pages/Events.jsx')
    for (const k of keys) expect(s).toContain(`t('${k}')`)
    expect(s).not.toMatch(/>Events<\/h1>/)
    expect(s).not.toMatch(/<\/Upload>|\/> Import CSV/)
    expect(s).not.toMatch(/<Plus size=\{16\} \/> Add Event/)
  })
})

describe('SP-125 AI Studio type tile title', () => {
  it('does not use break-words (mid-word breaks) and fits tighter at 390px', () => {
    const line = read('pages/AI.jsx').split('\n').find(l => l.includes('data-testid="ai-type-title"'))
    expect(line).toBeTruthy()
    expect(line).not.toMatch(/\bbreak-words\b|break-all|overflow-wrap:anywhere/)
    expect(line).toMatch(/hyphens-auto/)
    expect(read('pages/AI.jsx')).toMatch(/gap-2 sm:gap-3 px-3 sm:px-4 py-3 rounded-xl/)
  })
})
