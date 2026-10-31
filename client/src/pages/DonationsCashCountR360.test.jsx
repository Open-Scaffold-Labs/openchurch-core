// R360-1 / R360-2 (TARS on #360 @ 9e168d84): one owner for the cash-count
// list across page load, action refresh, date edits and saves; every row
// validated; empty only after a settled successful read for the range.
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { LocaleProvider } from '../i18n'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import Donations, { cashCountInRange } from './Donations'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Admin', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 'test-token', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const row = (id, service_date, extra = {}) => ({ id, status: 'confirmed', verification: 'two_person',
  confirmed_by_name: 'Joseph', service_name: `Count ${id}`, service_date, category: 'offertory',
  counted_by: 'Margaret', counted_by_user_id: 2, total: '10.00', ...extra })
const SEP = row(1, '2026-09-06')
const OCT = row(2, '2026-10-04')
const OCT_PENDING = row(3, '2026-10-11', { status: 'pending', verification: null, confirmed_by_name: null })

const res = (body, status = 200) => ({ ok: status < 400, status, json: async () => body })
function deferred() { let resolve; const p = new Promise(r => { resolve = r }); return { p, resolve } }

// Each cash-counts list request is answered by the test, in any order.
let cashCalls, calls
function stub({ onConfirm } = {}) {
  cashCalls = []; calls = []
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const u = String(url)
    calls.push({ u, init })
    if (u.includes('/void-requests')) return res([])
    if (u.includes('/confirm')) return onConfirm ? onConfirm() : res({})
    if (u.endsWith('/api/donations/cash-counts') && init?.method === 'POST') {
      return res(JSON.parse(init.body).__reply || row(9, JSON.parse(init.body).service_date))
    }
    if (u.includes('/api/donations/cash-counts')) {
      const d = deferred(); cashCalls.push({ u, ...d }); return d.p
    }
    if (u.includes('/api/donations/recurring')) return res({ recurring: [], needs_attention: [] })
    if (u.includes('/api/donations/summary')) return res({})
    if (u.includes('/api/donations/by-fund')) return res({ funds: [] })
    if (u.includes('/api/donations')) return res([])
    return res({})
  }))
}
const view = () => render(
  <MemoryRouter initialEntries={['/donations']}>
    <LocaleProvider><ToastProvider><ConfirmProvider>
      <Donations />
    </ConfirmProvider></ToastProvider></LocaleProvider>
  </MemoryRouter>
)
const answer = async (i, body, status) => { await act(async () => { cashCalls[i].resolve(res(body, status)) }) }
const waitCalls = n => waitFor(() => expect(cashCalls.length).toBeGreaterThanOrEqual(n))
const setFrom = v => fireEvent.change(screen.getByLabelText('Cash counts from date'), { target: { value: v } })
const setTo = v => fireEvent.change(screen.getByLabelText('Cash counts to date'), { target: { value: v } })
const EMPTY = 'No cash counts in these dates.'

beforeEach(() => { vi.unstubAllGlobals(); localStorage.removeItem('ochr_locale') })

describe('R360-1 one owner for the cash-count list', () => {
  it('(a) an older page load cannot restore rows under a newer date range', async () => {
    stub(); view()
    await waitCalls(1)
    // Make the section visible with a first settled read, then start a
    // second (refresh-like) unfiltered read that will answer late.
    await answer(0, [SEP, OCT])
    await screen.findByTestId('cash-count-1')
    setFrom('2026-10-01'); await waitCalls(2)      // filter read
    setFrom('');            await waitCalls(3)      // unfiltered read (old)
    setFrom('2026-10-01'); await waitCalls(4)      // newest filter read
    await answer(3, [OCT])
    await waitFor(() => expect(screen.queryByTestId('cash-count-1')).not.toBeInTheDocument())
    await answer(2, [SEP, OCT])                     // the stale unfiltered answer
    await answer(1, [SEP, OCT])
    expect(screen.queryByTestId('cash-count-1')).not.toBeInTheDocument()
    expect(screen.getByTestId('cash-count-2')).toBeInTheDocument()
  })

  it('(a2) a page load (action refresh) answering after a date edit does not win', async () => {
    stub({ onConfirm: () => res({}) }); view()
    await waitCalls(1)
    await answer(0, [SEP, OCT_PENDING])
    await screen.findByTestId('cash-count-3')
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))   // load() starts, unfiltered
    await waitCalls(2)
    expect(cashCalls[1].u).not.toContain('from=')
    setFrom('2026-10-01'); await waitCalls(3)                           // newer filter read
    await answer(2, [OCT_PENDING])
    await waitFor(() => expect(screen.queryByTestId('cash-count-1')).not.toBeInTheDocument())
    await answer(1, [SEP, OCT_PENDING])                                 // old load answers last
    expect(screen.queryByTestId('cash-count-1')).not.toBeInTheDocument()
    expect(screen.getByTestId('cash-count-3')).toBeInTheDocument()
  })

  it('(b) an older filter read cannot restore the pre-action snapshot after a refresh', async () => {
    stub({ onConfirm: () => res({}) }); view()
    await waitCalls(1)
    await answer(0, [OCT_PENDING])
    await screen.findByTestId('cash-count-3')
    setFrom('2026-10-01'); await waitCalls(2)       // filter read, answers late
    await answer(1, [OCT_PENDING])
    // newer filter read in flight, then an action refresh
    setTo('2026-10-31'); await waitCalls(3)
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await waitCalls(4)
    expect(cashCalls[3].u).toContain('from=2026-10-01&to=2026-10-31')
    await answer(3, [{ ...OCT_PENDING, status: 'confirmed', verification: 'two_person' }])
    await waitFor(() => expect(screen.getByTestId('cash-count-status-3')).toHaveTextContent('Confirmed'))
    await answer(2, [OCT_PENDING])                  // stale pre-action snapshot
    expect(screen.getByTestId('cash-count-status-3')).toHaveTextContent('Confirmed')
  })

  it('a count saved outside the active range does not join the filtered list', async () => {
    stub(); view()
    await waitCalls(1)
    await answer(0, [OCT])
    await screen.findByTestId('cash-count-2')
    setFrom('2026-10-01'); setTo('2026-10-31'); await waitCalls(3)
    await answer(1, [OCT]); await answer(2, [OCT])
    fireEvent.click(screen.getByRole('button', { name: /Cash Count/ }))
    fireEvent.change(screen.getByPlaceholderText('e.g. Sunday Morning Service'), { target: { value: 'Old Mass' } })
    fireEvent.change(screen.getByPlaceholderText('First name'), { target: { value: 'Ann' } })
    const dates = document.querySelectorAll('form input[type="date"]')
    fireEvent.change(dates[0], { target: { value: '2026-09-06' } })
    fireEvent.change(document.querySelectorAll('form input[type="number"]')[0], { target: { value: '1' } })
    fireEvent.submit(document.querySelector('form'))
    await waitFor(() => expect(calls.some(c => c.init?.method === 'POST')).toBe(true))
    await waitCalls(4)                               // re-read of the active range
    expect(screen.queryByTestId('cash-count-9')).not.toBeInTheDocument()
    expect(cashCalls[3].u).toContain('from=2026-10-01&to=2026-10-31')
    await answer(3, [OCT])
    expect(screen.queryByTestId('cash-count-9')).not.toBeInTheDocument()
  })

  it('cashCountInRange is inclusive and open-ended', () => {
    expect(cashCountInRange({ service_date: '2026-10-01' }, { from: '2026-10-01', to: '2026-10-31' })).toBe(true)
    expect(cashCountInRange({ service_date: '2026-10-31' }, { from: '2026-10-01', to: '2026-10-31' })).toBe(true)
    expect(cashCountInRange({ service_date: '2026-09-30' }, { from: '2026-10-01', to: '' })).toBe(false)
    expect(cashCountInRange({ service_date: '2026-11-01' }, { from: '', to: '2026-10-31' })).toBe(false)
    expect(cashCountInRange({ service_date: '2020-01-01' }, { from: '', to: '' })).toBe(true)
  })
})

describe('R360-2 validated rows and honest read states', () => {
  async function seeded() {
    stub(); view()
    await waitCalls(1)
    await answer(0, [OCT])
    await screen.findByTestId('cash-count-2')
  }

  it('a filtered [null] is a failure, not a list, and does not crash', async () => {
    await seeded()
    setFrom('2026-10-01'); await waitCalls(2)
    await answer(1, [null])
    expect(await screen.findByTestId('cash-counts-failed')).toBeInTheDocument()
    expect(screen.queryByText(EMPTY)).not.toBeInTheDocument()
    expect(screen.getByTestId('cash-count-2')).toBeInTheDocument()   // kept, marked stale
    expect(screen.getByTestId('cash-count-list').className).toContain('opacity-60')
  })

  it('a mixed list with one bad row is rejected whole', async () => {
    await seeded()
    setFrom('2026-10-01'); await waitCalls(2)
    await answer(1, [row(5, '2026-10-05'), { id: 6 }])
    expect(await screen.findByTestId('cash-counts-failed')).toBeInTheDocument()
    expect(screen.queryByTestId('cash-count-5')).not.toBeInTheDocument()
  })

  it('a pending read never says empty, then shows what arrives', async () => {
    await seeded()
    setFrom('2026-12-01'); await waitCalls(2)
    await answer(1, [])
    expect(await screen.findByText(EMPTY)).toBeInTheDocument()
    setFrom('2026-10-01'); await waitCalls(3)
    expect(screen.queryByText(EMPTY)).not.toBeInTheDocument()
    expect(screen.getByTestId('cash-counts-loading')).toBeInTheDocument()
    await answer(2, [OCT])
    expect(await screen.findByTestId('cash-count-2')).toBeInTheDocument()
    expect(screen.queryByText(EMPTY)).not.toBeInTheDocument()
  })

  it('a failed filtered read says so and never says empty', async () => {
    await seeded()
    setFrom('2026-12-01'); await waitCalls(2)
    await answer(1, { error: 'x' }, 500)
    expect(await screen.findByTestId('cash-counts-failed')).toBeInTheDocument()
    expect(screen.queryByText(EMPTY)).not.toBeInTheDocument()
  })

  it('control: a settled [] for the range is called empty', async () => {
    await seeded()
    setFrom('2026-12-01'); await waitCalls(2)
    await answer(1, [])
    expect(await screen.findByText(EMPTY)).toBeInTheDocument()
    expect(screen.queryByTestId('cash-counts-failed')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cash-counts-loading')).not.toBeInTheDocument()
  })
})

describe('R360 residuals (TARS @ a89eabcf)', () => {
  const NOTICE = /Couldn't load cash count sessions/

  it('R360-2: [] → Clear dates → held read shows loading → 500 shows failure + retry → retry recovers', async () => {
    stub(); view()
    await waitCalls(1)
    await answer(0, [OCT])
    await screen.findByTestId('cash-count-2')
    setFrom('2026-12-01'); await waitCalls(2)
    await answer(1, [])
    expect(await screen.findByText(EMPTY)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Clear dates' }))
    await waitCalls(3)
    expect(await screen.findByTestId('cash-counts-loading')).toBeInTheDocument()
    await answer(2, { error: 'down' }, 500)
    const failed = await screen.findByTestId('cash-counts-failed')
    expect(screen.queryByText(EMPTY)).not.toBeInTheDocument()
    fireEvent.click(within(failed).getByRole('button', { name: 'Try again' }))
    await waitCalls(4)
    await answer(3, [OCT])
    expect(await screen.findByTestId('cash-count-2')).toBeInTheDocument()
    expect(screen.queryByTestId('cash-counts-failed')).not.toBeInTheDocument()
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument()
  })

  for (const [label, fail] of [
    ['HTTP 500', i => answer(i, { error: 'x' }, 500)],
    ['network rejection', async i => { await act(async () => { cashCalls[i].resolve(Promise.reject(new TypeError('net'))) }) }],
  ]) {
    it(`R360-1: an old page-load cash ${label} after a newer successful read leaves no cash notice`, async () => {
      stub({ onConfirm: () => res({}) }); view()
      await waitCalls(1)
      await answer(0, [OCT_PENDING])
      await screen.findByTestId('cash-count-3')
      fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))  // load() starts
      await waitCalls(2)
      setFrom('2026-10-01'); await waitCalls(3)
      await answer(2, [OCT_PENDING])
      await fail(1)
      await waitFor(() => expect(screen.getByTestId('cash-count-3')).toBeInTheDocument())
      expect(screen.queryByText(NOTICE)).not.toBeInTheDocument()
      expect(screen.queryByTestId('cash-counts-failed')).not.toBeInTheDocument()
    })

    it(`R360-1: an old page-load cash ${label} BEFORE the newer read settles leaves no cash notice after it`, async () => {
      stub({ onConfirm: () => res({}) }); view()
      await waitCalls(1)
      await answer(0, [OCT_PENDING])
      await screen.findByTestId('cash-count-3')
      fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
      await waitCalls(2)
      setFrom('2026-10-01'); await waitCalls(3)
      await fail(1)
      await answer(2, [OCT_PENDING])
      await waitFor(() => expect(screen.queryByTestId('cash-counts-loading')).not.toBeInTheDocument())
      expect(screen.queryByText(NOTICE)).not.toBeInTheDocument()
    })
  }

  it('R360-1: a cash-only retry that succeeds clears the page-load cash warning', async () => {
    stub(); view()
    await waitCalls(1)
    await answer(0, { error: 'x' }, 500)
    expect(await screen.findByText(NOTICE)).toBeInTheDocument()
    fireEvent.click(within(screen.getByTestId('cash-counts-failed')).getByRole('button', { name: 'Try again' }))
    await waitCalls(2)
    await answer(1, [OCT])
    expect(await screen.findByTestId('cash-count-2')).toBeInTheDocument()
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument()
  })
})
