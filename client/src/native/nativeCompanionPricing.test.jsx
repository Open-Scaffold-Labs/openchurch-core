// C2 (Dale, #342 comment 6429592110): the iPhone and iPad app is a free
// companion app under Guideline 3.1.3(b). Inside the Capacitor shell no
// SaaS price, plan comparison, upgrade prompt, checkout or portal link,
// or "pricing will be announced" note may render. The web is unchanged.
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { ThemeProvider } from '../context/ThemeContext'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import { visibleNavFor } from '../App'
import HelpPanel from '../components/HelpPanel'
import Billing from '../pages/Billing'
import { NativeAiState } from './NativeAiContext'
import { betaPricingNote } from '../config/pricing'
import {
  PRICING_FAQ_QUESTION,
  helpFaqOfferedInShell,
  helpModuleOfferedInShell,
  helpSearchRowOfferedInShell,
  isPricingPath,
  navItemOfferedInShell,
  pricingShownInShell,
  shellAccountTitle,
  shellPlanNote,
} from './planPurchase'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Ada Admin', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en', timezone: 'UTC' } },
    updateUser: vi.fn(),
    token: 't',
    loading: false,
    isAuthenticated: true,
    canWrite: true,
  }),
}))

const PRICED = {
  planDetails: { id: 'pro', name: 'Parish', description: 'Everything a parish office needs, one flat price.', price: 79, features: ['Unlimited members'] },
  availablePlans: [
    { id: 'free', name: 'Free', description: 'For small congregations getting started.', price: 0, features: ['Up to 50 members'] },
    { id: 'pro', name: 'Parish', description: 'Everything a parish office needs, one flat price.', price: 79, features: ['Unlimited members'] },
  ],
  current_period_end: '2026-11-26T00:00:00Z',
  billing_status: 'active',
}

function shell(ui) {
  return render(
    <MemoryRouter>
      <ThemeProvider>
        <LocaleProvider>
          <ToastProvider>
            <ConfirmProvider>{ui}</ConfirmProvider>
          </ToastProvider>
        </LocaleProvider>
      </ThemeProvider>
    </MemoryRouter>,
  )
}

let fetchMock
beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
  delete window.Capacitor
  vi.stubGlobal('matchMedia', (query) => ({
    matches: false, media: query,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  }))
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => PRICED }))
  vi.stubGlobal('fetch', fetchMock)
})

describe('C2 pricing helpers', () => {
  it('answers the web exactly as before and hides pricing surfaces only when native is true', () => {
    for (const web of [false, undefined, null, 'true']) {
      expect(pricingShownInShell(web)).toBe(true)
      expect(navItemOfferedInShell({ to: '/billing' }, web)).toBe(true)
      expect(helpModuleOfferedInShell('billing', web)).toBe(true)
      expect(helpFaqOfferedInShell(PRICING_FAQ_QUESTION, web)).toBe(true)
      expect(helpSearchRowOfferedInShell({ kind: 'module', id: 'billing' }, web)).toBe(true)
    }
    expect(pricingShownInShell(true)).toBe(false)
    expect(navItemOfferedInShell({ to: '/billing' }, true)).toBe(false)
    expect(navItemOfferedInShell({ to: '/Billing/' }, true)).toBe(false)
    expect(navItemOfferedInShell({ to: '/donations' }, true)).toBe(true)
    expect(helpModuleOfferedInShell('billing', true)).toBe(false)
    expect(helpModuleOfferedInShell('donations', true)).toBe(true)
    expect(helpFaqOfferedInShell(PRICING_FAQ_QUESTION, true)).toBe(false)
    expect(helpSearchRowOfferedInShell({ kind: 'section', id: 'billing', title: 'Billing — x' }, true)).toBe(false)
    expect(helpSearchRowOfferedInShell({ kind: 'faq', id: 'faq-9', title: PRICING_FAQ_QUESTION }, true)).toBe(false)
    expect(helpSearchRowOfferedInShell({ kind: 'module', id: 'donations' }, true)).toBe(true)
    expect(isPricingPath('/billing')).toBe(true)
    expect(isPricingPath('/billing-x')).toBe(false)
  })

  it('the shell note names no price, plan change, upgrade, web office or checkout, in English and Spanish', () => {
    for (const loc of ['en', 'es']) {
      const note = shellPlanNote(loc)
      expect(note).not.toMatch(/\$|\d|price|precio|upgrade|plan|checkout|web|portal|announced|anunciar/i)
    }
    expect(shellPlanNote('en')).toMatch(/is free/)
    expect(shellPlanNote('es')).toMatch(/es gratuita/)
    expect(shellAccountTitle('es')).toBe('Cuenta de la parroquia')
  })
})

describe('C2 sidebar', () => {
  it('lists Billing on the web and not in any native kind', () => {
    expect(visibleNavFor('admin', false, 'web').some(i => i.to === '/billing')).toBe(true)
    for (const kind of ['pending', 'unavailable', 'excluded', 'disclosure-stale', 'consent', 'open']) {
      expect(visibleNavFor('admin', false, kind).some(i => i.to === '/billing')).toBe(false)
    }
  })

  it('hides Billing when the bridge says native even if the AI kind still reads web', () => {
    window.Capacitor = { isNativePlatform: () => true }
    expect(visibleNavFor('admin', false, 'web').some(i => i.to === '/billing')).toBe(false)
  })
})

describe('C2 Billing page', () => {
  it('in the shell (open beta default) renders only the free companion note and never reads billing', async () => {
    window.Capacitor = { isNativePlatform: () => true }
    shell(<Billing />)
    expect(await screen.findByRole('heading', { name: shellAccountTitle('en') })).toBeInTheDocument()
    expect(screen.getByText(shellPlanNote('en'))).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
    const text = document.body.textContent
    expect(text).not.toMatch(/\$|79|\/mo|upgrade|checkout|Manage billing|flat price|Renews/i)
    expect(screen.queryByText(betaPricingNote('en'))).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('in the shell, Spanish copy, and ?success / ?stub_checkout params add nothing', async () => {
    window.Capacitor = { isNativePlatform: () => true }
    localStorage.setItem('ochr_locale', 'es')
    render(
      <MemoryRouter initialEntries={['/billing?success=1&stub_checkout=1']}>
        <LocaleProvider><ToastProvider><ConfirmProvider><Billing /></ConfirmProvider></ToastProvider></LocaleProvider>
      </MemoryRouter>,
    )
    expect(await screen.findByRole('heading', { name: 'Cuenta de la parroquia' })).toBeInTheDocument()
    expect(screen.getByText(shellPlanNote('es'))).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/\$|precio|Cambiar a|stub|beta/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('the user-agent signal alone is enough', async () => {
    const ua = vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 OpenChurchNative/1.0')
    shell(<Billing />)
    expect(await screen.findByText(shellPlanNote('en'))).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
    ua.mockRestore()
  })

  it('on the web the page still reads billing and shows the open beta note (unchanged)', async () => {
    shell(<Billing />)
    expect(await screen.findByTestId('beta-pricing-note')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalled()
    expect(screen.queryByText(shellPlanNote('en'))).toBeNull()
  })
})

describe('C2 help panel', () => {
  it('drops the Billing guide and the cost question in the shell and keeps them on the web', () => {
    const { unmount } = shell(<NativeAiState kind="open"><HelpPanel open onClose={() => {}} /></NativeAiState>)
    expect(screen.queryByRole('button', { name: 'Billing' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: STRINGS.en['help.tabFaq'] }))
    expect(screen.queryByText(PRICING_FAQ_QUESTION)).toBeNull()
    unmount()

    shell(<NativeAiState kind="web"><HelpPanel open onClose={() => {}} /></NativeAiState>)
    expect(screen.getByRole('button', { name: 'Billing' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: STRINGS.en['help.tabFaq'] }))
    expect(screen.getByText(PRICING_FAQ_QUESTION)).toBeInTheDocument()
  })

  it('search for "pricing" finds the cost row on the web and nothing priced in the shell', () => {
    const { unmount } = shell(<NativeAiState kind="web"><HelpPanel open onClose={() => {}} /></NativeAiState>)
    fireEvent.change(screen.getByPlaceholderText(STRINGS.en['help.searchPh']), { target: { value: 'pricing' } })
    expect(screen.getByText(PRICING_FAQ_QUESTION)).toBeInTheDocument()
    unmount()

    shell(<NativeAiState kind="open"><HelpPanel open onClose={() => {}} /></NativeAiState>)
    fireEvent.change(screen.getByPlaceholderText(STRINGS.en['help.searchPh']), { target: { value: 'pricing' } })
    expect(screen.queryByText(PRICING_FAQ_QUESTION)).toBeNull()
    expect(document.body.textContent).not.toMatch(/Pricing will be announced/)
  })
})
