// ErrorBoundary user chrome is translated. Hard-coded English in the
// fallback (title, body, Reload CTA) is the remaining crash-screen
// defect after InstallPrompt #104. Restoring those literals in the
// component goes red. (OC-READY-01-027)
//
// The class itself does not call hooks. Locale lives in ErrorFallback.
// The inner mount sits inside LocaleProvider (main.jsx), so App-tree
// crash chrome follows the live app locale — not only ochr_locale.
// The outer mount wraps Auth + Locale (OC-READY-01-030).

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import ErrorBoundary from './ErrorBoundary'

const authState = vi.hoisted(() => ({ orgLocale: 'en' }))

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: authState.orgLocale } },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const SRC_PATH = join(dirname(fileURLToPath(import.meta.url)), 'ErrorBoundary.jsx')
const HARD_EN = [
  'Something went wrong',
  'Reload the page',
  "We've logged it on our end",
  'unexpected error',
]

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

function Boom() {
  throw new Error('boundary-probe')
}

function view({ provider = true } = {}) {
  const tree = (
    <ErrorBoundary>
      <Boom />
    </ErrorBoundary>
  )
  return render(provider ? <LocaleProvider>{tree}</LocaleProvider> : tree)
}

beforeEach(() => {
  authState.orgLocale = 'en'
  localStorage.removeItem('ochr_locale')
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  console.error.mockRestore()
})

describe('ErrorBoundary chrome is translated (OC-READY-01-027)', () => {
  it('ENGLISH FALLBACK USES t() COPY — NO HARD-EN LITERALS IN JSX', () => {
    view()
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(STRINGS.en['error.title'])
    expect(screen.getByText(STRINGS.en['error.body'])).toBeInTheDocument()
    expect(screen.getByRole('button', { name: STRINGS.en['error.reload'] })).toBeInTheDocument()
  })

  it('SPANISH FALLBACK IS SPANISH — NOT THE ENGLISH CRASH SCREEN', () => {
    localStorage.setItem('ochr_locale', 'es')
    view()
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(STRINGS.es['error.title'])
    expect(screen.getByText(STRINGS.es['error.body'])).toBeInTheDocument()
    expect(screen.getByRole('button', { name: STRINGS.es['error.reload'] })).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['error.title'])).not.toBeInTheDocument()
    expect(screen.queryByText(/something went wrong/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /reload the page/i })).toBeNull()
  })

  it('APP LOCALE es (parish default, no ochr_locale) SPEAKS SPANISH', () => {
    authState.orgLocale = 'es'
    view()
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(STRINGS.es['error.title'])
    expect(screen.getByText(STRINGS.es['error.body'])).toBeInTheDocument()
    expect(screen.getByRole('button', { name: STRINGS.es['error.reload'] })).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['error.title'])).not.toBeInTheDocument()
    expect(screen.queryByText(/something went wrong/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /reload the page/i })).toBeNull()
  })

  it('ROOT TREE (no LocaleProvider) STILL FOLLOWS ochr_locale', () => {
    localStorage.setItem('ochr_locale', 'es')
    view({ provider: false })
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(STRINGS.es['error.title'])
    expect(screen.getByRole('button', { name: STRINGS.es['error.reload'] })).toBeInTheDocument()
    expect(screen.queryByText(/something went wrong/i)).not.toBeInTheDocument()
  })

  it('i18n strings and the component wiring cannot reintroduce hard-EN chrome', () => {
    const src = readFileSync(SRC_PATH, 'utf8')
    const jsx = stripComments(src)
    expect(src).toMatch(/t\('error\.title'\)/)
    expect(src).toMatch(/t\('error\.body'\)/)
    expect(src).toMatch(/t\('error\.reload'\)/)
    expect(src).toMatch(/function ErrorFallback/)
    expect(src).toMatch(/class ErrorBoundary extends Component/)
    expect(src).not.toMatch(/class ErrorBoundary extends Component \{[\s\S]*use(OptionalLocale|Locale|Context|State|Effect)\(/)
    for (const phrase of HARD_EN) {
      expect(jsx, `JSX must not hard-code ${JSON.stringify(phrase)}`).not.toContain(phrase)
    }
    expect(STRINGS.en['error.title']).toMatch(/something went wrong/i)
    expect(STRINGS.en['error.body']).toMatch(/logged it on our end/i)
    expect(STRINGS.en['error.reload']).toMatch(/reload the page/i)
    expect(STRINGS.es['error.title']).toMatch(/algo sali[oó] mal/i)
    expect(STRINGS.es['error.body']).toMatch(/error inesperado/i)
    expect(STRINGS.es['error.reload']).toMatch(/recargar la p[aá]gina/i)
    expect(STRINGS.es['error.title']).not.toMatch(/something went wrong/i)
    expect(STRINGS.es['error.reload']).not.toMatch(/reload/i)
  })

  it('reload still calls location.reload — policy is unchanged', () => {
    const reload = vi.fn()
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload },
    })
    view()
    screen.getByRole('button', { name: STRINGS.en['error.reload'] }).click()
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
