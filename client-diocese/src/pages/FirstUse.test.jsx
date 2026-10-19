// FirstUse dismiss aria goes through the thin local strings map + t().
// Hard-coded English is the remaining X-button chrome after parish
// Login crumbs (#119) and diocese ConfirmProvider (#123). Restoring
// the literal aria-label goes red. Visible "Got it" copy is out of scope.
//
// Diocese has no LocaleProvider. Device override (ochr_locale) is the
// only locale term — do not mount parish LocaleProvider here.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import { STRINGS } from '../i18n/strings'
import FirstUse from './FirstUse'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, 'FirstUse.jsx'), 'utf8')
const DISMISSED_KEY = 'ochr_diocese_first_use_dismissed'
const HARD_EN_ARIA = 'Dismiss this orientation'
const ARIA_KEY = 'firstUse.dismiss'

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

function mount() {
  return render(<FirstUse />)
}

beforeEach(() => {
  localStorage.removeItem('ochr_locale')
  localStorage.removeItem(DISMISSED_KEY)
})

describe('FirstUse dismiss aria is translated (thin local en+es)', () => {
  it('ENGLISH DISMISS USES t() COPY', () => {
    mount()
    expect(screen.getByRole('button', { name: STRINGS.en[ARIA_KEY] })).toBeInTheDocument()
  })

  it('SPANISH DISMISS IS SPANISH — NOT THE ENGLISH ARIA', () => {
    localStorage.setItem('ochr_locale', 'es')
    mount()
    expect(screen.getByRole('button', { name: STRINGS.es[ARIA_KEY] })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: STRINGS.en[ARIA_KEY] })).toBeNull()
  })

  it('dismiss still hides the orientation — no behavior change', () => {
    mount()
    expect(screen.getByText('What is here')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: STRINGS.en[ARIA_KEY] }))
    expect(screen.queryByText('What is here')).toBeNull()
    expect(localStorage.getItem(DISMISSED_KEY)).toBe('1')
    expect(screen.queryByRole('button', { name: STRINGS.en[ARIA_KEY] })).toBeNull()
  })

  it('i18n strings and the component wiring cannot reintroduce hard-EN aria', () => {
    const jsx = stripComments(SRC)
    expect(SRC).toMatch(/t\('firstUse\.dismiss'\)/)
    expect(SRC).toMatch(/function t\(/)
    expect(jsx).not.toMatch(/useLocale\s*\(/)
    expect(jsx).not.toMatch(/LocaleProvider/)
    expect(jsx).not.toMatch(/from\s+['"][^'"]*\/i18n['"]/)
    expect(jsx, 'JSX must not hard-code aria "Dismiss this orientation"').not.toMatch(
      /aria-label=["']Dismiss this orientation["']/,
    )
    expect(jsx, `JSX must not hard-code aria ${JSON.stringify(HARD_EN_ARIA)}`).not.toMatch(
      new RegExp(`aria-label=["']${HARD_EN_ARIA}["']`),
    )
    expect(STRINGS.en[ARIA_KEY]).toBe(HARD_EN_ARIA)
    expect(STRINGS.es[ARIA_KEY]).toMatch(/cerrar esta orientaci[oó]n/i)
    expect(STRINGS.es[ARIA_KEY]).not.toBe(STRINGS.en[ARIA_KEY])
  })

  it('FirstUse mounts without a LocaleProvider', () => {
    expect(() => mount()).not.toThrow()
    expect(screen.getByText('What is here')).toBeInTheDocument()
  })
})
