// SP-059: "Next on the Calendar" said "Nothing scheduled yet." while a
// Sunday Mass sat on the Schedule. It read /api/events (the separate events
// log, oldest first, capped) instead of the calendar, and a refused read
// rendered as the empty state. It now reads /api/calendar from today forward
// and a refused read says it did not load.

import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import Dashboard from './Dashboard'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Ada Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    loading: false,
    canWrite: true,
  }),
}))

const ok = (body) => ({ ok: true, status: 200, json: async () => body })
const refused = () => ({ ok: false, status: 500, json: async () => ({ error: 'no' }) })
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const inDays = n => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d) }

const MASS = { id: 41, title: 'Sunday Mass (synthetic)', date: inDays(2), start_time: '11:30:00', end_time: '12:30:00', type: 'mass' }
// 200 past rows from the events log: the shape the old widget read.
const OLD_LOG = Array.from({ length: 200 }, (_, i) => ({ id: 1000 + i, title: `Old log ${i}`, date: '2025-01-01', time: '09:00:00' }))

function stub({ upcoming, eventsLog = OLD_LOG, locale } = {}) {
  if (locale) localStorage.setItem('ochr_locale', locale)
  const calls = []
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    calls.push(u)
    if (u.includes('/api/tasks/stats')) return ok({ total: 0, completed: 0, pending: 0, in_progress: 0, high_pending: 0 })
    if (u.includes('/api/clients/stats')) return ok({ total: 0, active: 0, newWeek: 0 })
    if (u.includes('/api/calendar') && u.includes('limit=3')) return upcoming === 'refused' ? refused() : ok(upcoming)
    if (u.includes('/api/calendar')) return ok([])
    if (u.includes('/api/events')) return ok(eventsLog)
    if (u.includes('/api/schedule') || u.includes('/api/tasks')) return ok([])
    if (u.includes('/api/sacraments/anniversaries')) return ok({ anniversaries: [] })
    if (u.includes('/api/checklists/today')) return ok({ runs: [] })
    if (u.includes('/api/clients')) return ok([])
    if (u.includes('/api/liturgical')) return ok(null)
    return ok({})
  }))
  return calls
}

function mount() {
  return render(
    <MemoryRouter>
      <LocaleProvider>
        <ToastProvider>
          <ConfirmProvider>
            <Dashboard />
          </ConfirmProvider>
        </ToastProvider>
      </LocaleProvider>
    </MemoryRouter>
  )
}

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('Next on the Calendar reads the calendar (SP-059)', () => {
  it('shows the upcoming Mass from the calendar, not "Nothing scheduled yet."', async () => {
    const calls = stub({ upcoming: [MASS] })
    mount()
    expect(await screen.findByText(MASS.title)).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['noc.empty'])).not.toBeInTheDocument()
    const q = calls.find(u => u.includes('/api/calendar') && u.includes('limit=3'))
    expect(q).toContain(`start=${inDays(0)}`)
  })

  it('a refused calendar read says it did not load, never "Nothing scheduled yet."', async () => {
    stub({ upcoming: 'refused' })
    mount()
    const alert = await screen.findByText(STRINGS.en['noc.unread'])
    expect(alert).toHaveAttribute('role', 'alert')
    expect(screen.queryByText(STRINGS.en['noc.empty'])).not.toBeInTheDocument()
  })

  it('says the same in Spanish', async () => {
    stub({ upcoming: 'refused', locale: 'es' })
    mount()
    expect(await screen.findByText(STRINGS.es['noc.unread'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.es['noc.empty'])).not.toBeInTheDocument()
  })

  it('CONTROL: a genuinely empty calendar still says "Nothing scheduled yet."', async () => {
    stub({ upcoming: [], eventsLog: [] })
    mount()
    expect(await screen.findByText(STRINGS.en['noc.empty'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['noc.unread'])).not.toBeInTheDocument()
  })
})
