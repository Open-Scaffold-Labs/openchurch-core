// Batch 2, the money page. (Pass 8 §14–§15)
//
// Payroll is the page that tells a parish what it owes people, and it was
// the clearest FAILED → ZERO in the app: three requests rode one
// Promise.all with `r.ok ? r.json() : []` on each and a bare `catch {}`
// around the lot, and fmtCurrency did `Number(n ?? 0)`. So a failed read
// printed "$0.00" and "0 shifts logged" — in silence.
//
// Finance's tiles already dashed an unknown value (Pass 7). These did not.
// The control that matters is the same: a genuinely empty week must stay a
// calm $0.00.

import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import Payroll from './Payroll'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Treasurer', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 't', loading: false,
  }),
}))

// A real week with no shifts. Every figure is a reported zero.
const TRUE_ZERO = { total_payroll: 0, total_hours: 0, shift_count: 0, staff_count: 2 }
const WITH_WORK = { total_payroll: 1240.5, total_hours: 62, shift_count: 9, staff_count: 3 }
const STAFF = [{ id: 1, name: 'Ana Probe', role: 'Sacristan', pay_rate: 20, status: 'active' }]

const ok  = (b) => ({ ok: true,  status: 200, json: async () => b })
const err = (s) => ({ ok: false, status: s, json: async () => ({ error: 'boom' }) })

const routes = (over = {}) => vi.stubGlobal('fetch', vi.fn(async (url) => {
  const u = String(url)
  for (const [frag, h] of Object.entries(over)) if (u.includes(frag)) return h()
  if (u.includes('/payroll/summary')) return ok(TRUE_ZERO)
  if (u.includes('/payroll/staff'))   return ok(STAFF)
  if (u.includes('/payroll/shifts'))  return ok([])
  return ok({})
}))

const mount = () => render(
  <MemoryRouter><LocaleProvider><ToastProvider><ConfirmProvider>
    <Payroll />
  </ConfirmProvider></ToastProvider></LocaleProvider></MemoryRouter>
)

const UNREAD = /couldn'?t be read/i

beforeEach(() => vi.unstubAllGlobals())

describe('CONTROL — a real zero week', () => {
  it('shows $0.00 and 0 shifts, with no warning attached', async () => {
    routes(); mount()
    expect(await screen.findByText('$0.00')).toBeInTheDocument()
    expect(screen.getByText(/0 shifts logged/)).toBeInTheDocument()
    expect(screen.queryByText(UNREAD)).not.toBeInTheDocument()
  })

  it('a week with work shows the figures', async () => {
    routes({ '/payroll/summary': () => ok(WITH_WORK) }); mount()
    expect(await screen.findByText('$1,240.50')).toBeInTheDocument()
    expect(screen.getByText(/9 shifts logged/)).toBeInTheDocument()
    expect(screen.queryByText(UNREAD)).not.toBeInTheDocument()
  })
})

describe('FAILED must never become ZERO', () => {
  it('an unread payroll total is a dash, not $0.00', async () => {
    routes({ '/payroll/summary': () => err(500) }); mount()
    await waitFor(() => expect(screen.getAllByText(UNREAD).length).toBeGreaterThan(0))
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument()
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
  })

  it('an unread shift count does not read as zero shifts', async () => {
    routes({ '/payroll/summary': () => err(500) }); mount()
    await waitFor(() => expect(screen.getAllByText(UNREAD).length).toBeGreaterThan(0))
    expect(screen.queryByText(/0 shifts logged/)).not.toBeInTheDocument()
    expect(screen.getByText(/shifts unknown/i)).toBeInTheDocument()
  })

  it('a failed shift list does not claim the week had no work', async () => {
    routes({ '/payroll/shifts': () => err(500) }); mount()
    await waitFor(() => expect(screen.getAllByText(UNREAD).length).toBeGreaterThan(0))
  })
})

describe('PARTIAL failure', () => {
  it('a failed summary leaves the staff roster readable', async () => {
    routes({ '/payroll/summary': () => err(500) }); mount()
    await waitFor(() => expect(screen.getAllByText(UNREAD).length).toBeGreaterThan(0))
    expect(screen.getByText('Ana Probe')).toBeInTheDocument()
  })
})

describe('RETRY', () => {
  it('recovers the totals in place', async () => {
    let call = 0
    routes({ '/payroll/summary': () => (++call === 1 ? err(500) : ok(WITH_WORK)) })
    mount()
    await waitFor(() => expect(screen.getAllByText(UNREAD).length).toBeGreaterThan(0))
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: /try again/i })[0]) })
    await waitFor(() => expect(screen.getByText('$1,240.50')).toBeInTheDocument())
  })
})
