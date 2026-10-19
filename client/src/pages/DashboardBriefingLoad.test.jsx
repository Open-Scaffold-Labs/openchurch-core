// A refused read of today's calendar, services, or tasks used to become
// an empty list, and the morning briefing renders an empty list as a
// clear day: "Nothing scheduled today", "No recurring services",
// "All tasks complete". The same substitution told the Events tab
// "No upcoming events" and "No schedule entries yet."

import { render, screen, fireEvent } from '@testing-library/react'
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

const LIST_PATHS = ['/api/events', '/api/schedule', '/api/calendar', '/api/tasks']

function stub({ failLists = false, locale } = {}) {
  if (locale) localStorage.setItem('ochr_locale', locale)
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    if (u.includes('/api/tasks/stats')) return ok({ total: 0, completed: 0, pending: 0, in_progress: 0, high_pending: 0 })
    if (u.includes('/api/clients/stats')) return ok({ total: 0, active: 0, newWeek: 0 })
    if (failLists && LIST_PATHS.some(p => u.includes(p))) return refused()
    if (LIST_PATHS.some(p => u.includes(p))) return ok([])
    if (u.includes('/api/sacraments/anniversaries')) return ok({ anniversaries: [] })
    if (u.includes('/api/checklists/today')) return ok({ runs: [] })
    if (u.includes('/api/clients')) return ok([])
    if (u.includes('/api/liturgical')) return ok(null)
    return ok({})
  }))
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

describe('morning briefing when the day did not load', () => {
  it('does not call a refused day a clear one', async () => {
    const en = STRINGS.en
    stub({ failLists: true })
    mount()
    expect(await screen.findByText(en['dash.eventsUnread'])).toBeInTheDocument()
    expect(screen.getByText(en['dash.tasksUnread'])).toBeInTheDocument()
    expect(screen.getByText(/Today's services did not load/)).toBeInTheDocument()
    expect(screen.queryByText(en['dash.sum.noEvents'])).not.toBeInTheDocument()
    expect(screen.queryByText(en['dash.sum.tasksDone'])).not.toBeInTheDocument()
    expect(screen.queryByText(/No recurring services on /)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: en['dash.tab.events'] }))
    expect(await screen.findByText(en['dash.upcomingUnread'])).toBeInTheDocument()
    expect(screen.getByText(en['dash.weekUnread'])).toBeInTheDocument()
    expect(screen.queryByText('No upcoming events.')).not.toBeInTheDocument()
    expect(screen.queryByText('No schedule entries yet.')).not.toBeInTheDocument()
  })

  it('still names a genuinely quiet day', async () => {
    const en = STRINGS.en
    stub({ failLists: false })
    mount()
    expect(await screen.findByText(en['dash.sum.noEvents'])).toBeInTheDocument()
    expect(screen.getByText(en['dash.sum.tasksDone'])).toBeInTheDocument()
    expect(screen.getByText(/No recurring services on /)).toBeInTheDocument()
    expect(screen.queryByText(en['dash.eventsUnread'])).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: en['dash.tab.events'] }))
    expect(await screen.findByText('No upcoming events.')).toBeInTheDocument()
    expect(screen.getByText('No schedule entries yet.')).toBeInTheDocument()
    expect(screen.queryByText(en['dash.upcomingUnread'])).not.toBeInTheDocument()
    expect(screen.queryByText(en['dash.weekUnread'])).not.toBeInTheDocument()
  })

  it('says the same thing in Spanish when the day did not load', async () => {
    const es = STRINGS.es
    stub({ failLists: true, locale: 'es' })
    mount()
    expect(await screen.findByText(es['dash.eventsUnread'])).toBeInTheDocument()
    expect(screen.getByText(es['dash.tasksUnread'])).toBeInTheDocument()
    expect(screen.queryByText(es['dash.sum.noEvents'])).not.toBeInTheDocument()
  })
})
