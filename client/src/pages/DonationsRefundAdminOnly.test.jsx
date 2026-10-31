// #365: void and refund (including the provider refund route) are admin-only.
// Staff see no Void/Refund controls and an honest note saying so.

import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { LocaleProvider } from '../i18n'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import Donations, { canMarkGift } from './Donations'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Sam Staff', role: 'staff', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 'test-token', loading: false, canWrite: true,
  }),
}))

const books = (over) => ({
  marker: 'none',
  refunded_total: '0.00',
  live_amount: '100.00',
  void_reason: null,
  voided_by_name: null,
  voided_at: null,
  from_cash_count: false,
  statement_drift: false,
  ...over,
})

const VOIDED = {
  id: 1, donor_name: 'Ada Donor', amount: '100.00', category: 'tithe',
  method: 'cash', source: 'manual', date: '2026-10-22', refunded_at: null,
  books: books({
    marker: 'voided', refunded_total: '100.00', live_amount: '0.00',
    void_reason: 'Wrong envelope', voided_by_name: 'Ada Admin',
    voided_at: '2026-10-22T15:00:00.000Z',
  }),
}
const PARTIAL = {
  id: 2, donor_name: 'Ben Donor', amount: '100.00', category: 'tithe',
  method: 'check', source: 'manual', date: '2026-10-22', refunded_at: null,
  books: books({ marker: 'partial', refunded_total: '30.00', live_amount: '70.00' }),
}
const REFUNDED = {
  id: 3, donor_name: 'Cara Donor', amount: '40.00', category: 'tithe',
  method: 'online', source: 'online', date: '2026-10-22', refunded_at: null,
  payment_ref: 'pi_marker', payment_status: 'succeeded',
  books: books({
    marker: 'refunded', refunded_total: '40.00', live_amount: '0.00', statement_drift: true,
  }),
}

const LIVE = {
  id: 4, donor_name: 'Dee Donor', amount: '25.00', category: 'tithe',
  method: 'cash', source: 'manual', date: '2026-10-22', refunded_at: null, books: books({ live_amount: '25.00' }),
}

const ok = (b) => ({ ok: true, status: 200, json: async () => b })

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    if (u.includes('void-requests')) return ok([])
    if (u.includes('cash-counts')) return ok([])
    if (u.includes('/api/donations/recurring')) return ok({ recurring: [], needs_attention: [] })
    if (u.includes('/api/donations/summary')) return ok({ month_total: '70.00', week_total: '70.00', largest: '70.00', donor_count: 1 })
    if (u.includes('/api/donations/by-fund')) return ok({ funds: [{ category: 'tithe', total: '70.00', count: 1 }] })
    if (u.includes('/api/donations')) return ok([LIVE])
    return ok({})
  }))
})

const view = () => render(
  <MemoryRouter><LocaleProvider><ToastProvider><ConfirmProvider>
    <Donations />
  </ConfirmProvider></ToastProvider></LocaleProvider></MemoryRouter>
)

describe('donation log for staff', () => {
  it('hides Void and Refund and says only an admin can do it', async () => {
    view()
    await screen.findByText('Dee Donor')
    expect(screen.queryByLabelText('Refund this gift')).toBeNull()
    expect(screen.queryByLabelText('Void this gift')).toBeNull()
    expect(screen.getByTestId('donations-admin-only-note')).toHaveTextContent('Only a parish admin can void or refund a gift.')
    expect(canMarkGift({ role: 'staff' }, LIVE)).toBe(false)
  })
})
