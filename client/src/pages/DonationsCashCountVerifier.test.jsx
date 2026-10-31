// R357-1 — a pending cash count saved without a second counter can have
// one recorded from its row, and Confirm sends it to the server.
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

let PENDING
const BASE = { id: 77, status: 'pending', service_name: 'Vigil Count', service_date: '2031-06-15',
  category: 'offertory', counted_by: 'Margaret', verified_by: null, total: '40.00' }
const ok = (b) => ({ ok: true, status: 200, json: async () => b })
let calls
const stubFetch = (verified_by = null) => {
  PENDING = { ...BASE, verified_by }
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const u = String(url)
    calls.push({ u, init })
    if (u.includes('/confirm')) return ok({ session: { ...PENDING, status: 'confirmed', verified_by: 'Joseph' }, donation: {} })
    if (u.includes('/api/donations/cash-counts')) return ok([PENDING])
    if (u.includes('/api/donations/recurring')) return ok({ recurring: [] })
    if (u.includes('/api/donations/summary')) return ok({ summary: null })
    if (u.includes('/api/donations/by-fund')) return ok({ funds: [] })
    if (u.includes('/api/donations')) return ok([])
    return ok({})
  }))
}
const view = () => render(
  <MemoryRouter initialEntries={['/donations']}>
    <LocaleProvider><ToastProvider><ConfirmProvider>
      <Donations />
    </ConfirmProvider></ToastProvider></LocaleProvider>
  </MemoryRouter>
)
beforeEach(() => { vi.unstubAllGlobals() })

describe('R357-1 pending cash count verifier', () => {
  it('records a second counter on a pending count and sends it with Confirm', async () => {
    stubFetch()
    view()
    const input = await screen.findByLabelText('Second counter for Vigil Count', {}, { timeout: 4000 })
    fireEvent.change(input, { target: { value: 'Joseph' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(calls.some(c => c.u.includes('/cash-counts/77/confirm'))).toBe(true))
    const c = calls.find(c => c.u.includes('/cash-counts/77/confirm'))
    expect(c.init.method).toBe('PATCH')
    expect(JSON.parse(c.init.body)).toEqual({ verified_by: 'Joseph' })
  })

  it('R357-2: clearing a prefilled second counter sends an explicit empty value', async () => {
    stubFetch('Joseph')
    view()
    const input = await screen.findByLabelText('Second counter for Vigil Count', {}, { timeout: 4000 })
    expect(input).toHaveValue('Joseph')
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(calls.some(c => c.u.includes('/cash-counts/77/confirm'))).toBe(true))
    const c = calls.find(c => c.u.includes('/cash-counts/77/confirm'))
    expect(JSON.parse(c.init.body)).toEqual({ verified_by: '' })
  })
})
