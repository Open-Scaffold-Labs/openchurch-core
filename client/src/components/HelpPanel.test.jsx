// Help Roles Yes/No aria goes through strings.js + t() en+es.
// Hard-coded English is the remaining Roles-table chrome after Login
// crumbs (#119). Restoring those literals in YesNo goes red.
// Visible guide/FAQ corpus stays English-first (SUP follow-up).

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import HelpPanel from './HelpPanel'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, 'HelpPanel.jsx'), 'utf8')
const HARD_EN_ARIA = ['Yes', 'No']
const ARIA_KEYS = ['help.yes', 'help.no']

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

function mount() {
  return render(
    <LocaleProvider>
      <HelpPanel open onClose={() => {}} />
    </LocaleProvider>,
  )
}

function openRoles(locale = 'en') {
  mount()
  fireEvent.click(screen.getByRole('button', { name: STRINGS[locale]['help.tabRoles'] }))
}

beforeEach(() => {
  localStorage.removeItem('ochr_locale')
})

describe('Help Roles Yes/No aria is translated', () => {
  it('ENGLISH YES AND NO USE t() COPY', () => {
    openRoles()
    expect(screen.getAllByLabelText(STRINGS.en['help.yes']).length).toBeGreaterThan(0)
    expect(screen.getAllByLabelText(STRINGS.en['help.no']).length).toBeGreaterThan(0)
  })

  it('SPANISH YES IS SPANISH — NOT THE ENGLISH ARIA', () => {
    localStorage.setItem('ochr_locale', 'es')
    openRoles('es')
    expect(screen.getAllByLabelText(STRINGS.es['help.yes']).length).toBeGreaterThan(0)
    expect(screen.queryByLabelText(STRINGS.en['help.yes'])).toBeNull()
    // "No" is the same word in both locales — that is honest, not a miss.
    expect(screen.getAllByLabelText(STRINGS.es['help.no']).length).toBeGreaterThan(0)
  })

  it('i18n strings and the component wiring cannot reintroduce hard-EN aria', () => {
    const jsx = stripComments(SRC)
    for (const key of ARIA_KEYS) {
      expect(SRC, key).toMatch(new RegExp(`t\\('${key.replace('.', '\\.')}'`))
      expect(STRINGS.en[key], key).toBeTruthy()
      expect(STRINGS.es[key], key).toBeTruthy()
    }
    expect(SRC).toMatch(/useLocale\(/)
    expect(jsx).not.toMatch(/aria-label=["']Yes["']/)
    expect(jsx).not.toMatch(/aria-label=["']No["']/)
    for (const phrase of HARD_EN_ARIA) {
      expect(jsx, `JSX must not hard-code aria ${JSON.stringify(phrase)}`).not.toMatch(
        new RegExp(`aria-label=["']${phrase}["']`),
      )
    }
    expect(STRINGS.en['help.yes']).toBe('Yes')
    expect(STRINGS.en['help.no']).toBe('No')
    expect(STRINGS.es['help.yes']).toMatch(/^s[ií]$/i)
    expect(STRINGS.es['help.yes']).not.toBe(STRINGS.en['help.yes'])
    expect(STRINGS.es['help.no']).toBe('No')
  })
})
