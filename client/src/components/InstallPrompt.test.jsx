// InstallPrompt user chrome is translated. Hard-coded English in the
// banner (title, chromium body, iOS Share → Add to Home Screen body,
// Install CTA, dismiss + dialog aria-labels) is the remaining PWA
// chrome defect after OfflineBanner #102 and UpdatePrompt #103.
// Restoring those literals in the component goes red. (OC-READY-01-026)

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, screen, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import InstallPrompt from './InstallPrompt'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const SRC_PATH = join(dirname(fileURLToPath(import.meta.url)), 'InstallPrompt.jsx')
const HARD_EN = [
  'Install OpenChurch',
  'Add to your home screen for one-tap access',
  'Dismiss install prompt',
  'Tap the',
  'Add to Home Screen',
]

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

function view() {
  return render(
    <LocaleProvider>
      <InstallPrompt />
    </LocaleProvider>,
  )
}

function stubMatchMedia(standalone = false) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query) => ({
      matches: standalone && String(query).includes('display-mode: standalone'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  })
}

function stubUserAgent(ua) {
  Object.defineProperty(window.navigator, 'userAgent', {
    configurable: true,
    value: ua,
  })
}

const DESKTOP_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const IOS_SAFARI_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

async function fireBeforeInstall() {
  const ev = new Event('beforeinstallprompt')
  ev.preventDefault = vi.fn()
  ev.prompt = vi.fn()
  Object.defineProperty(ev, 'userChoice', {
    value: Promise.resolve({ outcome: 'accepted' }),
  })
  await act(async () => {
    window.dispatchEvent(ev)
  })
  return ev
}

beforeEach(() => {
  localStorage.removeItem('ochr_locale')
  localStorage.removeItem('ochr_install_dismissed')
  stubMatchMedia(false)
  stubUserAgent(DESKTOP_UA)
  Object.defineProperty(window.navigator, 'standalone', {
    configurable: true,
    value: false,
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('InstallPrompt chrome is translated (OC-READY-01-026)', () => {
  it('CHROMIUM BANNER USES t() COPY — NO HARD-EN LITERALS IN JSX', async () => {
    view()
    await fireBeforeInstall()
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-label', STRINGS.en['install.title'])
    expect(dialog.textContent).toMatch(/install openchurch/i)
    expect(dialog.textContent).toMatch(/home screen/i)
    expect(dialog.textContent).toMatch(/schedule/i)
    expect(screen.getByRole('button', { name: STRINGS.en['install.cta'] })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: STRINGS.en['install.dismiss'] })).toBeInTheDocument()
  })

  it('SPANISH CHROMIUM CHROME IS SPANISH — NOT THE ENGLISH BANNER', async () => {
    localStorage.setItem('ochr_locale', 'es')
    view()
    await fireBeforeInstall()
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-label', STRINGS.es['install.title'])
    expect(dialog.textContent).toMatch(/instalar openchurch/i)
    expect(dialog.textContent).toMatch(/pantalla de inicio/i)
    expect(dialog.textContent).toMatch(/calendario/i)
    expect(dialog.textContent).not.toMatch(/one-tap access/i)
    expect(screen.getByRole('button', { name: STRINGS.es['install.cta'] })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: STRINGS.es['install.dismiss'] })).toBeInTheDocument()
  })

  it('iOS BANNER NAMES SHARE → ADD TO HOME SCREEN IN BOTH LOCALES', async () => {
    vi.useFakeTimers()
    stubUserAgent(IOS_SAFARI_UA)
    view()
    expect(screen.queryByRole('dialog')).toBeNull()
    await act(async () => { vi.advanceTimersByTime(4000) })
    const en = screen.getByRole('dialog')
    expect(en.textContent).toMatch(/share/i)
    expect(en.textContent).toMatch(/add to home screen/i)
    expect(en.textContent).not.toMatch(/one-tap access/i)
  })

  it('SPANISH iOS CHROME NAMES COMPARTIR → AÑADIR A LA PANTALLA DE INICIO', async () => {
    vi.useFakeTimers()
    localStorage.setItem('ochr_locale', 'es')
    stubUserAgent(IOS_SAFARI_UA)
    view()
    await act(async () => { vi.advanceTimersByTime(4000) })
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toMatch(/compartir/i)
    expect(dialog.textContent).toMatch(/a[nñ]adir a la pantalla de inicio/i)
    expect(dialog.textContent).not.toMatch(/add to home screen/i)
    expect(dialog.textContent).not.toMatch(/tap the/i)
  })

  it('i18n strings and the component wiring cannot reintroduce hard-EN chrome', () => {
    const src = readFileSync(SRC_PATH, 'utf8')
    const jsx = stripComments(src)
    expect(src).toMatch(/t\('install\.title'\)/)
    expect(src).toMatch(/t\('install\.body'\)/)
    expect(src).toMatch(/t\('install\.iosBody'\)/)
    expect(src).toMatch(/t\('install\.iosAdd'\)/)
    expect(src).toMatch(/t\('install\.cta'\)/)
    expect(src).toMatch(/t\('install\.dismiss'\)/)
    expect(src).toMatch(/aria-label=\{t\('install\.title'\)\}/)
    expect(jsx).not.toMatch(/\/> Install\b/)
    for (const phrase of HARD_EN) {
      expect(jsx, `JSX must not hard-code ${JSON.stringify(phrase)}`).not.toContain(phrase)
    }
    expect(STRINGS.en['install.title']).toMatch(/install openchurch/i)
    expect(STRINGS.en['install.body']).toMatch(/home screen/i)
    expect(STRINGS.en['install.iosBody']).toMatch(/\{share\}/)
    expect(STRINGS.en['install.iosBody']).toMatch(/\{add\}/)
    expect(STRINGS.en['install.iosAdd']).toMatch(/add to home screen/i)
    expect(STRINGS.en['install.cta']).toMatch(/^install$/i)
    expect(STRINGS.en['install.dismiss']).toMatch(/dismiss install prompt/i)
    expect(STRINGS.es['install.title']).toMatch(/instalar openchurch/i)
    expect(STRINGS.es['install.body']).toMatch(/pantalla de inicio/i)
    expect(STRINGS.es['install.iosBody']).toMatch(/\{share\}/)
    expect(STRINGS.es['install.iosBody']).toMatch(/\{add\}/)
    expect(STRINGS.es['install.iosAdd']).toMatch(/a[nñ]adir a la pantalla de inicio/i)
    expect(STRINGS.es['install.cta']).toMatch(/^instalar$/i)
    expect(STRINGS.es['install.dismiss']).toMatch(/aviso de instalaci[oó]n/i)
  })

  it('standalone still hides the banner — policy is unchanged', async () => {
    stubMatchMedia(true)
    view()
    await fireBeforeInstall()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('dismiss still writes ochr_install_dismissed — policy is unchanged', async () => {
    view()
    await fireBeforeInstall()
    await act(async () => {
      screen.getByRole('button', { name: STRINGS.en['install.dismiss'] }).click()
    })
    expect(localStorage.getItem('ochr_install_dismissed')).toBe('1')
  })

  it('iOS instructions still wait 4000ms — policy is unchanged', async () => {
    vi.useFakeTimers()
    stubUserAgent(IOS_SAFARI_UA)
    view()
    expect(screen.queryByRole('dialog')).toBeNull()
    await act(async () => { vi.advanceTimersByTime(3999) })
    expect(screen.queryByRole('dialog')).toBeNull()
    await act(async () => { vi.advanceTimersByTime(1) })
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})
