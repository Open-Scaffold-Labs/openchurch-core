// Stage 7 CK-4: the child-release dialog and checkout failures speak the
// parish's language, and a refused release says the child is still here.
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { LocaleProvider } from '../i18n'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import Checkin from './Checkin'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Admin', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 'test-token', loading: false, isAdmin: false, canWrite: true,
  }),
}))

const today = new Date().toISOString().slice(0, 10)
const EVENT = { id: 17, title: 'Mass TODAY', date: today, start_time: '10:30', end_time: '11:45', type: 'service' }
const CHILD = { id: 9, calendar_event_id: 17, client_id: null, person_name: 'Synthetic Child', kind: 'child', checked_in_at: '2026-10-15T17:30:00Z', checked_out_at: null }
const ok = b => ({ ok: true, status: 200, json: async () => b })

function stub(checkoutStatus) {
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const u = String(url)
    if (u.includes('/checkout')) return { ok: false, status: checkoutStatus, json: async () => ({ error: 'English server sentence' }) }
    if (/\/api\/calendar\/\d+/.test(u)) return ok(EVENT)
    if (u.includes('/api/calendar?')) return ok([EVENT])
    if (u.includes('/api/clients')) return ok([])
    if (u.includes('/api/rooms')) return ok({ rooms: [] })
    if (u.includes('/api/checkins/recent')) return ok({ services: [] })
    if (u.includes('/api/checkins')) return ok({ checkins: [CHILD], present: 1 })
    return ok({})
  }))
}
const view = () => render(
  <MemoryRouter initialEntries={['/checkin?event=17']}>
    <LocaleProvider><ToastProvider><ConfirmProvider><Checkin /></ConfirmProvider></ToastProvider></LocaleProvider>
  </MemoryRouter>)

async function release(outLabel, codeLabel, confirmLabel, title) {
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(outLabel) }, { timeout: 4000 }))
  expect((await screen.findAllByText(title)).length).toBeGreaterThan(0)
  fireEvent.change(await screen.findByLabelText(codeLabel), { target: { value: 'ZZZZ' } })
  fireEvent.click(screen.getByRole('button', { name: confirmLabel }))
}

beforeEach(() => { vi.unstubAllGlobals(); localStorage.clear() })
afterEach(() => localStorage.clear())

describe('child release copy', () => {
  it('Spanish: dialog and a mismatched code are in Spanish, not the server sentence', async () => {
    localStorage.setItem('ochr_locale', 'es')
    stub(403)
    view()
    await release('Salida', 'Código de recogida', 'Entregar al niño', /Entregar a Synthetic Child/)
    await waitFor(() => expect(screen.getByText('Ese código de recogida no coincide. El niño sigue registrado.')).toBeTruthy())
    expect(screen.queryByText('English server sentence')).toBeNull()
  })

  it('English: a server failure says nobody was released', async () => {
    stub(500)
    view()
    await release('Out', 'Pickup code', 'Release child', /Release Synthetic Child/)
    await waitFor(() => expect(screen.getByText('Check-out failed. Nobody was released; please try again.')).toBeTruthy())
  })
})
