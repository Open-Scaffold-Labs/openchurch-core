// PageErrorBoundary user chrome is translated. Hard-coded English in
// the compact fallback (title, body, Try again CTA) is the remaining
// per-page crash defect after InstallPrompt #104. Restoring those
// literals in the component goes red. (OC-READY-01-027)
//
// The class itself does not call hooks. Locale lives in PageErrorFallback.
// This boundary sits inside LocaleProvider in App.jsx.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, screen, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import PageErrorBoundary from './PageErrorBoundary'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const SRC_PATH = join(dirname(fileURLToPath(import.meta.url)), 'PageErrorBoundary.jsx')
const HARD_EN = [
  'This page hit an error',
  'Try again',
  'The rest of the app is still fine',
  'use the sidebar',
]

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

function Boom() {
  throw new Error('page-boundary-probe')
}

function view() {
  return render(
    <LocaleProvider>
      <PageErrorBoundary scope="Members">
        <Boom />
      </PageErrorBoundary>
    </LocaleProvider>,
  )
}

beforeEach(() => {
  localStorage.removeItem('ochr_locale')
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  console.error.mockRestore()
})

describe('PageErrorBoundary chrome is translated (OC-READY-01-027)', () => {
  it('ENGLISH FALLBACK USES t() COPY — NO HARD-EN LITERALS IN JSX', () => {
    view()
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(STRINGS.en['error.pageTitle'])
    expect(screen.getByText(STRINGS.en['error.pageBody'])).toBeInTheDocument()
    expect(screen.getByRole('button', { name: STRINGS.en['error.tryAgain'] })).toBeInTheDocument()
  })

  it('SPANISH FALLBACK IS SPANISH — NOT THE ENGLISH PAGE CRASH', () => {
    localStorage.setItem('ochr_locale', 'es')
    view()
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(STRINGS.es['error.pageTitle'])
    expect(screen.getByText(STRINGS.es['error.pageBody'])).toBeInTheDocument()
    expect(screen.getByRole('button', { name: STRINGS.es['error.tryAgain'] })).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['error.pageTitle'])).not.toBeInTheDocument()
    expect(screen.queryByText(/this page hit an error/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^try again$/i })).toBeNull()
  })

  it('i18n strings and the component wiring cannot reintroduce hard-EN chrome', () => {
    const src = readFileSync(SRC_PATH, 'utf8')
    const jsx = stripComments(src)
    expect(src).toMatch(/t\('error\.pageTitle'\)/)
    expect(src).toMatch(/t\('error\.pageBody'\)/)
    expect(src).toMatch(/t\('error\.tryAgain'\)/)
    expect(src).toMatch(/function PageErrorFallback/)
    expect(src).toMatch(/class PageErrorBoundary extends Component/)
    expect(src).not.toMatch(/class PageErrorBoundary extends Component \{[\s\S]*use(OptionalLocale|Locale|Context|State|Effect)\(/)
    for (const phrase of HARD_EN) {
      expect(jsx, `JSX must not hard-code ${JSON.stringify(phrase)}`).not.toContain(phrase)
    }
    expect(STRINGS.en['error.pageTitle']).toMatch(/this page hit an error/i)
    expect(STRINGS.en['error.pageBody']).toMatch(/sidebar/i)
    expect(STRINGS.en['error.tryAgain']).toMatch(/^try again$/i)
    expect(STRINGS.es['error.pageTitle']).toMatch(/esta p[aá]gina encontr[oó] un error/i)
    expect(STRINGS.es['error.pageBody']).toMatch(/barra lateral/i)
    expect(STRINGS.es['error.tryAgain']).toMatch(/int[eé]ntelo de nuevo/i)
    expect(STRINGS.es['error.pageTitle']).not.toMatch(/this page hit an error/i)
    expect(STRINGS.es['error.tryAgain']).not.toMatch(/try again/i)
  })

  it('retry still clears the boundary — policy is unchanged', () => {
    let shouldThrow = true
    function Flaky() {
      if (shouldThrow) throw new Error('transient')
      return <p>page recovered</p>
    }
    render(
      <LocaleProvider>
        <PageErrorBoundary scope="Members">
          <Flaky />
        </PageErrorBoundary>
      </LocaleProvider>,
    )
    expect(screen.getByRole('button', { name: STRINGS.en['error.tryAgain'] })).toBeInTheDocument()
    shouldThrow = false
    act(() => {
      screen.getByRole('button', { name: STRINGS.en['error.tryAgain'] }).click()
    })
    expect(screen.getByText('page recovered')).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['error.pageTitle'])).not.toBeInTheDocument()
  })
})
