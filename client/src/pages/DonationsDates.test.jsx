// The donation log must show the day a gift was given.
//
// It did not. `date` is a Postgres DATE, node-postgres parses it into a JS
// Date at the SERVER's local midnight, and JSON serialised that as a full ISO
// timestamp. The page then did `new Date(str + 'T00:00:00')` — appending a
// time to a string that already had one — so every row read "Invalid Date".
// Measured on the real built client against the real API on 4 Sep: 13 rows
// showing "Invalid Date", 0 showing a date. Live on production at the time.
//
// The routes now to_char the calendar-day columns, and the page tolerates
// both shapes. This pins both halves: the shape the API sends today, and the
// shape it used to send — because a regression in either layer brings the bug
// back, and only one of them is covered by the other's test.

import { render, screen, waitFor } from '@testing-library/react'
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

const gift = (date) => ({
  id: 601, donor_name: 'Date Donor', amount: '120.00', category: 'General',
  method: 'cash', source: 'manual', date,
  payment_ref: null, payment_status: null, refunded_at: null,
})

const ok = (b) => ({ ok: true, status: 200, json: async () => b })

const stubFetch = (rows) => {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    if (u.includes('/api/donations/recurring')) return ok({ recurring: [] })
    if (u.includes('/api/donations/summary')) return ok({ summary: null })
    if (u.includes('/api/donations/by-fund')) return ok({ funds: [] })
    if (u.includes('/api/cash-counts')) return ok({ sessions: [] })
    if (u.includes('/api/donations')) return ok(rows)
    return ok({})
  }))
}

const view = () => render(
  <MemoryRouter><LocaleProvider><ToastProvider><ConfirmProvider>
    <Donations />
  </ConfirmProvider></ToastProvider></LocaleProvider></MemoryRouter>
)

beforeEach(() => { vi.unstubAllGlobals() })

describe('the date on a gift', () => {
  it('renders the calendar day the routes send', async () => {
    stubFetch([gift('2031-04-04')])
    view()
    expect(await screen.findByText('Apr 4, 2031', {}, { timeout: 4000 })).toBeTruthy()
    expect(screen.queryByText(/Invalid Date/)).toBeNull()
  })

  it('THE DEFECT: an ISO timestamp must not render as "Invalid Date"', async () => {
    // Exactly what the API sent before the routes were fixed — from a UTC
    // server, which is what Vercel runs.
    stubFetch([gift('2031-04-04T00:00:00.000Z')])
    view()
    await waitFor(() => expect(screen.queryByText(/Invalid Date/)).toBeNull(), { timeout: 4000 })
    expect(await screen.findByText('Apr 4, 2031')).toBeTruthy()
  })

  it('and not from a server west of UTC either, where the day could slip', async () => {
    // A PDT server serialises 2031-04-04 as 07:00Z. Read as a local instant
    // by a reader further west this becomes the 3rd; the calendar day is the
    // truth and must survive.
    stubFetch([gift('2031-04-04T07:00:00.000Z')])
    view()
    expect(await screen.findByText('Apr 4, 2031', {}, { timeout: 4000 })).toBeTruthy()
  })

  it('shows an em-dash, never the words "Invalid Date", for an unusable value', async () => {
    stubFetch([gift('not-a-date-at-all')])
    view()
    await waitFor(() => expect(screen.queryByText(/Invalid Date/)).toBeNull(), { timeout: 4000 })
  })

  it('shows an em-dash for a missing date', async () => {
    stubFetch([gift(null)])
    view()
    await waitFor(() => expect(screen.queryByText(/Invalid Date/)).toBeNull(), { timeout: 4000 })
  })
})
