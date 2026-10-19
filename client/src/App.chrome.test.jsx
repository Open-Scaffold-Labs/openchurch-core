// Shell theme title + PageFallback loading aria go through strings.js +
// t() en+es. Hard-coded English is the remaining App chrome after Login
// crumbs (#119). Restoring those literals in App.jsx goes red.
// Collapse/expand titles and other shell hard-EN stay out of scope.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { STRINGS } from './i18n/strings'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP_SRC = readFileSync(join(HERE, 'App.jsx'), 'utf8')

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

const THEME_KEYS = ['shell.light', 'shell.dark']
const LOADING_KEY = 'shell.loadingPage'
const HARD_EN = ['Light mode', 'Dark mode', 'Loading page']

describe('Shell theme title + PageFallback loading aria are translated', () => {
  it('theme title and loading aria use t() keys in both locales', () => {
    expect(APP_SRC).toMatch(/title=\{collapsed \? \(dark \? t\('shell\.light'\) : t\('shell\.dark'\)/)
    expect(APP_SRC).toMatch(/aria-label=\{t\('shell\.loadingPage'\)\}/)
    expect(APP_SRC).toMatch(/function PageFallback\(/)
    expect(APP_SRC).toMatch(/useLocale\(/)
    for (const key of [...THEME_KEYS, LOADING_KEY]) {
      expect(STRINGS.en[key], key).toBeTruthy()
      expect(STRINGS.es[key], key).toBeTruthy()
      expect(STRINGS.es[key], key).not.toBe(STRINGS.en[key])
    }
    expect(STRINGS.en['shell.light']).toBe('Light Mode')
    expect(STRINGS.en['shell.dark']).toBe('Dark Mode')
    expect(STRINGS.en[LOADING_KEY]).toBe('Loading page')
    expect(STRINGS.es['shell.light']).toMatch(/modo claro/i)
    expect(STRINGS.es['shell.dark']).toMatch(/modo oscuro/i)
    expect(STRINGS.es[LOADING_KEY]).toMatch(/cargando la p[aá]gina/i)
  })

  it('i18n wiring cannot reintroduce hard-EN theme title or loading aria', () => {
    const jsx = stripComments(APP_SRC)
    expect(jsx).not.toMatch(/title=\{collapsed \? \(dark \? ['"]Light mode['"]/)
    expect(jsx).not.toMatch(/['"]Dark mode['"]/)
    expect(jsx).not.toMatch(/aria-label=["']Loading page["']/)
    for (const phrase of HARD_EN) {
      expect(jsx, `JSX must not hard-code ${JSON.stringify(phrase)}`).not.toMatch(
        new RegExp(`['"\`]${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`),
      )
    }
  })
})
