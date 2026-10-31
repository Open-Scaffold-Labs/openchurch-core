// SP-167 on the full profile: no Edit Member and no Get Calendar Link for a
// Viewer (already true at 1e0a8527; this pins it). Staff keep the link.
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
const ok = (b) => ({ ok: true, status: 200, json: async () => b })
beforeEach(() => {
  vi.unstubAllGlobals()
  vi.stubGlobal('fetch', vi.fn(async (url) => String(url).endsWith('/api/clients/7')
    ? ok({ id: 7, name: 'Eleanor Synthetic', status: 'active' })
    : ok({ lines: [], records: [], entries: [], checkins: [], pledges: [], dates: [], unavailability: [] })))
})
const mount = () => render(
  <MemoryRouter initialEntries={['/clients/7']}>
    <LocaleProvider><ToastProvider><ConfirmProvider>
      <Routes><Route path="/clients/:id" element={<MemberDetail />} /></Routes>
    </ConfirmProvider></ToastProvider></LocaleProvider>
  </MemoryRouter>)

describe('member profile actions by role (SP-167)', () => {
  it('Viewer: no Edit Member, no Get Calendar Link', async () => {
    auth.role = 'viewer'; mount()
    await screen.findByRole('heading', { name: 'Eleanor Synthetic' })
    expect(screen.queryByText(/Edit Member/)).toBeNull()
    expect(screen.queryByText('Get Calendar Link')).toBeNull()
  })
  it('Staff: Get Calendar Link shown', async () => {
    auth.role = 'staff'; mount()
    await screen.findByRole('heading', { name: 'Eleanor Synthetic' })
    expect(await screen.findByText('Get Calendar Link')).toBeTruthy()
  })
})
