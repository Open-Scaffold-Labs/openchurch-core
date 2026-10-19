// Schedule → Sunday Packet hop + Intentions weekly-sheet subtitle.
// The first-visit demo failure: Schedule had no Print. Serving print
// already lives at /packet; this asserts the week chrome points at
// `/packet?date=YYYY-MM-DD` for the Sunday of the visible week, and
// that Intentions still opens `/mass-intentions/print`.

import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import Schedule from './Schedule'
import MassIntentions from './MassIntentions'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const ok = (body) => ({ ok: true, status: 200, json: async () => body })

const stubFetch = () => vi.stubGlobal('fetch', vi.fn(async (url) => {
  const u = String(url)
  if (u.includes('/api/calendar')) return ok([])
  if (u.includes('/api/liturgical/range')) return ok({})
  if (u.includes('/api/mass-intentions/weekly')) return ok({ intentions: [] })
  if (u.includes('/api/mass-intentions')) return ok({ intentions: [] })
  if (u.includes('/api/clients')) return ok([])
  if (u.includes('/api/groups')) return ok({ groups: [] })
  return ok({})
}))

const wrap = (node) => render(
  <MemoryRouter>
    <LocaleProvider>
      <ToastProvider>
        <ConfirmProvider>{node}</ConfirmProvider>
      </ToastProvider>
    </LocaleProvider>
  </MemoryRouter>
)

beforeEach(() => vi.unstubAllGlobals())

describe('Schedule → Sunday Packet hop', () => {
  it('week chrome links to /packet?date=YYYY-MM-DD for the Sunday of the visible week', async () => {
    stubFetch()
    wrap(<Schedule />)
    const link = await screen.findByRole('link', { name: /sunday packet/i })
    const href = link.getAttribute('href')
    expect(href).toMatch(/^\/packet\?date=\d{4}-\d{2}-\d{2}&from=schedule$/)
    const date = new URLSearchParams(href.split('?')[1]).get('date')
    const [y, m, d] = date.split('-').map(Number)
    expect(new Date(y, m - 1, d).getDay()).toBe(0)
    await waitFor(() => expect(screen.queryByText(/opening the week/i)).not.toBeInTheDocument())
  })
})

describe('Intentions weekly sheet', () => {
  it('keeps /mass-intentions/print and shows the sacristy subtitle', async () => {
    stubFetch()
    wrap(<MassIntentions />)
    const link = await screen.findByRole('link', { name: /weekly sheet/i })
    expect(link.getAttribute('href')).toBe('/mass-intentions/print')
    expect(screen.getByTestId('weekly-sheet-not-emailed').textContent).toMatch(/does not email/i)
    expect(screen.getByText(/Sacristy list/i)).toBeInTheDocument()
  })
})

describe('Schedule weekly intentions honesty', () => {
  it('does not treat a failed weekly load as an empty week', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      if (u.includes('/api/calendar')) return ok([])
      if (u.includes('/api/liturgical/range')) return ok({})
      if (u.includes('/api/mass-intentions/weekly')) return { ok: false, status: 500, json: async () => ({}) }
      if (u.includes('/api/clients')) return ok([])
      if (u.includes('/api/groups')) return ok({ groups: [] })
      return ok({})
    }))
    wrap(<Schedule />)
    expect(await screen.findByText(/this week's intentions didn't load/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^retry$/i })).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText(/opening the week/i)).not.toBeInTheDocument())
  })
})

describe('Schedule week chrome language', () => {
  afterEach(() => localStorage.removeItem('ochr_locale'))

  it('shows the empty week in English when the device has no locale override', async () => {
    localStorage.removeItem('ochr_locale')
    stubFetch()
    wrap(<Schedule />)
    expect(await screen.findByRole('heading', { name: 'Schedule' })).toBeInTheDocument()
    expect(await screen.findByText('No events scheduled this week.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Previous week' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add an event' })).toBeInTheDocument()
    const day = screen.getByText(/^No events on /)
    expect(day.textContent).toMatch(/Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday/)
    for (const label of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0)
    }
  })

  it('shows the empty week in Spanish, including the day name', async () => {
    localStorage.setItem('ochr_locale', 'es')
    stubFetch()
    wrap(<Schedule />)
    expect(await screen.findByRole('heading', { name: 'Horario' })).toBeInTheDocument()
    expect(await screen.findByText('No hay eventos programados esta semana.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Semana anterior' })).toBeInTheDocument()
    const day = screen.getByText(/^No hay eventos el /)
    expect(day.textContent).toMatch(/lunes|martes|miércoles|jueves|viernes|sábado|domingo/i)
    expect(day.textContent).not.toMatch(/Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday/)
    for (const label of ['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0)
    }
    expect(screen.queryByText('Mon')).not.toBeInTheDocument()
  })
})
