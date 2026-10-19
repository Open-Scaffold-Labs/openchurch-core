// A refund that lands inside an APPROVED reporting period must not be
// announced as if the diocesan figures moved with it.
//
// Live giving totals exclude refunded gifts. A submission's frozen
// totals_json does not, and the diocesan bill is derived from that JSON. So
// "Gift refunded" — alone, in a toast that is gone in four seconds — lets a
// parish believe an approved period and its bill dropped the gift too. They
// did not, and the server says so in `period_adjustment`.
//
// The control comes first: an ordinary refund must still get the plain
// sentence and NO notice, or the positive case proves nothing.

import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
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

const GIFT = {
  id: 501, donor_name: 'Frozen Donor', amount: '400.00', category: 'General',
  method: 'online', source: 'online', date: '2031-06-15',
  payment_ref: 'pi_test_501', payment_status: 'succeeded', refunded_at: null,
}

const ok = (b) => ({ ok: true, status: 200, json: async () => b })

const stubFetch = (refundBody) => {
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url)
    if (u.includes('/api/donations/501/refund')) return ok(refundBody)
    if (u.includes('/api/donations/recurring')) return ok({ recurring: [] })
    if (u.includes('/api/donations/summary')) return ok({ summary: null })
    if (u.includes('/api/donations/by-fund')) return ok({ funds: [] })
    if (u.includes('/api/cash-counts')) return ok({ sessions: [] })
    if (u.includes('/api/donations')) return ok([GIFT])
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

beforeEach(() => { vi.unstubAllGlobals() })

describe('refunding a gift that sits in an approved period', () => {
  it('CONTROL: an ordinary refund shows no approved-period notice', async () => {
    stubFetch({ ...GIFT, refunded_at: '2026-09-04T00:00:00Z' })
    view()
    await clickRefund()
    await waitFor(() => expect(screen.queryByText(/inside an approved reporting period/i)).toBeNull())
  })

  it('says the approved totals and any bill still include the gift', async () => {
    stubFetch({
      ...GIFT,
      refunded_at: '2026-09-04T00:00:00Z',
      period_adjustment: {
        submission_id: 9, amount: '400.00',
        message: 'This gift is inside a period the diocese has already approved. ' +
                 'The approved totals and any bill from them still include it — they are not changed by this refund. ' +
                 'The adjustment has been recorded against that period for the chancery to settle.',
      },
    })
    view()
    await clickRefund()

    const notice = await screen.findByText(/inside an approved reporting period/i, {}, { timeout: 4000 })
    expect(notice).toBeTruthy()
    // The consequence, not just the fact.
    expect(await screen.findByText(/still include it/i)).toBeTruthy()
    // It must never claim the frozen figures changed.
    expect(screen.queryByText(/totals have been updated|removed from the approved/i)).toBeNull()
  })

  it('the notice stays until it is dismissed, unlike a toast', async () => {
    stubFetch({
      ...GIFT,
      refunded_at: '2026-09-04T00:00:00Z',
      period_adjustment: { submission_id: 9, amount: '400.00', message: 'Approved totals still include it.' },
    })
    view()
    await clickRefund()
    const heading = await screen.findByText(/inside an approved reporting period/i, {}, { timeout: 4000 })
    // Scope to the notice itself: the toast that accompanies it carries its
    // own dismiss control, and a bare getByRole would not say which was meant.
    const notice = heading.closest('[role="status"]')
    fireEvent.click(within(notice).getByRole('button', { name: /dismiss/i }))
    await waitFor(() => expect(screen.queryByText(/inside an approved reporting period/i)).toBeNull())
  })
})
