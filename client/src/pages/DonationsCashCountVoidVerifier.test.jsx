// 123 — cash counts: signed-in verifier and reasoned void (José, 21 Oct).
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { LocaleProvider } from '../i18n'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import Donations, { cashCountVerificationLabel } from './Donations'

const authState = { user: { id: 1, name: 'Admin', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } } }
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ ...authState, token: 't', loading: false, canWrite: true }),
}))

const base = { service_date: '2031-06-15', category: 'offertory', counted_by: 'Margaret', verified_by: null, total: '40.00', denominations: {} }
const MINE    = { ...base, id: 1, status: 'pending', service_name: 'Mine', counted_by_user_id: 1 }
const OTHERS  = { ...base, id: 2, status: 'pending', service_name: 'Others', counted_by_user_id: 9 }
const TWO     = { ...base, id: 3, status: 'confirmed', service_name: 'Two', counted_by_user_id: 9, verification: 'two_person', confirmed_by_name: 'Teresa' }
const SINGLE  = { ...base, id: 4, status: 'confirmed', service_name: 'Single', counted_by_user_id: 9, verification: 'single' }
const OLD     = { ...base, id: 5, status: 'confirmed', service_name: 'Old', counted_by_user_id: null, verification: null, verified_by: 'Joseph' }
const VOIDED  = { ...TWO, id: 6, service_name: 'Gone', voided_at: '2031-06-16T00:00:00Z', voided_by_name: 'Admin', void_reason: 'Wrong bag' }

const ok = b => ({ ok: true, status: 200, json: async () => b })
let calls
function stub(rows) {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const u = String(url)
    calls.push({ u, init })
    if (u.includes('/confirm') || u.includes('/void')) return ok({ session: {} })
    if (u.includes('/api/donations/cash-counts')) return ok(rows)
    if (u.includes('/api/donations/recurring')) return ok({ recurring: [] })
    if (u.includes('/api/donations/summary')) return ok({ summary: null })
    if (u.includes('/api/donations/by-fund')) return ok({ funds: [] })
    if (u.includes('/api/donations')) return ok([])
    return ok({})
  }))
}
const view = () => render(
  <MemoryRouter initialEntries={['/donations']}>
    <LocaleProvider><ToastProvider><ConfirmProvider><Donations /></ConfirmProvider></ToastProvider></LocaleProvider>
  </MemoryRouter>
)
const row = async id => screen.findByTestId(`cash-count-${id}`, {}, { timeout: 4000 })
const sent = frag => calls.find(c => c.u.includes(frag))

beforeEach(() => { vi.unstubAllGlobals(); authState.user.role = 'admin' })

describe('verification labels', () => {
  it('names each kind of verification honestly', () => {
    expect(cashCountVerificationLabel(TWO)).toBe('Verified by Teresa')
    expect(cashCountVerificationLabel(SINGLE)).toBe('Single count, not verified')
    expect(cashCountVerificationLabel(OLD)).toBe('Typed names, before signed-in verification')
    expect(cashCountVerificationLabel(MINE)).toBeNull()
  })

  it('renders the labels and the void on the rows', async () => {
    stub([TWO, SINGLE, OLD, VOIDED])
    view()
    expect(within(await row(3)).getByText(/Verified by Teresa/)).toBeTruthy()
    expect(within(await row(4)).getByText(/Single count, not verified/)).toBeTruthy()
    expect(within(await row(5)).getByText(/Typed names, before signed-in verification/)).toBeTruthy()
    expect(within(await row(5)).getByText(/Margaret & Joseph/)).toBeTruthy()
    const v = await row(6)
    expect(within(v).getByText('Voided')).toBeTruthy()
    expect(within(v).getByText(/Wrong bag/)).toBeTruthy()
    expect(within(v).queryByRole('button', { name: 'Void' })).toBeNull()
  })
})

describe('signed-in confirmation', () => {
  it('another user\'s pending count: Confirm sends no typed name', async () => {
    stub([OTHERS])
    view()
    fireEvent.click(within(await row(2)).getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(sent('/cash-counts/2/confirm')).toBeTruthy())
    expect(JSON.parse(sent('/cash-counts/2/confirm').init.body)).toEqual({})
    expect(within(await row(2)).queryByLabelText(/Second counter/)).toBeNull()
  })

  it('my own pending count: no Confirm; posting it alone asks, then sends single_count', async () => {
    stub([MINE])
    view()
    const r = await row(1)
    expect(within(r).queryByRole('button', { name: 'Confirm' })).toBeNull()
    expect(within(r).getByText(/Waiting for a second staff member/)).toBeTruthy()
    fireEvent.click(within(r).getByRole('button', { name: 'Post as single count' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Post single count' }))
    await waitFor(() => expect(sent('/cash-counts/1/confirm')).toBeTruthy())
    expect(JSON.parse(sent('/cash-counts/1/confirm').init.body)).toEqual({ single_count: true })
  })

  it('the save drawer no longer offers a typed verifier', async () => {
    stub([])
    view()
    expect(screen.queryByText(/Counter 2/)).toBeNull()
  })
})

describe('void', () => {
  it('admin voids a confirmed count with a reason', async () => {
    stub([TWO])
    view()
    fireEvent.click(within(await row(3)).getByRole('button', { name: 'Void' }))
    const box = await screen.findByRole('textbox', { name: /Reason/ })
    fireEvent.change(box, { target: { value: 'Counted twice' } })
    fireEvent.click(screen.getByRole('button', { name: 'Void count' }))
    await waitFor(() => expect(sent('/cash-counts/3/void')).toBeTruthy())
    const c = sent('/cash-counts/3/void')
    expect(c.init.method).toBe('POST')
    expect(JSON.parse(c.init.body)).toEqual({ reason: 'Counted twice' })
  })

  it('staff see no Void button', async () => {
    authState.user.role = 'staff'
    stub([TWO])
    view()
    expect(within(await row(3)).queryByRole('button', { name: 'Void' })).toBeNull()
  })

  it('SP-110: the void-count prompt is a labelled modal dialog and Escape cancels it', async () => {
    stub([TWO])
    view()
    fireEvent.click(within(await row(3)).getByRole('button', { name: 'Void' }))
    const dlg = await screen.findByRole('alertdialog', { name: /Void the .* count\?/ })
    expect(dlg).toHaveAttribute('aria-modal', 'true')
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(sent('/cash-counts/3/void')).toBeFalsy()
  })
})
