// SP-037 — Staff opening /finance by URL must not see the money UI.
// Server requireRole('admin') is the ACL; this is the client route/page gate.

import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import Finance from './Finance'
import FinanceCutover from './FinanceCutover'
import { financeRouteNeedsAdmin } from '../App'

const en = STRINGS.en
const es = STRINGS.es

let role = 'staff'
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 2, name: 'Staff', role, organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 't', loading: false, canWrite: role !== 'viewer', isAdmin: role === 'admin',
  }),
}))

function mountFinance(locale) {
  if (locale) localStorage.setItem('ochr_locale', locale)
  return render(
    <MemoryRouter>
      <LocaleProvider>
        <ToastProvider>
          <ConfirmProvider>
            <Finance />
          </ConfirmProvider>
        </ToastProvider>
      </LocaleProvider>
    </MemoryRouter>,
  )
}

function mountCutover(locale) {
  if (locale) localStorage.setItem('ochr_locale', locale)
  return render(
    <MemoryRouter>
      <LocaleProvider>
        <ToastProvider>
          <FinanceCutover />
        </ToastProvider>
      </LocaleProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  role = 'staff'
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ error: 'Forbidden' }) })))
  localStorage.removeItem('ochr_locale')
})
afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.removeItem('ochr_locale')
})

describe('SP-037 finance client admin gate', () => {
  it('financeRouteNeedsAdmin covers /finance and cutover', () => {
    expect(financeRouteNeedsAdmin('/finance')).toBe(true)
    expect(financeRouteNeedsAdmin('/finance/cutover')).toBe(true)
    expect(financeRouteNeedsAdmin('/donations')).toBe(false)
    expect(financeRouteNeedsAdmin('/')).toBe(false)
  })

  it.each(['en', 'es'])('Staff on Finance sees %s admins-only, not the ledger title', async (locale) => {
    role = 'staff'
    mountFinance(locale)
    expect(await screen.findByText(STRINGS[locale]['fin.adminOnly'])).toBeInTheDocument()
    expect(screen.getByText(STRINGS[locale]['fin.adminOnlyBody'])).toBeInTheDocument()
    expect(screen.queryByText(en['fin.title'])).toBeNull()
    if (locale === 'es') {
      expect(screen.queryByText(en['fin.adminOnly'])).toBeNull()
    }
  })

  it.each(['en', 'es'])('Staff on Cutover sees %s admins-only', async (locale) => {
    role = 'staff'
    mountCutover(locale)
    expect(await screen.findByText(STRINGS[locale]['fin.adminOnly'])).toBeInTheDocument()
  })

  it('Admin still reaches the Finance ledger heading', async () => {
    role = 'admin'
    // Minimal stubs so admin path can settle without crashing.
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      if (u.includes('/api/finance/summary')) {
        return { ok: true, status: 200, json: async () => ({ totals: { revenue: 0, expense: 0, net: 0, assessable_base: 0 }, by_group: [] }) }
      }
      if (u.includes('/api/finance/ledger')) {
        return { ok: true, status: 200, json: async () => ({ entries: [] }) }
      }
      if (u.includes('/api/finance/coa')) {
        return { ok: true, status: 200, json: async () => ({ accounts: [] }) }
      }
      if (u.includes('/api/finance/mappings')) {
        return { ok: true, status: 200, json: async () => ({ mappings: [], donation_categories: [], funds: [] }) }
      }
      if (u.includes('/api/affiliation') || u.includes('/api/finance/diocese') || u.includes('/api/finance/submissions')) {
        return { ok: true, status: 200, json: async () => ({ affiliation: null, submissions: [] }) }
      }
      return { ok: true, status: 200, json: async () => ({}) }
    }))
    mountFinance('en')
    expect(await screen.findByText(en['fin.title'])).toBeInTheDocument()
    expect(screen.queryByText(en['fin.adminOnly'])).toBeNull()
  })
})
