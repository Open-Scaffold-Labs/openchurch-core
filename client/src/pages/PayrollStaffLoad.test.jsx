// The roster is the third read on the money page, and the one that was
// missed. (C2)
//
// Summary and shifts learned to say "couldn't be read" in Pass 8. Staff did
// not: `const staff = staffLoad.data ?? []` with no look at `staffLoad.state`
// meant a 500 on /api/payroll/staff rendered "No staff yet — Add your first
// staff member" beneath summary tiles that were showing real money. A
// treasurer reading that would conclude the roster had been wiped.

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
    token: 't', loading: false, canWrite: true,
  }),
}))

const WITH_WORK = { total_payroll: 1240.5, total_hours: 62, shift_count: 9, staff_count: 3 }
const STAFF = [{ id: 1, name: 'Ana Probe', role: 'Sacristan', pay_rate: 20, status: 'active' }]

const ok  = (b) => ({ ok: true,  status: 200, json: async () => b })
const err = (s) => ({ ok: false, status: s, json: async () => ({ error: 'boom' }) })

const routes = (over = {}) => vi.stubGlobal('fetch', vi.fn(async (url) => {
  const u = String(url)
  for (const [frag, h] of Object.entries(over)) if (u.includes(frag)) return h()
  if (u.includes('/payroll/summary')) return ok(WITH_WORK)
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

describe('a staff roster that could not be read', () => {
  it('is said to be unread — never "No staff yet"', async () => {
    routes({ '/payroll/staff': () => err(500) }); mount()
    // The money still shows; the roster beneath it must not invent a blank.
    expect(await screen.findByText('$1,240.50')).toBeInTheDocument()
    await waitFor(() => expect(screen.getAllByText(UNREAD).length).toBeGreaterThan(0))
    expect(screen.queryByText(/no staff yet/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/add your first staff member/i)).not.toBeInTheDocument()
  })

  it('CONTROL — an empty roster from a successful read is "No staff yet"', async () => {
    routes({ '/payroll/staff': () => ok([]) }); mount()
    expect(await screen.findByText(/no staff yet/i)).toBeInTheDocument()
    expect(screen.queryByText(UNREAD)).not.toBeInTheDocument()
  })

  it('recovers the roster in place on retry', async () => {
    let call = 0
    routes({ '/payroll/staff': () => (++call === 1 ? err(500) : ok(STAFF)) }); mount()
    await waitFor(() => expect(screen.getAllByText(UNREAD).length).toBeGreaterThan(0))
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: /try again/i })[0]) })
    expect(await screen.findByText('Ana Probe')).toBeInTheDocument()
    expect(screen.queryByText(UNREAD)).not.toBeInTheDocument()
  })
})
