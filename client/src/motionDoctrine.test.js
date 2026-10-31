// OPERATOR P8 / PHILOSOPHY §12 (amended 2026-10-25), held across the whole
// client: nothing springs, bounces or grows. The V1.6 sweep removed every
// spring transition (Donations, Clients, Payroll drawers; the Dashboard tab
// pill) and every entrance that scaled up from below 98%. This keeps them
// out.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const SRC = dirname(fileURLToPath(import.meta.url))
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.jsx?$/.test(name) && !/\.test\.jsx?$/.test(name)) out.push(p)
  }
  return out
}
const FILES = walk(SRC).map(p => [relative(SRC, p), readFileSync(p, 'utf8')])

describe('motion doctrine across the client', () => {
  it('no spring or bounce transitions', () => {
    const hits = FILES.filter(([, s]) => /type:\s*'spring'|\bbounce:\s*0?\.\d|\bstiffness:/.test(s)).map(([f]) => f)
    expect(hits).toEqual([])
  })

  it('no entrance grows from below 98% scale', () => {
    const hits = []
    for (const [f, s] of FILES) {
      for (const m of s.matchAll(/initial=\{\{[^}]*scale:\s*(0?\.\d+)/g)) {
        if (Number(m[1]) < 0.98) hits.push(`${f}: scale ${m[1]}`)
      }
    }
    expect(hits).toEqual([])
  })

  it('CONTROL: the patterns above do catch a violation', () => {
    expect(/type:\s*'spring'/.test("transition={{ type: 'spring', stiffness: 300 }}")).toBe(true)
    expect([...'initial={{ opacity: 0, scale: 0.92 }}'.matchAll(/initial=\{\{[^}]*scale:\s*(0?\.\d+)/g)][0][1]).toBe('0.92')
  })
})
