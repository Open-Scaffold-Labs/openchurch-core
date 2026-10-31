// Check-in: the liturgical chip for the selected service printed the stored
// English token, so a Spanish parish read "Lent" for Cuaresma. It now goes
// through seasonLabel, like the Sacristy List and Schedule. A feast name
// still wins, and an unknown token passes through. jsdom only.

import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { LocaleProvider } from '../i18n'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import Checkin from './Checkin'

let ORG = { id: 1, name: 'St Test', locale: 'en' }
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Admin', role: 'admin', organization: ORG },
    token: 'test-token', loading: false, isAdmin: false, canWrite: true,
  }),
}))

const today = new Date().toISOString().slice(0, 10)
let SERVICE
const ok = b => ({ ok: true, status: 200, json: async () => b })

beforeEach(() => {
  vi.unstubAllGlobals()
  try { localStorage.clear() } catch { /* jsdom */ }
  ORG = { id: 1, name: 'St Test', locale: 'en' }
  SERVICE = { id: 18, title: 'Mass TODAY', date: today, start_time: '10:30', end_time: '11:45', type: 'service',
    liturgical_season: 'Lent', liturgical_color: 'Purple', feast_name: null }
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    if (u.includes('/api/calendar?')) return ok([SERVICE])
    if (u.includes('/api/clients')) return ok([])
    if (u.includes('/api/rooms')) return ok({ rooms: [] })
    if (u.includes('/api/checkins/recent')) return ok({ services: [] })
    if (u.includes('/api/checkins')) return ok({ checkins: [], present: 0 })
    return ok({})
  }))
})

const view = () => render(
  <MemoryRouter initialEntries={['/checkin']}>
    <LocaleProvider><ToastProvider><ConfirmProvider>
      <Checkin />
    </ConfirmProvider></ToastProvider></LocaleProvider>
  </MemoryRouter>
)

describe('Check-in liturgical chip', () => {
  it('CONTROL: an English parish reads Lent', async () => {
    view()
    expect(await screen.findByText('Lent', {}, { timeout: 4000 })).toBeInTheDocument()
  })
  it('a Spanish parish reads Cuaresma, not the English token', async () => {
    ORG = { ...ORG, locale: 'es' }
    view()
    expect(await screen.findByText('Cuaresma', {}, { timeout: 4000 })).toBeInTheDocument()
    expect(screen.queryByText('Lent')).not.toBeInTheDocument()
  })
  it('a feast name still wins over the season', async () => {
    ORG = { ...ORG, locale: 'es' }
    SERVICE = { ...SERVICE, feast_name: 'Ash Wednesday' }
    view()
    expect(await screen.findByText('Ash Wednesday', {}, { timeout: 4000 })).toBeInTheDocument()
  })
  it('an unknown season token passes through unchanged', async () => {
    ORG = { ...ORG, locale: 'es' }
    SERVICE = { ...SERVICE, liturgical_season: 'Parish Jubilee' }
    view()
    expect(await screen.findByText('Parish Jubilee', {}, { timeout: 4000 })).toBeInTheDocument()
  })
})
