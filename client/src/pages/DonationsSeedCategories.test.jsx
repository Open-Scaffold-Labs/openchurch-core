// SP-089 — the sample seed writes 'offertory' / 'special collection'
// (Catholic) and 'pledge' / 'special offering' (other traditions). The
// Donation Log filter must offer those categories so those gifts are
// reachable by filter, not only under "all".

import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { LocaleProvider } from '../i18n'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import Donations from './Donations'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Admin', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 'test-token', loading: false, canWrite: true,
  }),
}))

const TARGET = {
  id: 501, donor_name: 'Tithe Donor', amount: '40.00', category: 'tithe',
  method: 'cash', source: 'manual', date: '2031-06-15',
  payment_ref: null, payment_status: null, refunded_at: null,
}
const OTHER = { ...TARGET, id: 502, donor_name: 'Offertory Donor', category: 'offertory' }
const SPECIAL = { ...TARGET, id: 503, donor_name: 'Special Donor', category: 'special collection' }
const PLEDGE = { ...TARGET, id: 504, donor_name: 'Pledge Donor', category: 'pledge' }
const SPOFF = { ...TARGET, id: 505, donor_name: 'SpOffering Donor', category: 'special offering' }

const ok = (b) => ({ ok: true, status: 200, json: async () => b })

const stubFetch = () => {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    if (u.includes('/api/donations/recurring')) return ok({ recurring: [] })
    if (u.includes('/api/donations/summary')) return ok({ summary: null })
    if (u.includes('/api/donations/by-fund')) return ok({ funds: [] })
    if (u.includes('/api/cash-counts')) return ok({ sessions: [] })
    if (u.includes('/api/donations')) return ok([OTHER, SPECIAL, PLEDGE, SPOFF, TARGET])
    return ok({})
  }))
}

const view = (entry = '/donations') => render(
  <MemoryRouter initialEntries={[entry]}>
    <LocaleProvider><ToastProvider><ConfirmProvider>
      <Donations />
    </ConfirmProvider></ToastProvider></LocaleProvider>
  </MemoryRouter>
)

beforeEach(() => { vi.unstubAllGlobals() })

describe('SP-089 seeded categories are filterable', () => {
  it.each([
    ['offertory', 'Offertory Donor'],
    ['special collection', 'Special Donor'],
    ['pledge', 'Pledge Donor'],
    ['special offering', 'SpOffering Donor'],
  ])('the %s chip shows only its gifts', async (chip, donor) => {
    stubFetch()
    view()
    await screen.findByText('Tithe Donor', {}, { timeout: 4000 })
    fireEvent.click(screen.getByRole('button', { name: chip }))
    // rows leave through an exit animation, so wait for the log to settle
    await waitFor(() => {
      const rows = screen.getAllByRole('row').slice(1)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toHaveTextContent(donor)
    }, { timeout: 4000 })
    expect(screen.getByText('1 records')).toBeTruthy()
  })
})
