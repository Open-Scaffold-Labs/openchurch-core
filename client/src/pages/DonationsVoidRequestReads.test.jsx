// R359-1 / R359-2 (TARS, #359): pending void-request reads are latest-only,
// and the whole list is validated before it replaces state. Deferred fetches.
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react'
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
const bad = { ok: false, status: 500, json: async () => ({}) }
function deferred() { let resolve; const p = new Promise(r => { resolve = r }); return { p, resolve } }

let calls, reads
// Each void-request read takes the next queued response: a value (immediate)
// or a deferred handle (resolved by the test).
function stub(queue) {
  calls = []; reads = []
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const u = String(url)
    calls.push({ u, init })
    if (u.includes('/void-requests/') || (u.includes('/void-requests') && init?.method === 'POST')) return ok({ request: {} })
    if (u.includes('/cash-counts/void-requests')) {
      const next = queue.shift() ?? ok([])
      reads.push(next)
      return next.p ? next.p : next
    }
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
const warning = () => screen.queryByText(/Void requests didn't load/)
const shown = r => within(r).queryByText(/Void requested/)
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 30)) })
const retry = async () => {
  const w = await screen.findByText(/Void requests didn't load/)
  const box = w.closest('div,p') || w.parentElement
  fireEvent.click(within(box).getByRole('button', { name: 'Try again' }))
  await settle()
}

beforeEach(() => { vi.unstubAllGlobals(); authState.user.role = 'staff'; authState.user.id = 1 })

// Two reads in flight: first read fails so "Try again" appears, then two
// retries are started before either resolves.
async function twoInFlight() {
  const older = deferred(), newer = deferred()
  stub([bad, older, newer])
  view()
  const r = await row()
  await screen.findByText(/Void requests didn't load/)
  await retry(); await retry()
  return { r, older, newer }
}

describe('R359-1 latest read wins', () => {
  it('older pending read after newer empty read does not restore the request', async () => {
    const { r, older, newer } = await twoInFlight()
    await act(async () => newer.resolve(ok([])))
    await settle()
    await act(async () => older.resolve(ok([REQ])))
    await settle()
    expect(shown(r)).toBeNull()
    expect(warning()).toBeNull()
  })

  it('older empty read after newer pending read does not hide the request', async () => {
    const { r, older, newer } = await twoInFlight()
    await act(async () => newer.resolve(ok([REQ])))
    await settle()
    await act(async () => older.resolve(ok([])))
    await settle()
    expect(shown(r)).toBeTruthy()
  })

  it('older failure after newer success does not raise the warning', async () => {
    const { r, older, newer } = await twoInFlight()
    await act(async () => newer.resolve(ok([REQ])))
    await settle()
    await act(async () => older.resolve(bad))
    await settle()
    expect(warning()).toBeNull()
    expect(shown(r)).toBeTruthy()
  })

  it('a refresh after a staff request retires the earlier read', async () => {
    const first = deferred()
    stub([first, ok([REQ])])
    view()
    const r = await row()
    fireEvent.click(within(r).getByRole('button', { name: 'Request void' }))
    fireEvent.change(await screen.findByRole('textbox', { name: /Reason/ }), { target: { value: 'Wrong bag' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }))
    await waitFor(() => expect(shown(r)).toBeTruthy())
    await act(async () => first.resolve(ok([])))
    await settle()
    expect(shown(r)).toBeTruthy()
  })

  // Smoke only: React 18 drops post-unmount writes silently, so this cannot
  // discriminate; the unmount retirement is the effect cleanup in Donations.jsx.
  it('reads still in flight at unmount write nothing (smoke)', async () => {
    const first = deferred()
    stub([first])
    const errs = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { unmount } = view()
    await row()
    unmount()
    await act(async () => first.resolve(ok([REQ])))
    await settle()
    expect(errs.mock.calls.filter(c => /unmounted|not wrapped in act/.test(String(c[0])))).toEqual([])
    errs.mockRestore()
  })
})

describe('R359-2 whole-list validation', () => {
  it.each([
    ['malformed only', [null, { cash_count_id: 3, reason: 7 }]],
    ['mixed valid and bad', [REQ, null]],
    ['missing request id', [{ ...REQ, id: undefined }]],
    ['bad request id', [{ ...REQ, id: 'x' }]],
    ['bad count id', [{ ...REQ, cash_count_id: 'abc' }]],
    ['wrong status', [{ ...REQ, status: 'approved' }]],
    ['non-string reason', [{ ...REQ, reason: 7 }]],
    ['bad requester name', [{ ...REQ, requested_by_name: { x: 1 } }]],
    ['bad requester id', [{ ...REQ, requested_by_user_id: 'me' }]],
  ])('%s: shows the read-failure warning and no decision controls', async (_, body) => {
    authState.user.role = 'admin'
    stub([ok(body)])
    view()
    const r = await row()
    expect(await screen.findByText(/Void requests didn't load/)).toBeTruthy()
    expect(within(r).queryByRole('button', { name: 'Approve void' })).toBeNull()
  })

  it('bad data on refresh keeps the last good request and warns', async () => {
    authState.user.role = 'admin'
    stub([ok([REQ]), ok([null, { cash_count_id: 3, reason: 7 }])])
    view()
    const r = await row()
    await waitFor(() => expect(shown(r)).toBeTruthy())
    fireEvent.click(within(r).getByRole('button', { name: 'Reject' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Reject request' }))
    expect(await screen.findByText(/Void requests didn't load/)).toBeTruthy()
    expect(shown(r)).toBeTruthy()
  })

  it('controls: genuine [] shows nothing and no warning; a valid row shows controls', async () => {
    authState.user.role = 'admin'
    stub([ok([])])
    const v = view()
    const r = await row(); await settle()
    expect(warning()).toBeNull(); expect(shown(r)).toBeNull()
    v.unmount()
    stub([ok([REQ])])
    view()
    expect(await within(await row()).findByRole('button', { name: 'Approve void' })).toBeTruthy()
    expect(warning()).toBeNull()
  })
})
