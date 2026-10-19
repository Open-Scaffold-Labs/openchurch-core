// A post-approval refund is an OPEN condition (migration 099), and the
// parish's Finance page has to say so on the submission row.
//
// The list API returns `open_adjustment_count` / `open_adjustment_amount`
// as STRINGS. "0" is truthy — so the first control here is a row with the
// fields present and zero, which must render no marker. The second control
// is an older server that does not send the fields at all: no marker, and
// no wording anywhere on the page that could be read as "settled".

import { render, screen, within } from '@testing-library/react'
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

const AFFILIATED = { affiliation: { status: 'active', diocese_name: 'Diocese of Test', grant_level: 'summary' } }
const SUMMARY = { totals: { revenue: 1250, expense: 0, net: 1250, assessable_base: 1250 }, groups: [] }

const base = (id, over = {}) => ({
  id, period_start: '2031-06-01', period_end: '2031-06-30', status: 'approved',
  totals: { revenue: 1250, expense: 0, net: 1250, assessable_base: 1250 },
  review_note: null, ...over,
})

const ok = (body) => ({ ok: true, status: 200, json: async () => body })

const routes = (submissions) => vi.stubGlobal('fetch', vi.fn(async (url) => {
  const u = String(url)
  if (u.includes('/finance/submissions')) return ok({ submissions })
  if (u.includes('/finance/summary'))     return ok(SUMMARY)
  if (u.includes('/finance/ledger'))      return ok({ entries: [] })
  if (u.includes('/finance/coa'))         return ok({ accounts: [] })
  if (u.includes('/finance/mappings'))    return ok({ mappings: [], donation_categories: [], funds: [] })
  if (u.includes('/affiliation'))         return ok(AFFILIATED)
  return ok({})
}))

const mount = () => render(
  <MemoryRouter><LocaleProvider><ToastProvider><ConfirmProvider>
    <Finance />
  </ConfirmProvider></ToastProvider></LocaleProvider></MemoryRouter>
)

const MARKER = /unresolved adjustment/i

beforeEach(() => vi.unstubAllGlobals())

describe('parish Finance — post-approval refund on a submitted period', () => {
  it('a row with count "1" / amount "1000.00" shows the unresolved marker with $1,000.00', async () => {
    routes([base(7, { open_adjustment_count: '1', open_adjustment_amount: '1000.00' })])
    mount()
    const note = await screen.findByTestId('open-adjustment-7')
    expect(note).toHaveTextContent(MARKER)
    expect(note).toHaveTextContent('$1,000.00')
    expect(note).toHaveTextContent(/still includes it/i)
    // The status badge is untouched: "approved" is still the truth.
    const row = note.closest('tr')
    expect(within(row).getByText('approved')).toBeInTheDocument()
    // And the note is not inside the badge.
    expect(within(row).getByText('approved').contains(note)).toBe(false)
  })

  it('CONTROL: a row with the string "0" / "0" shows no marker', async () => {
    routes([base(8, { open_adjustment_count: '0', open_adjustment_amount: '0' })])
    mount()
    await screen.findByText('approved')
    expect(screen.queryByTestId('open-adjustment-8')).toBeNull()
    expect(screen.queryByText(MARKER)).toBeNull()
  })

  it('CONTROL: a row with the fields absent (older server) shows no marker', async () => {
    routes([base(9)])
    mount()
    await screen.findByText('approved')
    expect(screen.queryByTestId('open-adjustment-9')).toBeNull()
    expect(screen.queryByText(MARKER)).toBeNull()
  })

  it('two unresolved refunds say refunds, not gifts', async () => {
    routes([base(13, { open_adjustment_count: '2', open_adjustment_amount: '50.00' })])
    mount()
    const note = await screen.findByTestId('open-adjustment-13')
    expect(note).toHaveTextContent(/across 2 refunds/i)
    expect(note).not.toHaveTextContent(/gifts/i)
  })

  it('the parish view never contains the word "settled"', async () => {
    routes([
      base(10, { open_adjustment_count: '1', open_adjustment_amount: '1000.00' }),
      base(11, { open_adjustment_count: '0', open_adjustment_amount: '0' }),
      base(12),
    ])
    const { container } = mount()
    await screen.findByTestId('open-adjustment-10')
    expect(container.textContent).not.toMatch(/settled/i)
  })

  it('a recorded credit names the payable amount and keeps the approved figure on file', async () => {
    routes([base(14, {
      open_adjustment_count: '0',
      open_adjustment_amount: '0',
      applied_credit_count: '1',
      applied_credit_amount: '125.00',
      payable_base: '1125.00',
    })])
    mount()
    const note = await screen.findByTestId('applied-credit-14')
    expect(note).toHaveTextContent(/credit recorded/i)
    expect(note).toHaveTextContent(/approved figure stays on file/i)
    expect(note).toHaveTextContent('$1,125.00')
    expect(note).not.toHaveTextContent(/settled/i)
  })
})
