// A refused diocese read must not look like an answer.
//
// Finance.jsx used to map a non-ok affiliation response onto
// `{ affiliation: null }` and a non-ok submissions response onto
// `{ submissions: [] }`, then swallow the rejection. A parish the server
// refused to classify was shown as independent. A parish whose submissions
// could not be read was shown as having none.
//
// A real `affiliation: null` and a real empty submissions array stay calm.
// Those are answers. A refusal is not.

import { render, screen, within, waitFor, fireEvent, act } from '@testing-library/react'
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

const AFFILIATED = {
  affiliation: { status: 'active', diocese_name: 'Diocese of Test', grant_level: 'summary' },
}
const SUMMARY = {
  totals: { revenue: 0, expense: 0, net: 0, assessable_base: 0 },
  groups: [],
}
const FUNDS = {
  mappings: [],
  donation_categories: [],
  funds: [{ id: 4, name: 'Roof', gift_count: 2, gift_total: 40 }],
}

const ok = (body) => ({ ok: true, status: 200, json: async () => body })
const err = (status, body = { error: 'refused' }) => ({ ok: false, status, json: async () => body })

const routes = (over = {}) => vi.stubGlobal('fetch', vi.fn(async (url) => {
  const u = String(url)
  for (const [frag, handler] of Object.entries(over)) if (u.includes(frag)) return handler()
  if (u.includes('/finance/summary')) return ok(SUMMARY)
  if (u.includes('/finance/ledger')) return ok({ entries: [] })
  if (u.includes('/finance/coa')) return ok({ accounts: [] })
  if (u.includes('/finance/mappings')) return ok(FUNDS)
  if (u.includes('/affiliation')) return ok({ affiliation: null })
  if (u.includes('/finance/submissions')) return ok({ submissions: [] })
  return ok({})
}))

const mount = () => render(
  <MemoryRouter><LocaleProvider><ToastProvider><ConfirmProvider>
    <Finance />
  </ConfirmProvider></ToastProvider></LocaleProvider></MemoryRouter>
)

const INDEPENDENT = /later affiliates with a diocese/i
const UNREAD = /couldn.t reach the server/i
const DIOCESE = /diocese reporting/i

beforeEach(() => vi.unstubAllGlobals())

describe('CONTROL — a real empty diocese answer stays calm', () => {
  it('affiliation null is independence, not a failed read', async () => {
    routes({ '/affiliation': () => ok({ affiliation: null }) })
    mount()
    await screen.findByText(INDEPENDENT)
    expect(screen.queryByTestId('finance-affiliation-unread')).toBeNull()
    expect(screen.queryByText(UNREAD)).toBeNull()
    expect(screen.queryByText(DIOCESE)).toBeNull()
  })

  it('an empty submissions array is no list, not a failed read', async () => {
    routes({
      '/affiliation': () => ok(AFFILIATED),
      '/finance/submissions': () => ok({ submissions: [] }),
    })
    mount()
    await screen.findByText(DIOCESE)
    expect(screen.getByText(/Affiliated with Diocese of Test/)).toBeInTheDocument()
    expect(screen.queryByTestId('finance-submissions-unread')).toBeNull()
    expect(screen.queryByText(UNREAD)).toBeNull()
    expect(screen.queryByText(/2026-09-01/)).toBeNull()
  })
})

describe('FAILED affiliation is not independence', () => {
  it('a refused affiliation read does not hide the parish as unaffiliated', async () => {
    routes({
      '/affiliation': () => err(403, {
        affiliation: { status: 'active', diocese_name: 'Diocese of Test', grant_level: 'summary' },
      }),
    })
    mount()
    const unread = await screen.findByTestId('finance-affiliation-unread')
    const status = within(unread).getByRole('status')
    expect(status).toHaveTextContent(UNREAD)
    expect(status).toHaveTextContent(/not an empty list/i)
    expect(screen.queryByText(INDEPENDENT)).toBeNull()
    expect(screen.queryByText(DIOCESE)).toBeNull()
    expect(screen.queryByText(/Affiliated with Diocese of Test/)).toBeNull()
  })

  it('a network failure on affiliation is unread, not independence', async () => {
    routes({ '/affiliation': () => { throw new Error('network') } })
    mount()
    await screen.findByTestId('finance-affiliation-unread')
    expect(screen.queryByText(INDEPENDENT)).toBeNull()
  })

  it('a 200 whose body is not an affiliation object is unread', async () => {
    routes({ '/affiliation': () => ok({ error: 'malformed' }) })
    mount()
    await screen.findByTestId('finance-affiliation-unread')
    expect(screen.queryByText(INDEPENDENT)).toBeNull()
  })

  it('retry replaces the unread affiliation with the diocese block', async () => {
    let call = 0
    routes({
      '/affiliation': () => (++call === 1 ? err(500) : ok(AFFILIATED)),
      '/finance/submissions': () => ok({ submissions: [] }),
    })
    mount()
    const unread = await screen.findByTestId('finance-affiliation-unread')
    await act(async () => {
      fireEvent.click(within(unread).getByRole('button', { name: /try again/i }))
    })
    await screen.findByText(DIOCESE)
    expect(screen.queryByTestId('finance-affiliation-unread')).toBeNull()
    expect(screen.queryByText(INDEPENDENT)).toBeNull()
  })
})

describe('FAILED submissions are not an empty list', () => {
  it('a refused submissions read keeps the affiliation and says the list was not read', async () => {
    routes({
      '/affiliation': () => ok(AFFILIATED),
      '/finance/submissions': () => err(500),
    })
    mount()
    await screen.findByText(DIOCESE)
    expect(screen.getByText(/Affiliated with Diocese of Test/)).toBeInTheDocument()
    const unread = await screen.findByTestId('finance-submissions-unread')
    expect(within(unread).getByRole('status')).toHaveTextContent(UNREAD)
    expect(screen.queryByText(/2026-09-01/)).toBeNull()
    await waitFor(() => {
      expect(screen.queryByRole('table')).toBeNull()
    })
  })

  it('a 200 whose submissions field is not an array is unread', async () => {
    routes({
      '/affiliation': () => ok(AFFILIATED),
      '/finance/submissions': () => ok({ submissions: null }),
    })
    mount()
    await screen.findByTestId('finance-submissions-unread')
    expect(screen.getByText(/Affiliated with Diocese of Test/)).toBeInTheDocument()
  })

  it('a real submission still lists the period', async () => {
    routes({
      '/affiliation': () => ok(AFFILIATED),
      '/finance/submissions': () => ok({
        submissions: [{
          id: 3,
          period_start: '2026-09-01',
          period_end: '2026-09-30',
          status: 'submitted',
          totals: { revenue: 10, expense: 0, net: 10, assessable_base: 10 },
        }],
      }),
    })
    mount()
    expect(await screen.findByText(/2026-09-01/)).toBeInTheDocument()
    expect(screen.getByText('submitted')).toBeInTheDocument()
    expect(screen.queryByTestId('finance-submissions-unread')).toBeNull()
    expect(screen.queryByTestId('finance-affiliation-unread')).toBeNull()
  })
})
