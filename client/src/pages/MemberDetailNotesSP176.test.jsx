// SP-176: a Viewer's member profile never renders private notes, even if a
// stale row still carries them; staff still see them. Birthday shows from
// birth_month_day (no year) for Viewers.
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import MemberDetail from './MemberDetail'

const auth = vi.hoisted(() => ({ role: 'viewer' }))
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'U', role: auth.role, organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 't', loading: false, canWrite: auth.role !== 'viewer',
  }),
}))

const NOTE = 'Synthetic pastoral note SP176'
const ok = (b) => ({ ok: true, status: 200, json: async () => b })
const Shell = () => (
  <MemoryRouter initialEntries={['/clients/7']}>
    <LocaleProvider><ToastProvider><ConfirmProvider>
      <Routes><Route path="/clients/:id" element={<MemberDetail />} /></Routes>
    </ConfirmProvider></ToastProvider></LocaleProvider>
  </MemoryRouter>
)
function stub(member) {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    if (u.endsWith('/api/clients/7')) return ok(member)
    return ok({ lines: [], records: [], entries: [], checkins: [], pledges: [], dates: [], unavailability: [] })
  }))
}
beforeEach(() => vi.unstubAllGlobals())

describe('SP-176 notes gate on the member profile', () => {
  it('Viewer: notes hidden even if present; birthday month-day shown', async () => {
    auth.role = 'viewer'
    stub({ id: 7, name: 'Eleanor Synthetic', status: 'active', notes: NOTE, birth_month_day: '03-17' })
    render(<Shell />)
    await screen.findByRole('heading', { name: 'Eleanor Synthetic' })
    expect(screen.queryByText(NOTE)).toBeNull()
    expect(screen.getByText(/March 17/)).toBeTruthy()
  })
  it('Staff: notes shown', async () => {
    auth.role = 'staff'
    stub({ id: 7, name: 'Eleanor Synthetic', status: 'active', notes: NOTE, birth_date: '1948-03-17' })
    render(<Shell />)
    await screen.findByRole('heading', { name: 'Eleanor Synthetic' })
    expect(await screen.findByText(NOTE)).toBeTruthy()
  })
})
