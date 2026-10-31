// SP-167 / SP-175 (Saint MEM-25, shots 07/08/28): the member slide-over
// offers Edit Member and Get Calendar Link only to roles that can write,
// and Esc closes it. Synthetic members only.
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import Clients from './Clients'

const auth = vi.hoisted(() => ({ role: 'viewer' }))
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'U', role: auth.role, organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 't', loading: false, canWrite: auth.role !== 'viewer', isAdmin: auth.role === 'admin',
  }),
}))

const ok = (b) => ({ ok: true, status: 200, json: async () => b })
const ROSTER = [{ id: 501, name: 'Eleanor Synthetic', status: 'active', role: 'Member', tags: '',
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' }]

beforeEach(() => {
  vi.unstubAllGlobals()
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    if (u.includes('/api/clients/stats')) return ok({ total: 1, newWeek: 0, active: 1, growth: 0 })
    if (u.includes('/api/clients')) return ok(ROSTER)
    return ok([])
  }))
})

async function openPanel(role) {
  auth.role = role
  render(
    <MemoryRouter initialEntries={['/clients']}>
      <LocaleProvider><ToastProvider><ConfirmProvider><Clients /></ConfirmProvider></ToastProvider></LocaleProvider>
    </MemoryRouter>
  )
  const cells = await screen.findAllByText('Eleanor Synthetic')
  fireEvent.click(cells[0])
  await screen.findByText('Open full profile')
}

describe('member slide-over actions by role (SP-167)', () => {
  it('Viewer: no Edit Member, no Get Calendar Link; full profile link stays', async () => {
    await openPanel('viewer')
    expect(screen.queryByRole('button', { name: /Edit Member/ })).toBeNull()
    expect(screen.queryByText('Get Calendar Link')).toBeNull()
    expect(screen.getByText('Open full profile')).toBeTruthy()
  })
  it.each(['staff', 'admin'])('%s: Edit Member and Get Calendar Link shown', async (role) => {
    await openPanel(role)
    expect(screen.getByRole('button', { name: /Edit Member/ })).toBeTruthy()
    expect(screen.getByText('Get Calendar Link')).toBeTruthy()
  })
})

describe('Esc closes the slide-over (SP-175)', () => {
  it.each(['viewer', 'admin'])('%s', async (role) => {
    await openPanel(role)
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByText('Open full profile')).toBeNull())
  })
})
