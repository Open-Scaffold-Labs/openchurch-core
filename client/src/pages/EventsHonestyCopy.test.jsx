// Events already refuses to paint a failed read as an empty calendar or
// an empty linked-task list. Those sentences were hard-coded English, so
// a Spanish session still heard the English failure. Empty success stays
// the empty sentence — a failure must not borrow it, and an empty book
// must not borrow the failure.

import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import Events from './Events'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en', tradition: 'catholic' } },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const en = STRINGS.en
const es = STRINGS.es
const EVENT = {
  id: 41, title: 'Sunday Parish Event', service_division: 'Worship',
  date: '2026-10-04', time: '10:00', location: 'Nave',
  liturgical_season: null, liturgical_color: null, feast_name: null,
  assigned_members: [],
}
const EMPTY_TASKS = 'No tasks are assigned to the members on this event yet.'
const EMPTY_EVENTS = 'No events yet'

const ok = (body) => ({ ok: true, status: 200, json: async () => body })
const refused = () => ({ ok: false, status: 500, json: async () => ({ error: 'no' }) })

function pageOfEvents() {
  return Array.from({ length: 50 }, (_, i) => ({
    ...EVENT,
    id: i + 1,
    title: `Parish Event ${i + 1}`,
  }))
}

function stub({ events = 'one', tasks = 'empty', members = 'ok', more = 'ok' } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    if (u.includes('/attendance')) return ok({ roster: [] })
    if (u.includes('/tasks')) return tasks === 'fail' ? refused() : ok([])
    if (u.includes('/api/clients')) return members === 'fail' ? refused() : ok([])
    if (u.includes('/api/events')) {
      if (u.includes('offset=') && !u.includes('offset=0')) {
        return more === 'fail' ? refused() : ok([])
      }
      if (events === 'fail') return refused()
      if (events === 'empty') return ok([])
      if (events === 'page') return ok(pageOfEvents())
      return ok([EVENT])
    }
    return ok({})
  }))
}

function mount(locale) {
  if (locale) localStorage.setItem('ochr_locale', locale)
  return render(
    <MemoryRouter>
      <LocaleProvider>
        <ToastProvider>
          <ConfirmProvider>
            <Events />
          </ConfirmProvider>
        </ToastProvider>
      </LocaleProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.removeItem('ochr_locale')
})

afterEach(() => {
  localStorage.removeItem('ochr_locale')
  vi.unstubAllGlobals()
})

describe('Events honesty copy follows the parish language', () => {
  it('a Spanish session hears the calendar failure, not an empty book', async () => {
    stub({ events: 'fail' })
    mount('es')
    expect(await screen.findByText(es['load.failedTitle'])).toBeInTheDocument()
    expect(screen.getByText(es['load.failedBody'])).toBeInTheDocument()
    expect(screen.getByText(es['dash.upcomingUnread'])).toBeInTheDocument()
    expect(screen.getByRole('button', { name: es['error.tryAgain'] })).toBeInTheDocument()
    expect(screen.queryByText(en['load.failedTitle'])).not.toBeInTheDocument()
    expect(screen.queryByText(en['load.failedBody'])).not.toBeInTheDocument()
    expect(screen.queryByText(en['dash.upcomingUnread'])).not.toBeInTheDocument()
    expect(screen.queryByText(EMPTY_EVENTS)).not.toBeInTheDocument()
    expect(screen.queryByText('No events found.')).not.toBeInTheDocument()
  })

  it('an English session still hears the English calendar failure', async () => {
    stub({ events: 'fail' })
    mount()
    expect(await screen.findByText(en['load.failedTitle'])).toBeInTheDocument()
    expect(screen.getByText(en['load.failedBody'])).toBeInTheDocument()
    expect(screen.getByText(en['dash.upcomingUnread'])).toBeInTheDocument()
    expect(screen.queryByText(es['load.failedTitle'])).not.toBeInTheDocument()
    expect(screen.queryByText(EMPTY_EVENTS)).not.toBeInTheDocument()
  })

  it('a genuinely empty calendar stays empty, in a Spanish session too', async () => {
    stub({ events: 'empty' })
    mount('es')
    expect(await screen.findByText(EMPTY_EVENTS)).toBeInTheDocument()
    expect(screen.queryByText(es['load.failedTitle'])).not.toBeInTheDocument()
    expect(screen.queryByText(es['load.failedBody'])).not.toBeInTheDocument()
    expect(screen.queryByText(es['dash.upcomingUnread'])).not.toBeInTheDocument()
    expect(screen.queryByText(en['dash.upcomingUnread'])).not.toBeInTheDocument()
  })

  it('a Spanish session hears that linked tasks failed, not that there are none', async () => {
    stub({ tasks: 'fail' })
    mount('es')
    fireEvent.click(await screen.findByRole('button', { name: 'Edit event: Sunday Parish Event' }))
    expect(await screen.findByText(es['dash.tasksUnread'])).toBeInTheDocument()
    expect(screen.queryByText(en['dash.tasksUnread'])).not.toBeInTheDocument()
    expect(screen.queryByText(EMPTY_TASKS)).not.toBeInTheDocument()
  })

  it('linked tasks that really are none stay the empty sentence', async () => {
    stub({ tasks: 'empty' })
    mount('es')
    fireEvent.click(await screen.findByRole('button', { name: 'Edit event: Sunday Parish Event' }))
    expect(await screen.findByText(EMPTY_TASKS)).toBeInTheDocument()
    expect(screen.queryByText(es['dash.tasksUnread'])).not.toBeInTheDocument()
    expect(screen.queryByText(en['dash.tasksUnread'])).not.toBeInTheDocument()
  })

  it('a Spanish session hears the member-list failure on the event form', async () => {
    stub({ members: 'fail' })
    mount('es')
    fireEvent.click(await screen.findByRole('button', { name: 'Add Event' }))
    expect(await screen.findByText(es['mem.listFailed'])).toBeInTheDocument()
    expect(screen.queryByText(en['mem.listFailed'])).not.toBeInTheDocument()
  })

  it('a Spanish session hears that the next page of events failed', async () => {
    stub({ events: 'page', more: 'fail' })
    mount('es')
    // The pager itself speaks the parish language (it was hard-coded
    // English while Members already used these keys).
    fireEvent.click(await screen.findByRole('button', { name: es['mem.loadMore'] }))
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument()
    expect(await screen.findByRole('alert')).toHaveTextContent(es['err.load'])
    expect(screen.queryByText(en['err.load'])).not.toBeInTheDocument()
  })
})
