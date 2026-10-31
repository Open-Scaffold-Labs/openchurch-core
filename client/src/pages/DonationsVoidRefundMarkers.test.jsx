// Donation Log markers. The original amount stays on the row. Totals use
// what remains: a void contributes nothing, a partial contributes the net.

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { LocaleProvider } from '../i18n'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import Donations, { buildTrendFromDonations, canMarkGift, giftLiveAmount } from './Donations'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Admin', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
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

const ok = (b) => ({ ok: true, status: 200, json: async () => b })

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    if (u.includes('void-requests')) return ok([])
    if (u.includes('cash-counts')) return ok([])
    if (u.includes('/api/donations/recurring')) return ok({ recurring: [], needs_attention: [] })
    if (u.includes('/api/donations/summary')) return ok({ month_total: '70.00', week_total: '70.00', largest: '70.00', donor_count: 1 })
    if (u.includes('/api/donations/by-fund')) return ok({ funds: [{ category: 'tithe', total: '70.00', count: 1 }] })
    if (u.includes('/api/donations')) return ok([VOIDED, PARTIAL, REFUNDED])
    return ok({})
  }))
})

const view = () => render(
  <MemoryRouter><LocaleProvider><ToastProvider><ConfirmProvider>
    <Donations />
  </ConfirmProvider></ToastProvider></LocaleProvider></MemoryRouter>
)

describe('donation log markers', () => {
  it('keeps the original amount and names void, partial, and refund', async () => {
    view()
    const ada = (await screen.findByText('Ada Donor')).closest('tr')
    expect(ada).toHaveTextContent('$100.00')
    expect(ada).toHaveTextContent('Voided')
    expect(ada).toHaveTextContent('Wrong envelope')
    expect(ada).toHaveTextContent('Ada Admin')

    const ben = screen.getByText('Ben Donor').closest('tr')
    expect(ben).toHaveTextContent('$100.00')
    expect(ben).toHaveTextContent('Partially refunded')
    expect(ben).toHaveTextContent('$30.00')
    expect(ben).toHaveTextContent('Still $70.00 in the totals')

    const cara = screen.getByText('Cara Donor').closest('tr')
    expect(cara).toHaveTextContent('$40.00')
    expect(cara).toHaveTextContent('Refunded')
    expect(cara).toHaveTextContent(/payment provider/i)
    expect(cara).toHaveTextContent(/issued giving statement/i)
    expect(screen.getByTestId('statement-flag-3')).toBeTruthy()
  })

  it('the month total is the net, while the voided gift stays on the log', async () => {
    view()
    const month = (await screen.findByText('This Month')).parentElement
    expect(month).toHaveTextContent('$70')
    const ada = screen.getByText('Ada Donor').closest('tr')
    expect(ada.querySelector('[aria-label="Void this gift"]')).toBeNull()
    const ben = screen.getByText('Ben Donor').closest('tr')
    expect(ben.querySelector('[aria-label="Refund this gift"]')).toBeTruthy()
    expect(ben.querySelector('[aria-label="Void this gift"]')).toBeTruthy()
  })
})

describe('gift nets', () => {
  it('a void adds nothing and a partial adds what remains', () => {
    const day = (() => {
      const d = new Date()
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    })()
    const trend = buildTrendFromDonations([
      { ...VOIDED, date: day },
      { ...PARTIAL, date: day },
      { id: 9, date: day, amount: '10.00', refunded_at: null },
    ])
    const today = trend.find(d => d.key === day)
    expect(today.total).toBe(80)
    expect(giftLiveAmount(VOIDED)).toBe(0)
    expect(giftLiveAmount(PARTIAL)).toBe(70)
  })

  it('only an admin can mark a gift that is still open and not from a cash count', () => {
    const admin = { role: 'admin' }
    expect(canMarkGift(admin, PARTIAL)).toBe(true)
    expect(canMarkGift({ role: 'staff' }, PARTIAL)).toBe(false)
    expect(canMarkGift({ role: 'viewer' }, PARTIAL)).toBe(false)
    expect(canMarkGift(admin, VOIDED)).toBe(false)
    expect(canMarkGift(admin, { ...PARTIAL, books: books({ from_cash_count: true, live_amount: '100.00' }) })).toBe(false)
  })
})

describe('SP-110 / R367-1 refund dialog is a real modal', () => {
  const open = async () => {
    view()
    const ben = (await screen.findByText('Ben Donor')).closest('tr')
    const opener = ben.querySelector('[aria-label="Refund this gift"]')
    opener.focus()
    fireEvent.click(opener)
    const dlg = await screen.findByRole('dialog', { name: 'Refund this gift?' })
    return { opener, dlg }
  }
  const focusables = (dlg) => [...dlg.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]

  it('has role=dialog, aria-modal and a label, and focus lands inside on open', async () => {
    const { dlg } = await open()
    expect(dlg).toHaveAttribute('aria-modal', 'true')
    expect(dlg.contains(document.activeElement)).toBe(true)
  })

  it('Tab wraps from the last control to the first, Shift+Tab from the first to the last', async () => {
    const { dlg } = await open()
    const nodes = focusables(dlg)
    const first = nodes[0], last = nodes[nodes.length - 1]
    last.focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).toBe(first)
    first.focus()
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
  })

  it('Tab pulls focus back in when it has escaped behind the scrim', async () => {
    const { dlg, opener } = await open()
    opener.focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(dlg.contains(document.activeElement)).toBe(true)
  })

  it('Escape closes without submitting and returns focus to the opener', async () => {
    const { opener } = await open()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Refund this gift?' })).toBeNull())
    expect(document.activeElement).toBe(opener)
    expect(fetch.mock.calls.some(([u, i]) => i?.method === 'POST')).toBe(false)
  })

  it('Cancel returns focus to the opener', async () => {
    const { opener, dlg } = await open()
    fireEvent.click(within(dlg).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Refund this gift?' })).toBeNull())
    expect(document.activeElement).toBe(opener)
  })
})
