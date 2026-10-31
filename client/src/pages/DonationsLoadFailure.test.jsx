// A refused or failed read on the Donations page used to leave its lists at
// []: the log said "No donations yet" with "0 records", the trend said "No
// giving data yet", pending cash counts and recurring gifts vanished, and a
// failed "Load more" did nothing at all. FAILED is not ZERO.

import { render, screen, fireEvent, waitFor } from '@testing-library/react'
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

const ok = (body) => ({ ok: true, status: 200, json: async () => body })
const refused = () => ({ ok: false, status: 500, json: async () => ({ error: 'no' }) })

const gift = (i) => ({
  id: i, donor_name: `Donor ${i}`, amount: '10.00', category: 'tithe',
  date: '2026-10-01', method: 'cash',
})

function stub(over = {}) {
  const routes = {
    list: ok([]), summary: ok({ donor_count: 0, total: 0 }), cash: ok([]),
    byFund: ok({ funds: [] }), recurring: ok({ recurring: [], needs_attention: [] }),
    page2: ok([]), ...over,
  }
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    if (u.includes('/api/funds')) return ok({ funds: [], provider: 'stub' })
    if (u.includes('/api/donations/recurring')) return routes.recurring
    if (u.includes('/api/donations/summary')) return routes.summary
    if (u.includes('/api/donations/by-fund')) return routes.byFund
    if (u.includes('/api/donations/cash-counts')) return routes.cash
    if (u.includes('/api/donations') && u.includes('offset=50')) {
      if (routes.page2 instanceof Error) throw routes.page2
      return routes.page2
    }
    if (u.includes('/api/donations')) {
      if (routes.list instanceof Error) throw routes.list
      return routes.list
    }
    return ok({})
  }))
}

function mount() {
  return render(
    <MemoryRouter initialEntries={['/donations']}>
      <LocaleProvider>
        <ToastProvider>
          <ConfirmProvider>
            <Donations />
          </ConfirmProvider>
        </ToastProvider>
      </LocaleProvider>
    </MemoryRouter>
  )
}

beforeEach(() => { localStorage.clear(); vi.unstubAllGlobals() })

describe('Donations page read failures', () => {
  it('a refused donation list says it did not load, not "No donations yet"', async () => {
    stub({ list: refused() })
    mount()
    expect(await screen.findByText("The donation log didn't load")).toBeTruthy()
    expect(screen.queryByText('No donations yet')).toBeNull()
    expect(screen.queryByText('0 records')).toBeNull()
    expect(screen.getByText("Giving trends didn't load")).toBeTruthy()
    expect(screen.queryByText('No giving data yet')).toBeNull()
  })

  it('a network error says every section did not load', async () => {
    stub({ list: new Error('offline') })
    mount()
    expect(await screen.findByText("The donation log didn't load")).toBeTruthy()
    expect(screen.getByText(/Couldn't load cash count sessions, giving by fund, recurring gifts/)).toBeTruthy()
    expect(screen.getByText(/These totals didn't load/)).toBeTruthy()
  })

  it('refused cash counts and recurring gifts are named, not silently dropped', async () => {
    stub({ cash: refused(), recurring: refused() })
    mount()
    expect(await screen.findByText(/Couldn't load cash count sessions, recurring gifts\./)).toBeTruthy()
    expect(screen.getByText('No donations yet')).toBeTruthy()
  })

  it('a failed "Load more" says so', async () => {
    stub({ list: ok(Array.from({ length: 50 }, (_, i) => gift(i + 1))), page2: refused() })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }))
    expect(await screen.findByText(/The next page of gifts didn't load/)).toBeTruthy()
  })

  it('control: a parish with no gifts still reads "No donations yet" and no failure notice', async () => {
    stub()
    mount()
    expect(await screen.findByText('No donations yet')).toBeTruthy()
    expect(screen.getByText('0 records')).toBeTruthy()
    expect(screen.queryByText(/Couldn't load/)).toBeNull()
    expect(screen.queryByText("The donation log didn't load")).toBeNull()
  })
})
