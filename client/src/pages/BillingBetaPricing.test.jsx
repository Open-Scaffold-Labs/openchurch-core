import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { LocaleProvider } from '../i18n'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import Billing from './Billing'
import { PRICING_VISIBLE, betaPricingNote, betaBillingSubtitle } from '../config/pricing'
import { MODULE_HELP, FAQ } from '../data/helpContent'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin',
      organization: { id: 1, name: 'St Test', slug: 'st-test', locale: 'en' } },
    token: 'test-token', loading: false,
  }),
}))

const PLAN = {
  planDetails: { id: 'pro', name: 'Parish', description: 'Everything a parish office needs, one flat price.', price: 79, features: ['Unlimited members'] },
  availablePlans: [
    { id: 'free', name: 'Free', description: 'For small congregations getting started.', price: 0, features: ['Up to 50 members'] },
    { id: 'pro', name: 'Parish', description: 'Everything a parish office needs, one flat price.', price: 79, features: ['Unlimited members'] },
  ],
  billing_status: 'active',
}

function mount(path = '/billing') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <LocaleProvider><ToastProvider><ConfirmProvider><Billing /></ConfirmProvider></ToastProvider></LocaleProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  localStorage.removeItem('ochr_locale')
  delete window.Capacitor
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => PLAN })))
})

describe('open beta: pricing hidden', () => {
  it('Billing subtitle is beta copy, not the stale subscription line (SP-186 S4)', async () => {
    mount()
    await screen.findByTestId('beta-pricing-note')
    expect(document.body.textContent).not.toMatch(/Manage your subscription, payment method, and invoices/)
    expect(screen.getByText(betaBillingSubtitle('en'))).toBeInTheDocument()
  })

  it('Billing subtitle is beta copy in Spanish', async () => {
    localStorage.setItem('ochr_locale', 'es')
    mount()
    await screen.findByTestId('beta-pricing-note')
    expect(document.body.textContent).not.toMatch(/Administre su suscripción/)
    expect(screen.getByText(betaBillingSubtitle('es'))).toBeInTheDocument()
  })

  it('Billing renders with an empty availablePlans (beta server) and no $undefined', async () => {
    fetch.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ ...PLAN, availablePlans: [], planDetails: { id: 'free', name: 'Free', description: 'x', features: [] } }) }))
    mount()
    await screen.findByTestId('beta-pricing-note')
    expect(document.body.textContent).not.toMatch(/\$undefined|undefined/)
  })

  it('defaults to hidden', () => {
    expect(PRICING_VISIBLE).toBe(false)
  })

  it('Billing shows the beta note and no price, tier list, upgrade or portal', async () => {
    mount()
    expect(await screen.findByTestId('beta-pricing-note')).toHaveTextContent(betaPricingNote('en'))
    expect(document.body.textContent).not.toMatch(/\$\s?\d/)
    expect(document.body.textContent).not.toMatch(/\/mo\b/)
    expect(screen.queryByText(/Available plans/)).toBeNull()
    expect(screen.queryByRole('button', { name: /upgrade/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /manage billing/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /downgrade/i })).toBeNull()
    expect(screen.queryByText(/Upgrades work locally/)).toBeNull()
  })

  it('a checkout return does not say "Welcome to Pro"', async () => {
    mount('/billing?success=1')
    await screen.findByTestId('beta-pricing-note')
    expect(screen.queryByText(/Welcome to Pro/)).toBeNull()
  })

  it('Spanish beta note renders for a Spanish user', async () => {
    localStorage.setItem('ochr_locale', 'es')
    mount()
    expect(await screen.findByTestId('beta-pricing-note')).toHaveTextContent(betaPricingNote('es'))
  })

  it('Help content quotes no price and carries the beta copy', () => {
    const text = JSON.stringify({ MODULE_HELP, FAQ })
    expect(text).not.toMatch(/\$\d/)
    expect(text).toContain('free during the open beta')
  })

  it('Assistant prompt quotes no price', () => {
    const dir = dirname(fileURLToPath(import.meta.url))
    const src = readFileSync(join(dir, '../../../server/src/routes/assistant.js'), 'utf8')
    const prompt = src.slice(src.indexOf('const SYSTEM_PROMPT'), src.indexOf('async function todayCount'))
    expect(prompt.length).toBeGreaterThan(500)
    expect(prompt).not.toMatch(/\$\s?\d|\/mo\b|per month/i)
    expect(prompt).not.toMatch(/pricing will be announced/i)
    expect(prompt).toMatch(/never quote a price/)
  })
})
