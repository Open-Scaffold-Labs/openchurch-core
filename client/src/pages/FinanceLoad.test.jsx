// Pilot 2 — the hard truth test. (Pass 7 §6)
//
// Finance is where the empty/unknown distinction has money attached, and
// where Pass 5 established that $0.00 is a LEGITIMATE control value: two of
// three "confirmed defects" on this page evaporated at the control step,
// because that tenant genuinely has no expense.
//
// So the test that matters is the pair. A real zero must stay a calm zero.
// An unread figure must never become one.
//
// The defect: four requests rode one Promise.all with
// `if (!s.ok || !l.ok || !c.ok || !m.ok) throw`. One failure blanked all
// four — summary went null, entries went to [], and the rollup card
// rendered "Nothing recorded in this period". A parish shown an empty set
// of its own books because the chart of accounts 404'd.

import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import Finance from './Finance'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Treasurer', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 't', loading: false,
  }),
}))

// A tenant that genuinely has no expense this period. Every figure is a
// real, reported zero — this is the control the page must not confuse with
// a failure.
const TRUE_ZERO = {
  totals: { revenue: 0, expense: 0, net: 0, assessable_base: 0 },
  groups: [],
}
const WITH_MONEY = {
  totals: { revenue: 2420.57, expense: 0, net: 2420.57, assessable_base: 2420.57 },
  groups: [{ rollup_group: 'Offerings', acct_type: 'revenue', assessable: true, total: 2420.57 }],
}

const ok  = (body) => ({ ok: true,  status: 200, json: async () => body })
const err = (status) => ({ ok: false, status, json: async () => ({ error: 'boom' }) })

const routes = (over = {}) => vi.stubGlobal('fetch', vi.fn(async (url) => {
  const u = String(url)
  for (const [frag, handler] of Object.entries(over)) if (u.includes(frag)) return handler()
  if (u.includes('/finance/summary'))  return ok(TRUE_ZERO)
  if (u.includes('/finance/ledger'))   return ok({ entries: [] })
  if (u.includes('/finance/coa'))      return ok({ accounts: [] })
  if (u.includes('/finance/mappings')) return ok({ mappings: [], donation_categories: [], funds: [] })
  if (u.includes('/affiliation'))      return ok({ affiliation: null })
  return ok({})
}))

const mount = () => render(
  <MemoryRouter><LocaleProvider><ToastProvider><ConfirmProvider>
    <Finance />
  </ConfirmProvider></ToastProvider></LocaleProvider></MemoryRouter>
)

const EMPTY_BOOKS = /nothing recorded in this period/i
const UNREAD      = /couldn'?t be read/i

beforeEach(() => vi.unstubAllGlobals())

describe('CONTROL — a real zero is an answer', () => {
  it('a genuinely empty period shows $0.00 and the calm empty state, with no warning', async () => {
    routes(); mount()
    await waitFor(() => expect(screen.getByText(EMPTY_BOOKS)).toBeInTheDocument())
    expect(screen.getAllByText('$0.00').length).toBeGreaterThan(0)
    expect(screen.queryByText(UNREAD)).not.toBeInTheDocument()
  })

  it('a period with money shows the figures', async () => {
    routes({ '/finance/summary': () => ok(WITH_MONEY) }); mount()
    expect((await screen.findAllByText('$2,420.57')).length).toBeGreaterThan(0)
    expect(screen.queryByText(UNREAD)).not.toBeInTheDocument()
    expect(screen.queryByText(EMPTY_BOOKS)).not.toBeInTheDocument()
  })
})

describe('FAILED must never become ZERO or EMPTY', () => {
  it('a failed summary shows dashes and says so — never $0.00, never empty books', async () => {
    routes({ '/finance/summary': () => err(500) }); mount()
    await waitFor(() => expect(screen.getAllByText(UNREAD).length).toBeGreaterThan(0))
    // The figure is unknown, and reads as unknown.
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument()
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
    // And the books are not declared empty.
    expect(screen.queryByText(EMPTY_BOOKS)).not.toBeInTheDocument()
  })

  it('a failed ledger does not claim there are no entries', async () => {
    routes({ '/finance/ledger': () => err(500) }); mount()
    await waitFor(() => expect(screen.getAllByText(UNREAD).length).toBeGreaterThan(0))
    expect(screen.queryByText(/no entries in this period/i)).not.toBeInTheDocument()
  })
})

describe('PARTIAL failure leaves the rest of the page usable', () => {
  it('a failed chart of accounts no longer blanks the money', async () => {
    // This is the exact all-or-nothing case: before, `!c.ok` threw and took
    // the summary and the ledger down with it.
    routes({ '/finance/coa': () => err(500), '/finance/summary': () => ok(WITH_MONEY) })
    mount()
    expect((await screen.findAllByText('$2,420.57')).length).toBeGreaterThan(0)
    expect(screen.getByText(/Offerings/)).toBeInTheDocument()
  })

  it('a failed summary leaves the ledger readable', async () => {
    routes({
      '/finance/summary': () => err(500),
      '/finance/ledger':  () => ok({ entries: [{ entry_date: '2026-08-01', account_code: '4000', amount: 100, memo: 'Plate' }] }),
    })
    mount()
    await waitFor(() => expect(screen.getAllByText(UNREAD).length).toBeGreaterThan(0))
    expect(screen.getByText(/Plate/)).toBeInTheDocument()
  })
})

describe('RETRY', () => {
  it('recovers the summary in place after a failure', async () => {
    let call = 0
    routes({ '/finance/summary': () => (++call === 1 ? err(500) : ok(WITH_MONEY)) })
    mount()
    await waitFor(() => expect(screen.getAllByText(UNREAD).length).toBeGreaterThan(0))
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: /try again/i })[0]) })
    await waitFor(() => expect(screen.getAllByText('$2,420.57').length).toBeGreaterThan(0))
  })
})
