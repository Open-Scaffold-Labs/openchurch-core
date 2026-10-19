// Root provider order (OC-READY-01-030).
// After #106 the only ErrorBoundary sat INSIDE LocaleProvider, so a
// crash in AuthProvider or LocaleProvider escaped recovery chrome.
// The outer boundary wraps Auth + Locale; the inner one still wraps
// Toast + App. ConfirmProvider must stay below LocaleProvider — it
// calls useLocale(), and a provider cannot read a context mounted
// below it. Putting ConfirmProvider back above the locale spine
// throws on first paint.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from './i18n'
import { STRINGS } from './i18n/strings'
import { ConfirmProvider, useConfirm } from './components/ConfirmProvider'
import ErrorBoundary from './components/ErrorBoundary'
import { ToastProvider } from './components/ToastProvider'

const authState = vi.hoisted(() => ({ boom: false }))

vi.mock('./context/AuthContext', () => ({
  useAuth: () => {
    if (authState.boom) throw new Error('locale-auth-probe')
    return {
      user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
      token: 't', loading: false, canWrite: true, isAdmin: true,
    }
  },
}))

const HERE = dirname(fileURLToPath(import.meta.url))
const MAIN_SRC = readFileSync(join(HERE, 'main.jsx'), 'utf8')
const APP_SRC = readFileSync(join(HERE, 'App.jsx'), 'utf8')

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

function Probe() {
  useConfirm()
  return <p>confirm-ok</p>
}

function Boom({ label = 'probe' }) {
  throw new Error(label)
}

function Marker() {
  return <span data-testid="outer-sibling">alive</span>
}

function recoveryChrome(locale = 'en') {
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(STRINGS[locale]['error.title'])
  expect(screen.getByText(STRINGS[locale]['error.body'])).toBeInTheDocument()
  expect(screen.getByRole('button', { name: STRINGS[locale]['error.reload'] })).toBeInTheDocument()
}

beforeEach(() => {
  authState.boom = false
  localStorage.removeItem('ochr_locale')
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  console.error.mockRestore()
})

describe('root provider order (OC-READY-01-030)', () => {
  it('tree is outer EB → Auth → Locale → inner EB → Toast → App', () => {
    const jsx = stripComments(MAIN_SRC)
    const openEB = [...jsx.matchAll(/<ErrorBoundary>/g)].map((m) => m.index)
    const closeEB = [...jsx.matchAll(/<\/ErrorBoundary>/g)].map((m) => m.index)
    expect(openEB, 'main.jsx must mount two <ErrorBoundary> copies').toHaveLength(2)
    expect(closeEB).toHaveLength(2)

    const auth = jsx.indexOf('<AuthProvider>')
    const locale = jsx.indexOf('<LocaleProvider>')
    const toast = jsx.indexOf('<ToastProvider>')
    const app = jsx.indexOf('<App')
    const authClose = jsx.indexOf('</AuthProvider>')
    const localeClose = jsx.indexOf('</LocaleProvider>')
    const toastClose = jsx.indexOf('</ToastProvider>')

    expect(auth, 'main.jsx must mount <AuthProvider>').toBeGreaterThan(-1)
    expect(locale, 'main.jsx must mount <LocaleProvider>').toBeGreaterThan(-1)
    expect(toast, 'main.jsx must mount <ToastProvider>').toBeGreaterThan(-1)
    expect(app, 'main.jsx must mount <App').toBeGreaterThan(-1)

    expect(openEB[0]).toBeLessThan(auth)
    expect(auth).toBeLessThan(locale)
    expect(locale).toBeLessThan(openEB[1])
    expect(openEB[1]).toBeLessThan(toast)
    expect(toast).toBeLessThan(app)

    expect(toastClose).toBeLessThan(closeEB[0])
    expect(closeEB[0]).toBeLessThan(localeClose)
    expect(localeClose).toBeLessThan(authClose)
    expect(authClose).toBeLessThan(closeEB[1])
  })

  it('AuthProvider wraps LocaleProvider so the parish default still joins', () => {
    const jsx = stripComments(MAIN_SRC)
    const auth = jsx.indexOf('<AuthProvider>')
    const locale = jsx.indexOf('<LocaleProvider>')
    expect(auth, 'main.jsx must mount <AuthProvider> above LocaleProvider').toBeGreaterThan(-1)
    expect(auth).toBeLessThan(locale)
    expect(jsx.indexOf('</LocaleProvider>')).toBeLessThan(jsx.indexOf('</AuthProvider>'))
  })

  it('ConfirmProvider stays in App.jsx — not remounted above LocaleProvider', () => {
    const mainJsx = stripComments(MAIN_SRC)
    const appJsx = stripComments(APP_SRC)
    expect(mainJsx).not.toMatch(/<ConfirmProvider/)
    expect(appJsx).toMatch(/<ConfirmProvider>/)
    expect(appJsx).not.toMatch(/<LocaleProvider>/)
    expect(appJsx).not.toMatch(/<AuthProvider>/)
    expect(appJsx).not.toMatch(/<ErrorBoundary>/)
    expect(appJsx).not.toMatch(/<ToastProvider>/)
  })

  it('ConfirmProvider mounts under LocaleProvider without throwing', () => {
    render(
      <LocaleProvider>
        <ConfirmProvider>
          <Probe />
        </ConfirmProvider>
      </LocaleProvider>,
    )
    expect(screen.getByText('confirm-ok')).toBeInTheDocument()
  })

  it('ConfirmProvider above LocaleProvider throws — the first-paint defect', () => {
    expect(() => render(
      <ConfirmProvider>
        <LocaleProvider>
          <Probe />
        </LocaleProvider>
      </ConfirmProvider>,
    )).toThrow(/useLocale must be used inside <LocaleProvider>/)
  })

  it('ToastProvider stays under LocaleProvider — above it still throws', () => {
    expect(() => render(
      <ToastProvider>
        <p>toast-ok</p>
      </ToastProvider>,
    )).toThrow(/useLocale must be used inside <LocaleProvider>/)
  })
})

describe('outer ErrorBoundary catch (OC-READY-01-030)', () => {
  it('Auth-position throw shows recovery chrome — outer sibling is replaced', () => {
    render(
      <ErrorBoundary>
        <Marker />
        <Boom label="auth-probe" />
      </ErrorBoundary>,
    )
    recoveryChrome('en')
    expect(screen.queryByTestId('outer-sibling')).not.toBeInTheDocument()
  })

  it('Locale-position throw (inside Auth slot, outside inner EB) is an outer catch', () => {
    render(
      <ErrorBoundary>
        <Marker />
        <div data-testid="auth-slot">
          <Boom label="locale-probe" />
          <ErrorBoundary>
            <p>app-ok</p>
          </ErrorBoundary>
        </div>
      </ErrorBoundary>,
    )
    recoveryChrome('en')
    expect(screen.queryByTestId('outer-sibling')).not.toBeInTheDocument()
    expect(screen.queryByText('app-ok')).not.toBeInTheDocument()
  })

  it('LocaleProvider render throw (useAuth boom) is caught by the outer boundary', () => {
    authState.boom = true
    render(
      <ErrorBoundary>
        <Marker />
        <LocaleProvider>
          <ErrorBoundary>
            <p>app-ok</p>
          </ErrorBoundary>
        </LocaleProvider>
      </ErrorBoundary>,
    )
    recoveryChrome('en')
    expect(screen.queryByTestId('outer-sibling')).not.toBeInTheDocument()
    expect(screen.queryByText('app-ok')).not.toBeInTheDocument()
  })

  it('outer catch outside LocaleProvider still follows ochr_locale', () => {
    localStorage.setItem('ochr_locale', 'es')
    render(
      <ErrorBoundary>
        <Boom label="auth-probe" />
      </ErrorBoundary>,
    )
    recoveryChrome('es')
    expect(screen.queryByText(STRINGS.en['error.title'])).not.toBeInTheDocument()
  })

  it('without an outer boundary, an Auth-position throw escapes', () => {
    expect(() => render(<Boom label="auth-probe" />)).toThrow(/auth-probe/)
  })
})

describe('inner ErrorBoundary still catches App throws (OC-READY-01-030)', () => {
  it('App throw shows recovery chrome and leaves the outer sibling mounted', () => {
    render(
      <ErrorBoundary>
        <Marker />
        <LocaleProvider>
          <ErrorBoundary>
            <ToastProvider>
              <Boom label="app-probe" />
            </ToastProvider>
          </ErrorBoundary>
        </LocaleProvider>
      </ErrorBoundary>,
    )
    expect(screen.getByTestId('outer-sibling')).toBeInTheDocument()
    recoveryChrome('en')
  })

  it('inner App crash still follows the live locale spine (es)', () => {
    localStorage.setItem('ochr_locale', 'es')
    render(
      <ErrorBoundary>
        <Marker />
        <LocaleProvider>
          <ErrorBoundary>
            <Boom label="app-probe" />
          </ErrorBoundary>
        </LocaleProvider>
      </ErrorBoundary>,
    )
    expect(screen.getByTestId('outer-sibling')).toBeInTheDocument()
    recoveryChrome('es')
    expect(screen.queryByText(STRINGS.en['error.title'])).not.toBeInTheDocument()
  })
})
