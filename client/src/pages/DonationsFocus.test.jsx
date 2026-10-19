// ⌘K / global search opens /donations?id= so the gift that was found
// stays identifiable — pinned to the top of the log and marked current.
// Without the query the log is unchanged (no invented focus).

import { render, screen } from '@testing-library/react'
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
  id: 501, donor_name: 'Focused Donor', amount: '40.00', category: 'tithe',
  method: 'cash', source: 'manual', date: '2031-06-15',
  payment_ref: null, payment_status: null, refunded_at: null,
}
const OTHER = {
  ...TARGET, id: 502, donor_name: 'Other Donor', amount: '25.00', date: '2031-06-16',
}

const ok = (b) => ({ ok: true, status: 200, json: async () => b })

const stubFetch = () => {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    if (u.includes('/api/donations/recurring')) return ok({ recurring: [] })
    if (u.includes('/api/donations/summary')) return ok({ summary: null })
    if (u.includes('/api/donations/by-fund')) return ok({ funds: [] })
    if (u.includes('/api/cash-counts')) return ok({ sessions: [] })
    if (u.includes('/api/donations')) return ok([OTHER, TARGET])
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

describe('opening the log with a focused gift', () => {
  it('?id= marks that gift current and pins it to the top', async () => {
    stubFetch()
    view('/donations?id=501')
    const focused = await screen.findByTestId('focused-gift', {}, { timeout: 4000 })
    expect(focused).toHaveTextContent('Focused Donor')
    expect(focused).toHaveAttribute('aria-current', 'true')
    expect(screen.queryByTestId('focused-gift')).toBe(focused)
    const rows = screen.getAllByRole('row')
    // header + two gifts; the focused gift is the first data row
    expect(rows[1]).toHaveTextContent('Focused Donor')
    expect(rows[2]).toHaveTextContent('Other Donor')
  })

  it('CONTROL: the plain log does not invent a focused gift', async () => {
    stubFetch()
    view('/donations')
    expect(await screen.findByText('Other Donor', {}, { timeout: 4000 })).toBeTruthy()
    expect(screen.getByText('Focused Donor')).toBeTruthy()
    expect(screen.queryByTestId('focused-gift')).toBeNull()
    const rows = screen.getAllByRole('row')
    expect(rows[1]).toHaveTextContent('Other Donor')
  })
})
