// The approved-period refund notice used to render the server's `message`
// only, at the top of the page — and the person who clicked Refund was
// scrolled to the row (738px below at 1440). Now the notice carries the
// amount, is scrolled into view when it appears, and the row itself says
// the adjustment is unresolved.

import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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

const GIFT = {
  id: 501, donor_name: 'Frozen Donor', amount: '400.00', category: 'General',
  method: 'online', source: 'online', date: '2031-06-15',
  payment_ref: 'pi_test_501', payment_status: 'succeeded', refunded_at: null,
}
const OTHER = { ...GIFT, id: 502, donor_name: 'Other Donor', amount: '25.00', method: 'cash', source: 'manual' }

const ok = (b) => ({ ok: true, status: 200, json: async () => b })

// After the refund the page reloads the list; the gift comes back refunded.
const stubFetch = (refundBody) => {
  let refunded = false
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url)
    if (u.includes('/api/donations/501/refund')) { refunded = true; return ok(refundBody) }
    if (u.includes('/api/donations/recurring')) return ok({ recurring: [] })
    if (u.includes('/api/donations/summary')) return ok({ summary: null })
    if (u.includes('/api/donations/by-fund')) return ok({ funds: [] })
    if (u.includes('/api/cash-counts')) return ok({ sessions: [] })
    if (u.includes('/api/donations')) return ok([refunded ? { ...GIFT, refunded_at: '2026-09-04T00:00:00Z' } : GIFT, OTHER])
    return ok({})
  }))
}

const view = () => render(
  <MemoryRouter><LocaleProvider><ToastProvider><ConfirmProvider>
    <Donations />
  </ConfirmProvider></ToastProvider></LocaleProvider></MemoryRouter>
)

async function clickRefund() {
  const btn = await screen.findByLabelText('Refund this gift', {}, { timeout: 4000 })
  fireEvent.click(btn)
  const confirm = await screen.findByRole('button', { name: /refund gift/i }, { timeout: 4000 })
  fireEvent.click(confirm)
}

const ADJ = {
  submission_id: 9, amount: '1000.00',
  message: 'This gift is inside a period the diocese has already approved. ' +
           'The approved totals and any bill from them still include it.',
}

let scrollSpy
beforeEach(() => {
  vi.unstubAllGlobals()
  // jsdom has no layout and no scrollIntoView; the page must call it anyway.
  scrollSpy = vi.fn()
  Element.prototype.scrollIntoView = scrollSpy
})
afterEach(() => { delete Element.prototype.scrollIntoView })

describe('refund notice for an approved period carries the amount and reaches the row', () => {
  it('renders the amount in the notice and scrolls the notice into view', async () => {
    stubFetch({ ...GIFT, refunded_at: '2026-09-04T00:00:00Z', period_adjustment: ADJ })
    view()
    await clickRefund()
    const heading = await screen.findByText(/inside an approved reporting period/i, {}, { timeout: 4000 })
    const notice = heading.closest('[role="status"]')
    expect(notice).toHaveTextContent('$1,000.00')
    expect(notice).toHaveTextContent(/unresolved adjustment/i)
    await waitFor(() => expect(scrollSpy).toHaveBeenCalled())
  })

  it('marks the refunded row itself as unresolved, with the amount', async () => {
    stubFetch({ ...GIFT, refunded_at: '2026-09-04T00:00:00Z', period_adjustment: ADJ })
    view()
    await clickRefund()
    const marker = await screen.findByTestId('refund-adjustment-501', {}, { timeout: 4000 })
    expect(marker).toHaveTextContent(/unresolved adjustment/i)
    expect(marker).toHaveTextContent('$1,000.00')
    // It sits in Frozen Donor's row, not Other Donor's.
    const row = marker.closest('tr')
    expect(within(row).getByText('Frozen Donor')).toBeInTheDocument()
    expect(screen.queryByTestId('refund-adjustment-502')).toBeNull()
  })

  it('CONTROL: an ordinary refund marks no row and scrolls nothing', async () => {
    stubFetch({ ...GIFT, refunded_at: '2026-09-04T00:00:00Z' })
    view()
    await clickRefund()
    await screen.findByText('Refunded', {}, { timeout: 4000 })
    expect(screen.queryByTestId('refund-adjustment-501')).toBeNull()
    expect(screen.queryByText(/unresolved adjustment/i)).toBeNull()
    expect(scrollSpy).not.toHaveBeenCalled()
  })
})
