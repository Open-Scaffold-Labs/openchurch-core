// APPLE-PRESENTATION-L2-01 — rendered notification panel and account menu.
// A Spanish session must show the strings.js copy. Restoring "Mark all
// read" / "Sign Out" / "Administrator" as literals makes the source pin
// in shellPresentation.test.js fail; this file fails if the panel still
// renders the English sentence while the locale is es.

import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { ThemeProvider } from '../context/ThemeContext'
import { Header } from '../App'

const authState = vi.hoisted(() => ({
  user: {
    id: 1,
    name: 'Ana',
    email: 'ana@parish.test',
    role: 'admin',
    organization: { id: 1, name: 'San José', locale: 'en' },
  },
  logout: vi.fn(async () => {}),
}))

vi.mock('../context/AuthContext', () => ({
  useAuth: () => authState,
}))

const NOTE = {
  id: 7,
  type: 'event',
  read: false,
  message: 'Misa de las 10',
  created_at: new Date().toISOString(),
}

function stubFetch(notes, { fail = false } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    if (u.includes('/api/notifications')) {
      if (fail) return { ok: false, status: 500, json: async () => ({}) }
      return { ok: true, status: 200, json: async () => notes }
    }
    return { ok: true, status: 200, json: async () => [] }
  }))
}

function view() {
  return render(
    <ThemeProvider>
      <LocaleProvider>
        <MemoryRouter>
          <Header onMenuClick={() => {}} />
        </MemoryRouter>
      </LocaleProvider>
    </ThemeProvider>
  )
}

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  })
  localStorage.clear()
  authState.user = {
    id: 1,
    name: 'Ana',
    email: 'ana@parish.test',
    role: 'admin',
    organization: { id: 1, name: 'San José', locale: 'en' },
  }
  stubFetch([NOTE])
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('shell notification panel and account menu', () => {
  it('English session keeps the previous chrome sentences', async () => {
    localStorage.setItem('ochr_locale', 'en')
    view()
    const bell = await screen.findByRole('button', { name: 'Notifications, 1 unread' })
    fireEvent.click(bell)
    expect(screen.getByRole('button', { name: 'Mark all read' })).toBeInTheDocument()
    expect(screen.getByText('Event')).toBeInTheDocument()
    expect(screen.getByText('just now')).toBeInTheDocument()
    expect(screen.getByText('Misa de las 10')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Account menu for Ana' }))
    expect(screen.getByText('Administrator')).toBeInTheDocument()
    expect(screen.getByText('View Members')).toBeInTheDocument()
    expect(screen.getByText('Manage Tasks')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign Out' })).toBeInTheDocument()
    expect(screen.getByText('Members')).toBeInTheDocument()
    expect(screen.getByText('Events')).toBeInTheDocument()
    expect(screen.getByText('Tasks')).toBeInTheDocument()
  })

  it('Spanish session replaces notification and account chrome', async () => {
    localStorage.setItem('ochr_locale', 'es')
    view()
    const bell = await screen.findByRole('button', { name: STRINGS.es['shell.notif.unread'].replace('{n}', '1') })
    fireEvent.click(bell)
    expect(screen.getByRole('button', { name: STRINGS.es['shell.notif.markAll'] })).toBeInTheDocument()
    expect(screen.getByText(STRINGS.es['shell.notif.event'])).toBeInTheDocument()
    expect(screen.getByText(STRINGS.es['aist.justNow'])).toBeInTheDocument()
    expect(screen.getByText('Misa de las 10')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Mark all read' })).toBeNull()
    expect(screen.queryByText('Event')).toBeNull()
    expect(screen.queryByText('just now')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: STRINGS.es['shell.account.menu'].replace('{name}', 'Ana') }))
    expect(screen.getByText(STRINGS.es['shell.role.admin'])).toBeInTheDocument()
    expect(screen.getByText(STRINGS.es['shell.account.viewMembers'])).toBeInTheDocument()
    expect(screen.getByText(STRINGS.es['shell.account.manageTasks'])).toBeInTheDocument()
    expect(screen.getByRole('button', { name: STRINGS.es['shell.account.signOut'] })).toBeInTheDocument()
    expect(screen.getByText(STRINGS.es['dash.glance.members'])).toBeInTheDocument()
    expect(screen.getByText(STRINGS.es['dash.glance.events'])).toBeInTheDocument()
    expect(screen.getByText(STRINGS.es['dash.glance.tasks'])).toBeInTheDocument()
    expect(screen.queryByText('Administrator')).toBeNull()
    expect(screen.queryByText('Sign Out')).toBeNull()
    expect(screen.queryByText('View Members')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: STRINGS.es['shell.openSearch'] }))
    expect(screen.getByRole('dialog', { name: STRINGS.es['shell.searchShort'] })).toBeInTheDocument()
    expect(screen.getByText(STRINGS.es['shell.search.hint'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['shell.search.hint'])).toBeNull()
  })

  it('a staff account in Spanish says Personal, and a missed check says so', async () => {
    localStorage.setItem('ochr_locale', 'es')
    authState.user = { ...authState.user, role: 'staff', name: '' }
    stubFetch([], { fail: true })
    view()
    const bell = await screen.findByRole('button', { name: STRINGS.es['nav.Notifications'] })
    fireEvent.click(bell)
    expect(screen.getByText(STRINGS.es['shell.notif.checkFailed'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['shell.notif.checkFailed'])).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: STRINGS.es['shell.account.menu'].replace('{name}', STRINGS.es['shell.account.fallbackName']) }))
    expect(screen.getByText(STRINGS.es['shell.role.staff'])).toBeInTheDocument()
    expect(screen.getByText(STRINGS.es['shell.account.fallbackName'])).toBeInTheDocument()
    expect(screen.queryByText('OpenChurch Admin')).toBeNull()
    expect(screen.queryByText('staff')).toBeNull()
  })
})

// APPLE-SHELL-L2-02 — aged rows and a failed later poll. The L2-01
// render only ever saw "just now", so `hace 5m` and the stale sentence
// could change without these tests going red.

const FIXED_NOW = new Date('2026-09-23T12:00:00.000Z')

function agedNotes() {
  const at = (msAgo) => new Date(FIXED_NOW.getTime() - msAgo).toISOString()
  return [
    { id: 1, type: 'task', read: false, message: 'Fila minuto', created_at: at(5 * 60 * 1000) },
    { id: 2, type: 'event', read: false, message: 'Fila hora', created_at: at(2 * 60 * 60 * 1000) },
    { id: 3, type: 'task', read: false, message: 'Fila día', created_at: at(3 * 24 * 60 * 60 * 1000) },
    { id: 4, type: 'task', read: false, message: 'Fila un minuto', created_at: at(60 * 1000) },
    { id: 5, type: 'event', read: false, message: 'Fila una hora', created_at: at(60 * 60 * 1000) },
    { id: 6, type: 'task', read: false, message: 'Fila un día', created_at: at(24 * 60 * 60 * 1000) },
  ]
}

const ES_STALE = 'Esta lista puede estar desactualizada — la última consulta no llegó al servidor.'

describe('APPLE-SHELL-L2-02 notification times and stale poll', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('English session shows compact relative times on a fixed clock', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(FIXED_NOW)
    localStorage.setItem('ochr_locale', 'en')
    stubFetch(agedNotes())
    view()
    const bell = await screen.findByRole('button', { name: 'Notifications, 6 unread' })
    fireEvent.click(bell)
    expect(screen.getByText('5m ago')).toBeInTheDocument()
    expect(screen.getByText('2h ago')).toBeInTheDocument()
    expect(screen.getByText('3d ago')).toBeInTheDocument()
    expect(screen.getByText('1m ago')).toBeInTheDocument()
    expect(screen.getByText('1h ago')).toBeInTheDocument()
    expect(screen.getByText('1d ago')).toBeInTheDocument()
    expect(screen.queryByText('hace 5 minutos')).toBeNull()
  })

  it('Spanish session shows whole-word relative times, not unit letters', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(FIXED_NOW)
    localStorage.setItem('ochr_locale', 'es')
    stubFetch(agedNotes())
    view()
    const bell = await screen.findByRole('button', { name: 'Notificaciones, 6 sin leer' })
    fireEvent.click(bell)
    expect(screen.getByText('hace 5 minutos')).toBeInTheDocument()
    expect(screen.getByText('hace 2 horas')).toBeInTheDocument()
    expect(screen.getByText('hace 3 días')).toBeInTheDocument()
    expect(screen.getByText('hace un minuto')).toBeInTheDocument()
    expect(screen.getByText('hace una hora')).toBeInTheDocument()
    expect(screen.getByText('hace un día')).toBeInTheDocument()
    expect(screen.queryByText('hace 5m')).toBeNull()
    expect(screen.queryByText('hace 2h')).toBeNull()
    expect(screen.queryByText('hace 3d')).toBeNull()
    expect(screen.queryByText('5m ago')).toBeNull()
    const panel = document.body.textContent
    expect(panel).not.toMatch(/hace \d+[mhd]\b/)
  })

  it('a later failed poll keeps the list and shows the Spanish stale sentence', async () => {
    localStorage.setItem('ochr_locale', 'es')
    let notificationCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      if (u.includes('/api/notifications')) {
        notificationCalls += 1
        if (notificationCalls === 1) {
          return { ok: true, status: 200, json: async () => [NOTE] }
        }
        return { ok: false, status: 500, json: async () => ({}) }
      }
      return { ok: true, status: 200, json: async () => [] }
    }))
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    view()
    const bell = await screen.findByRole('button', { name: 'Notificaciones, 1 sin leer' })
    fireEvent.click(bell)
    expect(screen.getByText('Misa de las 10')).toBeInTheDocument()
    expect(screen.queryByText(ES_STALE)).toBeNull()

    await act(async () => {
      vi.advanceTimersByTime(30000)
    })
    await waitFor(() => {
      expect(screen.getByText(ES_STALE)).toBeInTheDocument()
    })
    expect(notificationCalls).toBe(2)
    expect(screen.getByText('Misa de las 10')).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['shell.notif.stale'])).toBeNull()
    expect(screen.queryByText(STRINGS.es['shell.notif.checkFailed'])).toBeNull()
  })
})
