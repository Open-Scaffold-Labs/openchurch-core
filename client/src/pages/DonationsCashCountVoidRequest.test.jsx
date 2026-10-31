// 124 — staff request a void; an admin who is not the requester decides.
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { LocaleProvider } from '../i18n'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import Donations from './Donations'

const authState = { user: { id: 1, name: 'Staff', role: 'staff', organization: { id: 1, name: 'St Test', locale: 'en' } }, canWrite: true }
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ ...authState, token: 't', loading: false }),
}))

const COUNT = { id: 3, status: 'confirmed', service_name: 'Vigil', service_date: '2031-06-15', category: 'offertory',
  counted_by: 'Margaret', verified_by: null, total: '40.00', denominations: {}, counted_by_user_id: 9,
  verification: 'two_person', confirmed_by_name: 'Teresa' }
const REQ = { id: 70, cash_count_id: 3, reason: 'Wrong bag', status: 'pending', requested_by_user_id: 5, requested_by_name: 'Staff Five' }

const ok = b => ({ ok: true, status: 200, json: async () => b })
let calls
function stub(requests, failRequests = false) {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const u = String(url)
    calls.push({ u, init })
    if (u.includes('/void-requests/') || (u.includes('/void-requests') && init?.method === 'POST')) return ok({ request: {} })
    if (u.includes('/cash-counts/void-requests')) return failRequests ? { ok: false, status: 500, json: async () => ({}) } : ok(requests)
    if (u.includes('/api/donations/cash-counts')) return ok([COUNT])
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
const row = () => screen.findByTestId('cash-count-3', {}, { timeout: 4000 })
const posted = frag => calls.find(c => c.u.includes(frag) && c.init?.method === 'POST')

beforeEach(() => { vi.unstubAllGlobals(); authState.user.role = 'staff'; authState.user.id = 1; authState.canWrite = true })

describe('staff', () => {
  it('requests a void with a reason; no direct Void button', async () => {
    stub([])
    view()
    const r = await row()
    expect(within(r).queryByRole('button', { name: 'Void' })).toBeNull()
    fireEvent.click(within(r).getByRole('button', { name: 'Request void' }))
    fireEvent.change(await screen.findByRole('textbox', { name: /Reason/ }), { target: { value: 'Counted twice' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }))
    await waitFor(() => expect(posted('/cash-counts/3/void-requests')).toBeTruthy())
    expect(JSON.parse(posted('/cash-counts/3/void-requests').init.body)).toEqual({ reason: 'Counted twice' })
  })

  it('a pending request shows who asked and why, and cannot be requested again', async () => {
    stub([REQ])
    view()
    const r = await row()
    await waitFor(() => expect(within(r).getByText(/Void requested by Staff Five: Wrong bag/)).toBeTruthy())
    expect(within(r).queryByRole('button', { name: 'Request void' })).toBeNull()
    expect(within(r).queryByRole('button', { name: 'Approve void' })).toBeNull()
  })
})

describe('admin', () => {
  it('approves another person\'s request', async () => {
    authState.user.role = 'admin'
    stub([REQ])
    view()
    const r = await row()
    fireEvent.click(await within(r).findByRole('button', { name: 'Approve void' }))
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Approve void' })).toHaveLength(2))
    fireEvent.click(screen.getAllByRole('button', { name: 'Approve void' }).at(-1))
    await waitFor(() => expect(posted('/void-requests/70/approve')).toBeTruthy())
  })

  it('rejects with an optional note', async () => {
    authState.user.role = 'admin'
    stub([REQ])
    view()
    fireEvent.click(await within(await row()).findByRole('button', { name: 'Reject' }))
    fireEvent.change(await screen.findByRole('textbox', { name: /Note/ }), { target: { value: 'Slip matches' } })
    fireEvent.click(screen.getByRole('button', { name: 'Reject request' }))
    await waitFor(() => expect(posted('/void-requests/70/reject')).toBeTruthy())
    expect(JSON.parse(posted('/void-requests/70/reject').init.body)).toEqual({ note: 'Slip matches' })
  })

  it('sees no Approve on a request they made themselves, but can still void directly', async () => {
    authState.user.role = 'admin'
    authState.user.id = 5
    stub([REQ])
    view()
    const r = await row()
    await waitFor(() => expect(within(r).getByText(/Void requested/)).toBeTruthy())
    expect(within(r).queryByRole('button', { name: 'Approve void' })).toBeNull()
    expect(within(r).getByRole('button', { name: 'Void' })).toBeTruthy()
  })
})

describe('honest failure', () => {
  it('a failed void-request read says so instead of showing none', async () => {
    stub([], true)
    view()
    await row()
    expect(await screen.findByText(/Void requests didn't load/)).toBeTruthy()
  })
})
