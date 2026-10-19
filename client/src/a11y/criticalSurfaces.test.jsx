// A11Y-L2-14 — repeatable accessibility contracts for auth, Golden
// Journey 1, Golden Journey 2, PWA chrome, and the sidebar.
//
// jsdom + the accessible-name algorithm. Not a screen reader, not a
// phone, not a contrast meter. Rendered contrast, VoiceOver, physical
// touch, and getBoundingClientRect hit targets are NOT MEASURED.
// Coarse-pointer evidence is the class contract in index.css (the same
// limit A11Y-L0-03 already named).
//
// The probe block at the bottom renders broken DOM on purpose. Mutate
// a product surface back to an unlabeled control, tabindex=-1 on Show
// password, or a Dashboard link whose name is only "OpenChurch", and
// the matching product test goes red.

import { readFile } from 'node:fs/promises'
import { render, screen, fireEvent, within, act } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { ThemeProvider } from '../context/ThemeContext'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import { Sidebar } from '../App'
import Login from '../pages/Login'
import Signup from '../pages/Signup'
import ForgotPassword from '../pages/ForgotPassword'
import ResetPassword from '../pages/ResetPassword'
import MassIntentions from '../pages/MassIntentions'
import SacristySheet from '../pages/SacristySheet'
import MemberDetail from '../pages/MemberDetail'
import SacramentCertificate from '../pages/SacramentCertificate'
import OfflineBanner from '../components/OfflineBanner'
import InstallPrompt from '../components/InstallPrompt'
import UpdatePrompt from '../components/UpdatePrompt'
import { pwaRegisterHarness } from '../test/pwa-register-react'
import { GJ1_NOW, stubGoldenJourney1Fetch } from '../pages/goldenJourney1.fixture.js'
import {
  GJ2_MEMBER_ID,
  GJ2_RECORD_ID,
  stubGoldenJourney2Fetch,
} from '../pages/goldenJourney2.fixture.js'
import {
  accessibleName,
  auditDescribedBy,
  auditDialogs,
  auditFocusable,
  auditHeadingOrder,
  auditInteractiveNames,
  auditLabelRelationship,
  auditLive,
  auditSurface,
} from './auditDom'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: {
      id: 1,
      name: 'Secretary',
      role: 'admin',
      organization: { id: 1, name: 'St Test', locale: 'en', tradition: 'catholic' },
    },
    token: 't',
    loading: false,
    isAuthenticated: true,
    canWrite: true,
    isAdmin: true,
    login: vi.fn(),
    signup: vi.fn(),
  }),
}))

function withLocale(ui, path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <LocaleProvider>
        <ToastProvider>
          <ConfirmProvider>{ui}</ConfirmProvider>
        </ToastProvider>
      </LocaleProvider>
    </MemoryRouter>,
  )
}

function stubMatchMedia() {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  })
}

beforeEach(() => {
  localStorage.removeItem('ochr_locale')
  localStorage.removeItem('ochr_install_dismissed')
  stubMatchMedia()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('A11Y-L2-14 probe (broken DOM must fail)', () => {
  it('an input beside an unassociated label is unlabeled', () => {
    const { container } = render(
      <div>
        <label>Intention</label>
        <input placeholder="For …" />
      </div>,
    )
    expect(auditLabelRelationship(container).map((f) => f.code)).toContain('unlabeled')
    expect(auditInteractiveNames(container).map((f) => f.code)).toContain('unnamed')
  })

  it('htmlFor, a wrapping label, and aria-label each clear the probe', () => {
    const { container } = render(
      <div>
        <label htmlFor="a">Intention</label>
        <input id="a" />
        <label>
          Departed
          <input type="checkbox" />
        </label>
        <input aria-label="Search the book" />
      </div>,
    )
    expect(auditLabelRelationship(container)).toEqual([])
    expect(auditInteractiveNames(container)).toEqual([])
  })

  it('placeholder alone does not count as a label', () => {
    const { container } = render(<input placeholder="Search" />)
    expect(auditLabelRelationship(container)).toHaveLength(1)
  })

  it('a broken aria-describedby is a finding; a real one is not', () => {
    const broken = render(<input aria-label="Reason" aria-describedby="missing" />)
    expect(auditDescribedBy(broken.container).map((f) => f.code)).toContain('describedby-missing')
    broken.unmount()
    const ok = render(
      <div>
        <input id="r" aria-label="Reason" aria-describedby="r-hint" />
        <p id="r-hint">Kept with the entry.</p>
      </div>,
    )
    expect(auditDescribedBy(ok.container)).toEqual([])
  })

  it('a heading skip and a removed tab stop are findings', () => {
    const { container } = render(
      <div>
        <h1>Book</h1>
        <h3>Wednesday</h3>
        <button type="button" tabIndex={-1}>Show password</button>
      </div>,
    )
    expect(auditHeadingOrder(container).map((f) => f.code)).toContain('heading-skip')
    expect(auditFocusable(container).map((f) => f.code)).toContain('removed-from-tab-order')
  })

  it('an unnamed dialog fails; a named one with a polite live region does not', () => {
    const bad = render(<div role="dialog"><p>Install</p></div>)
    expect(auditDialogs(bad.container).map((f) => f.code)).toContain('dialog-unnamed')
    bad.unmount()
    const good = render(
      <div>
        <div role="dialog" aria-label="Install OpenChurch"><p>Add it to the home screen.</p></div>
        <div role="status" aria-live="polite">You’re offline</div>
      </div>,
    )
    expect(auditDialogs(good.container)).toEqual([])
    expect(auditLive(good.container)).toEqual([])
    const invalid = render(<div aria-live="rude">no</div>)
    expect(auditLive(invalid.container).map((f) => f.code)).toContain('aria-live-invalid')
  })
})

describe('authentication', () => {
  it('login, signup, forgot, and reset controls are named, labeled, and in tab order', () => {
    for (const ui of [
      <Login />,
      <Signup />,
      <ForgotPassword />,
      <ResetPassword />,
    ]) {
      const view = withLocale(ui, ui.type === ResetPassword ? '/reset?token=sample-token' : '/')
      expect(auditSurface(view.container)).toEqual([])
      view.unmount()
    }
    const missing = withLocale(<ResetPassword />, '/reset')
    expect(auditSurface(missing.container)).toEqual([])
    missing.unmount()
  })

  it('show-password and the locale switches use tap-auth and stay in tab order', () => {
    const login = withLocale(<Login />)
    for (const name of [/show password/i, 'English', 'Español']) {
      const el = screen.getByRole('button', { name })
      expect(el.className).toMatch(/\btap-auth\b/)
      expect(el).not.toHaveAttribute('tabIndex', '-1')
    }
    login.unmount()

    const reset = withLocale(<ResetPassword />, '/reset?token=sample-token')
    const show = screen.getByRole('button', { name: /show password/i })
    expect(show.className).toMatch(/\btap-auth\b/)
    expect(show).not.toHaveAttribute('tabIndex', '-1')
    expect(screen.getByRole('button', { name: 'English' }).className).toMatch(/\btap-auth\b/)
    reset.unmount()

    const forgot = withLocale(<ForgotPassword />)
    expect(screen.getByRole('button', { name: 'English' }).className).toMatch(/\btap-auth\b/)
    expect(screen.getByRole('link', { name: /back to sign in/i }).className).toMatch(/\btap-auth\b/)
    forgot.unmount()

    const bare = withLocale(<ResetPassword />, '/reset')
    expect(screen.getByRole('button', { name: 'Español' }).className).toMatch(/\btap-auth\b/)
    bare.unmount()
  })

  it('stylesheet still grants tap-auth 44px only inside pointer:coarse', async () => {
    const src = await readFile('src/index.css', 'utf8')
    expect(src).toMatch(/@media\s*\(pointer:\s*coarse\)[\s\S]*\.tap-auth\s*\{[\s\S]*min-width:\s*44px[\s\S]*min-height:\s*44px/)
  })
})

describe('Golden Journey 1', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(GJ1_NOW)
    stubGoldenJourney1Fetch(vi)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('the intention form labels every control, and the sheet headings do not skip', async () => {
    const book = withLocale(<MassIntentions />, '/mass-intentions')
    fireEvent.click(screen.getByRole('button', { name: STRINGS.en['mi.add'] }))
    const form = screen.getByRole('button', { name: STRINGS.en['mi.save'] }).closest('form')
    expect(auditSurface(form)).toEqual([])
    expect(screen.getByLabelText(STRINGS.en['mi.intention'])).toHaveAttribute('id')
    expect(screen.getByLabelText(STRINGS.en['mi.massDate'])).toHaveAttribute('type', 'date')
    expect(screen.getByLabelText(STRINGS.en['mi.assign']).tagName).toBe('SELECT')
    expect(screen.getByLabelText(STRINGS.en['mi.status']).tagName).toBe('SELECT')
    expect(auditHeadingOrder(book.container)).toEqual([])
    book.unmount()

    const sheet = withLocale(<SacristySheet />, '/mass-intentions/print')
    expect(await screen.findByRole('button', { name: STRINGS.en['sheet.print'] })).toBeInTheDocument()
    expect(auditSurface(sheet.container)).toEqual([])
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument()
    expect(screen.getAllByRole('heading', { level: 2 }).length).toBeGreaterThan(0)
  })
})

describe('Golden Journey 2', () => {
  beforeEach(() => {
    stubGoldenJourney2Fetch(vi)
  })

  it('the sacrament correction form is labeled, described, and the certificate controls are named', async () => {
    withLocale(
      <Routes>
        <Route path="/clients/:id" element={<MemberDetail />} />
      </Routes>,
      `/clients/${GJ2_MEMBER_ID}`,
    )
    const edit = await screen.findByRole('button', { name: /edit baptism record/i })
    fireEvent.click(edit)
    const form = screen.getByRole('button', { name: /^save changes$/i }).closest('form')
    expect(auditSurface(form)).toEqual([])
    expect(screen.getByLabelText(STRINGS.en['register.sacrament']).tagName).toBe('SELECT')
    expect(screen.getByLabelText(STRINGS.en['register.date'])).toHaveAttribute('type', 'date')
    expect(screen.getByLabelText(STRINGS.en['register.minister'])).toBeInTheDocument()
    expect(screen.getByLabelText(STRINGS.en['member.certificateNo'])).toBeInTheDocument()
    const reason = screen.getByLabelText(/reason for this correction/i)
    expect(reason).toHaveAccessibleDescription(/kept with the entry/i)

    const cert = withLocale(
      <Routes>
        <Route path="/register/:id/certificate" element={<SacramentCertificate />} />
      </Routes>,
      `/register/${GJ2_RECORD_ID}/certificate?from=member`,
    )
    expect(await screen.findByRole('button', { name: STRINGS.en['cert.print'] })).toBeInTheDocument()
    expect(auditSurface(cert.container)).toEqual([])
    expect(auditHeadingOrder(cert.container)).toEqual([])
  })
})

describe('OfflineBanner, InstallPrompt, UpdatePrompt', () => {
  it('the offline bar is a polite status, and both prompts are named dialogs', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false })
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { controller: { postMessage: () => {} } },
    })
    const offline = withLocale(<OfflineBanner />)
    const bar = screen.getByRole('status')
    expect(bar).toHaveAttribute('aria-live', 'polite')
    expect(bar).toHaveTextContent(STRINGS.en['offline.banner'])
    expect(auditLive(offline.container)).toEqual([])
    offline.unmount()

    pwaRegisterHarness.needRefresh = true
    const update = withLocale(<UpdatePrompt />)
    const updateDialog = screen.getByRole('dialog', { name: STRINGS.en['update.title'] })
    expect(auditDialogs(update.container)).toEqual([])
    expect(within(updateDialog).getByRole('button', { name: STRINGS.en['update.refresh'] })).toBeInTheDocument()
    expect(within(updateDialog).getByRole('button', { name: STRINGS.en['update.dismiss'] })).toBeInTheDocument()
    expect(auditInteractiveNames(updateDialog)).toEqual([])
    update.unmount()

    const install = withLocale(<InstallPrompt />)
    const ev = new Event('beforeinstallprompt')
    ev.preventDefault = vi.fn()
    ev.prompt = vi.fn()
    await act(async () => { window.dispatchEvent(ev) })
    const installDialog = screen.getByRole('dialog', { name: STRINGS.en['install.title'] })
    expect(auditDialogs(install.container)).toEqual([])
    expect(within(installDialog).getByRole('button', { name: STRINGS.en['install.cta'] })).toBeInTheDocument()
    expect(within(installDialog).getByRole('button', { name: STRINGS.en['install.dismiss'] })).toBeInTheDocument()
  })
})

describe('core navigation', () => {
  function mountSidebar(collapsed) {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ affiliation: null }),
    })))
    return render(
      <MemoryRouter>
        <ThemeProvider>
          <LocaleProvider>
            <ToastProvider>
              <Sidebar collapsed={collapsed} onToggle={() => {}} mobileOpen={false} />
            </ToastProvider>
          </LocaleProvider>
        </ThemeProvider>
      </MemoryRouter>,
    )
  }

  it('expanded and collapsed rails name Dashboard, and every nav link has a name', async () => {
    for (const collapsed of [false, true]) {
      const view = mountSidebar(collapsed)
      const nav = view.container.querySelector('nav')
      expect(nav).toBeTruthy()
      expect(view.container.querySelectorAll('nav')).toHaveLength(1)
      const dash = within(nav).getByRole('link', { name: 'Dashboard' })
      expect(dash).toHaveAttribute('href', '/')
      expect(accessibleName(dash)).toBe('Dashboard')
      expect(within(nav).getByRole('link', { name: 'Members' })).toHaveAttribute('href', '/clients')
      expect(within(nav).getByRole('link', { name: 'Intentions' })).toHaveAttribute('href', '/mass-intentions')
      expect(auditInteractiveNames(nav)).toEqual([])
      expect(auditFocusable(nav)).toEqual([])
      for (const el of view.container.querySelectorAll('aside a, aside button')) {
        expect(accessibleName(el)).not.toBe('')
      }
      const wordmark = view.container.querySelector('aside > a')
      expect(accessibleName(wordmark)).toBe('OpenChurch')
      view.unmount()
    }
  })
})
