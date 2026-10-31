// R371-1 (TARS on #371): the SP-118 sideways-scroll hint and the table
// scroll-region names must follow the parish locale, not stay in English.
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import Clients from './Clients'
import Events from './Events'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en', tradition: 'catholic' } },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const ok = body => ({ ok: true, status: 200, json: async () => body })
function stub() {
  vi.stubGlobal('fetch', vi.fn(async url => {
    const u = String(url)
    if (u.includes('/api/clients/stats')) return ok({ total: 1, newWeek: 0, active: 1, growth: 0 })
    if (u.includes('/api/clients')) return ok([{ id: 1, name: 'Synthetic Member', status: 'active', role: 'Member', tags: '' }])
    if (u.includes('/api/events')) return ok([{ id: 2, title: 'Synthetic Event', service_division: '', date: '2026-10-25', time: '10:00', location: '', assigned_members: [] }])
    return ok({})
  }))
}
const mount = Page => render(
  <MemoryRouter><LocaleProvider><ToastProvider><ConfirmProvider><Page /></ConfirmProvider></ToastProvider></LocaleProvider></MemoryRouter>
)

const CASES = [
  ['en', Clients, 'Swipe sideways to see every column →', 'Members table, scrolls sideways'],
  ['es', Clients, 'Desliza hacia los lados para ver todas las columnas →', 'Tabla de miembros, se desplaza hacia los lados'],
  ['en', Events, 'Swipe sideways to see every column →', 'Events table, scrolls sideways'],
  ['es', Events, 'Desliza hacia los lados para ver todas las columnas →', 'Tabla de eventos, se desplaza hacia los lados'],
]

beforeEach(() => { vi.unstubAllGlobals(); localStorage.clear() })

describe('table scroll hint and region name are localized (R371-1)', () => {
  it.each(CASES)('%s %o', async (loc, Page, hint, region) => {
    localStorage.setItem('ochr_locale', loc)
    stub()
    mount(Page)
    expect((await screen.findByTestId('table-scroll-hint')).textContent).toBe(hint)
    expect(screen.getByRole('region', { name: region })).toBeInTheDocument()
  })
})
