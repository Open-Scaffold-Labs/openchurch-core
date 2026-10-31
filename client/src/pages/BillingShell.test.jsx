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
import { shellAccountTitle, shellPlanNote } from '../native/planPurchase'

// These cases cover the priced Billing page, so they turn the open beta
// pricing switch back on. BillingBetaPricing.test.jsx covers the default.
vi.mock('../config/pricing', async (orig) => ({ ...(await orig()), PRICING_VISIBLE: true }))

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: {
      id: 1,
      name: 'Secretary',
      role: 'admin',
      organization: { id: 1, name: 'St Test', slug: 'st-test', locale: 'en' },
    },
    token: 'test-token',
    loading: false,
  }),
}))

const PLAN = {
  planDetails: { id: 'free', name: 'Parish', description: 'The free plan', price: 0, features: ['Members'] },
  availablePlans: [
    { id: 'free', name: 'Parish', description: 'The free plan', price: 0, features: ['Members'] },
    { id: 'pro', name: 'Pro', description: 'More room', price: 20, features: ['Register'] },
  ],
  billing_status: 'active',
}

function mount() {
  return render(
    <MemoryRouter>
      <LocaleProvider>
        <ToastProvider>
          <ConfirmProvider>
            <Billing />
          </ConfirmProvider>
        </ToastProvider>
      </LocaleProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  localStorage.removeItem('ochr_locale')
  delete window.Capacitor
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => PLAN,
  })))
})

describe('billing inside the iOS shell', () => {
  it('on the web, an upgrade is still offered', async () => {
    mount()
    expect(await screen.findByRole('button', { name: /upgrade to pro/i })).toBeInTheDocument()
    expect(screen.queryByText(shellPlanNote('en'))).toBeNull()
  })

  it('in the shell, no plan price, upgrade or portal is offered even with pricing on', async () => {
    window.Capacitor = { isNativePlatform: () => true }
    localStorage.setItem('ochr_locale', 'es')
    mount()
    expect(await screen.findByRole('heading', { name: shellAccountTitle('es') })).toBeInTheDocument()
    expect(screen.getByText(shellPlanNote('es'))).toBeInTheDocument()
    // C2: even with pricing switched on, the shell shows no price at all.
    expect(document.body.textContent).not.toMatch(/\$|\/mo|Pro\b/)
    expect(fetch).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /upgrade/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /manage billing/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /downgrade/i })).toBeNull()
    expect(screen.queryByText(/Upgrades work locally/)).toBeNull()
  })
})
