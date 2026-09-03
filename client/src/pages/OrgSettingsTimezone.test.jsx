// The kiosk's "today" is the parish's day, and nothing let a parish say
// which day that was. (C4)
//
// ochr_organizations.timezone defaulted to 'UTC', signup never set it, PATCH
// /api/organization has accepted it since CHK.7 — and no screen wrote it. The
// help text pointed at "Org details → timezone", which did not exist. So an
// evening Mass in California checked people in against tomorrow's date.

import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import OrgSettings from './OrgSettings'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Rector', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    updateUser: () => {},
    token: 't', loading: false,
  }),
}))

const ORG = {
  id: 1, name: 'St Test', slug: 'st-test', address: '', tax_id: '',
  signatory_name: '', signatory_title: '', statement_letterhead: '',
  tagline: '', about: '', service_times: '', page_published: false,
  reminder_lead_hours: 24, timezone: 'America/Los_Angeles', locale: 'en',
}

const ok = (b) => ({ ok: true, status: 200, json: async () => b })

const calls = []
const routes = () => {
  calls.length = 0
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url); const method = opts.method || 'GET'
    calls.push({ url: u, method, body: opts.body ? JSON.parse(opts.body) : null })
    if (u.endsWith('/api/organization') && method === 'GET')   return ok(ORG)
    if (u.endsWith('/api/organization') && method === 'PATCH') return ok({ ...ORG, ...JSON.parse(opts.body) })
    if (u.includes('/api/affiliation'))   return ok({ affiliation: null })
    if (u.includes('/api/ai/provider'))   return ok({ source: 'platform' })
    if (u.includes('/api/parish-feasts')) return ok({ feasts: [] })
    return ok({})
  }))
}

const mount = () => render(
  <MemoryRouter><LocaleProvider><ToastProvider><ConfirmProvider>
    <OrgSettings />
  </ConfirmProvider></ToastProvider></LocaleProvider></MemoryRouter>
)

beforeEach(() => vi.unstubAllGlobals())

describe('the parish timezone', () => {
  it('is offered on Org details, showing the zone the org has', async () => {
    routes(); mount()
    const select = await screen.findByLabelText(/time ?zone/i)
    expect(select.tagName).toBe('SELECT')
    expect(select).toHaveValue('America/Los_Angeles')
    // The help text names what the setting is for, in the parish's terms.
    expect(screen.getByText(/check-in kiosk/i)).toBeInTheDocument()
  })

  it('changing it sends `timezone` in the PATCH', async () => {
    routes(); mount()
    const select = await screen.findByLabelText(/time ?zone/i)
    fireEvent.change(select, { target: { value: 'America/Chicago' } })
    expect(select).toHaveValue('America/Chicago')

    await act(async () => { fireEvent.submit(select.closest('form')) })

    await waitFor(() => {
      const patch = calls.find(c => c.method === 'PATCH' && c.url.endsWith('/api/organization'))
      expect(patch).toBeTruthy()
      expect(patch.body.timezone).toBe('America/Chicago')
    })
  })

  it('offers real IANA zones, not a hand-typed few', async () => {
    routes(); mount()
    const select = await screen.findByLabelText(/time ?zone/i)
    const values = Array.from(select.querySelectorAll('option')).map(o => o.value)
    expect(values).toContain('UTC')
    expect(values).toContain('America/New_York')
    expect(values).toContain('Europe/Madrid')
    expect(values.length).toBeGreaterThan(100)
  })
})
