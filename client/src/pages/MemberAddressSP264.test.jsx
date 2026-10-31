// SP-264: mailing address on slide-over + profile (print uses the profile Contact block).
// SP-265: Full Name has a real accessible name (not only the placeholder).
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import Clients from './Clients'
import MemberDetail from './MemberDetail'

const auth = vi.hoisted(() => ({ role: 'admin' }))
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'U', role: auth.role, organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 't', loading: false, canWrite: auth.role !== 'viewer', isAdmin: auth.role === 'admin',
  }),
}))

const MEMBER = {
  id: 501,
  name: 'Address Probe Synthetic',
  email: 'address.probe@example.invalid',
  phone: '(555) 010-9999',
  company: 'Probe family',
  status: 'active',
  role: 'Member',
  tags: '',
  notes: 'staff-only note',
  birth_date: '1990-03-14',
  mailing_address_line1: '789 Edited Probe Road',
  mailing_city: 'San Jose',
  mailing_state: 'CA',
  mailing_postal: '95112',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
}

const ok = (b) => ({ ok: true, status: 200, json: async () => b })

beforeEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  auth.role = 'admin'
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    if (u.includes('/api/clients/stats')) return ok({ total: 1, newWeek: 0, active: 1, growth: 0 })
    if (u.includes('/api/clients/501/donations')) return ok({ by: 'email', lines: [], total: 0, gift_count: 0 })
    if (u.includes('/api/clients/501/checkins')) return ok({ checkins: [], count: 0 })
    if (u.includes('/api/liturgical')) return ok({})
    if (u.match(/\/api\/clients\/501\b/)) return ok(MEMBER)
    if (u.includes('/api/clients/duplicate-check')) return ok({ matches: [] })
    if (u.includes('/api/clients?') || u.endsWith('/api/clients')) return ok([MEMBER])
    return ok([])
  }))
})

function wrap(ui, path = '/clients') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <LocaleProvider>
        <ToastProvider>
          <ConfirmProvider>{ui}</ConfirmProvider>
        </ToastProvider>
      </LocaleProvider>
    </MemoryRouter>,
  )
}

describe('SP-264 mailing address visibility', () => {
  it.each(['admin', 'staff', 'viewer'])('%s slide-over shows mailing address with other contact fields', async (role) => {
    auth.role = role
    wrap(<Clients />)
    const cells = await screen.findAllByText('Address Probe Synthetic')
    fireEvent.click(cells[0])
    await screen.findByTestId('member-slide-contact')
    const contact = screen.getByTestId('member-slide-contact')
    const addr = await screen.findByTestId('member-mailing-address')
    expect(contact).toContainElement(addr)
    expect(addr).toHaveTextContent('789 Edited Probe Road')
    expect(addr).toHaveTextContent('San Jose, CA 95112')
    expect(contact).toHaveTextContent('address.probe@example.invalid')
  })

  it('profile Contact shows mailing address (print reads this block)', async () => {
    wrap(
      <Routes>
        <Route path="/clients/:id" element={<MemberDetail />} />
      </Routes>,
      '/clients/501',
    )
    await screen.findByTestId('member-profile-contact')
    const addr = await screen.findByTestId('member-mailing-address')
    expect(addr).toHaveTextContent('789 Edited Probe Road')
    expect(addr).toHaveTextContent('San Jose, CA 95112')
  })
})

describe('SP-265 Full Name accessible label', () => {
  it('Add Member Full Name is findable by accessible name, not only placeholder', async () => {
    wrap(<Clients />)
    const add = await screen.findByRole('button', { name: /Add member|Add Member|Add new/i })
    fireEvent.click(add)
    const nameInput = await screen.findByLabelText(/Full Name/i)
    expect(nameInput).toBeTruthy()
    // Accessible name must be the field label, not the example placeholder.
    expect(nameInput.getAttribute('aria-label')).toBe('Full Name')
    expect(nameInput).toHaveAttribute('id', 'mem-full-name')
  })
})
