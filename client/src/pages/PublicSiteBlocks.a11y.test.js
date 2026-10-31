// Beacon B-460 — high-contrast CSS + public page a11y contracts (PR #460).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, '../index.css'), 'utf8')
const churchSrc = readFileSync(join(here, 'PublicChurch.jsx'), 'utf8')
const blocksSrc = readFileSync(join(here, 'PublicSiteBlocks.jsx'), 'utf8')

describe('B-460 high-contrast + landmarks', () => {
  it('defines visible high-contrast rules for data-os-look="high-contrast" (B-460-1)', () => {
    expect(css).toMatch(/\[data-os-look=["']high-contrast["']\]/)
    expect(css).toMatch(/background-color:\s*#ffffff/i)
    expect(css).toMatch(/color:\s*#000000/i)
    expect(css).toMatch(/border-color:\s*#000000/i)
    // Must raise contrast vs parchment defaults — black on white.
    expect(css.indexOf('[data-os-look="high-contrast"]')).toBeGreaterThan(-1)
  })

  it('persists visitor high-contrast in localStorage (B-460-2)', () => {
    expect(churchSrc).toMatch(/oc-public-high-contrast/)
    expect(churchSrc).toMatch(/localStorage\.getItem\(['"]oc-public-high-contrast['"]\)/)
    expect(churchSrc).toMatch(/localStorage\.setItem\(['"]oc-public-high-contrast['"]/)
  })

  it('has skip link, main, header, and footer landmarks (B-460-3/4)', () => {
    expect(churchSrc).toMatch(/href=["']#main-content["']/)
    expect(churchSrc).toMatch(/id=["']main-content["']/)
    expect(churchSrc).toMatch(/<main\b/)
    expect(churchSrc).toMatch(/<header\b/)
    expect(churchSrc).toMatch(/<footer\b/)
    expect(churchSrc).toMatch(/shell\.skipToContent/)
  })

  it('bulletin/events/Directions links are at least 24px tall (B-460-5)', () => {
    expect(blocksSrc).toMatch(/min-h-6/)
    const mins = blocksSrc.match(/min-h-6/g) || []
    expect(mins.length).toBeGreaterThanOrEqual(3)
  })

  it('ConnectCard exposes id="connect" for hero CTA (B-460-7)', () => {
    expect(churchSrc).toMatch(/id=["']connect["']/)
  })
})

describe('B-463 Connect labels + coarse 16px', () => {
  it('Connect fields use htmlFor/id pairs (B-463-2)', () => {
    for (const id of ['connect-name', 'connect-email', 'connect-phone', 'connect-message']) {
      expect(churchSrc).toContain(`htmlFor="${id}"`)
      expect(churchSrc).toContain(`id="${id}"`)
    }
  })

  it('coarse pointer font-size uses !important so text-sm cannot win (B-463-1 / SP-289)', () => {
    expect(css).toMatch(/textarea \{[\s\S]*?font-size:\s*16px\s*!important/)
  })
})
