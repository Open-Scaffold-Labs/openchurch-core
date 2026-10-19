// I18N-L1-13 — shell leaks that shipped English (or a raw key) on every
// page. Mutate any one of these and this file goes red:
//   1. aria-label="Open navigation menu" / "Open search" returns
//   2. "Expand sidebar" / "Collapse sidebar" returns as a literal
//   3. the mobile header prints the word Search instead of t(),
//      including the jsx expression {'Search'} / {"Search"}
//   4. nav.Diocese (or a shell key) is missing from es, or es copies en

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { STRINGS } from './strings'

const APP = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../App.jsx'), 'utf8')

describe('I18N-L1-13 shell locale', () => {
  it('navigation, search, and the sidebar control go through t()', () => {
    expect(APP).not.toMatch(/aria-label="Open navigation menu"/)
    expect(APP).not.toMatch(/aria-label="Open search"/)
    expect(APP).not.toMatch(/Expand sidebar/)
    expect(APP).not.toMatch(/Collapse sidebar/)
    expect(APP).not.toMatch(/>Search</)
    expect(APP).not.toMatch(/\{\s*['"]Search['"]\s*\}/)
    expect(APP).not.toMatch(/\{\s*`Search`\s*\}/)
    expect(APP).toMatch(/t\('shell\.openNav'\)/)
    expect(APP).toMatch(/t\('shell\.openSearch'\)/)
    expect(APP).toMatch(/t\('shell\.searchShort'\)/)
    expect(APP).toMatch(/t\('shell\.expandSidebar'\)/)
    expect(APP).toMatch(/t\('shell\.collapseSidebar'\)/)
    expect(APP).toMatch(/t\(`nav\.\$\{label\}`\)/)
    expect(APP).toMatch(/t\(`navsec\.\$\{group\.section\}`\)/)
  })

  it('the new keys exist in en and es, and Spanish does not copy English', () => {
    const keys = [
      'nav.Diocese',
      'shell.expandSidebar',
      'shell.collapseSidebar',
      'shell.openNav',
      'shell.openSearch',
      'shell.searchShort',
    ]
    for (const key of keys) {
      expect(STRINGS.en[key], key).toBeTruthy()
      expect(STRINGS.es[key], key).toBeTruthy()
      expect(STRINGS.es[key], key).not.toBe(STRINGS.en[key])
    }
    expect(STRINGS.en['nav.Diocese']).toBe('Diocese')
    expect(STRINGS.es['nav.Diocese']).toBe('Diócesis')
    expect(STRINGS.es['shell.searchShort']).toBe('Buscar')
    expect(STRINGS.es['shell.openSearch']).toBe('Abrir la búsqueda')
  })
})
