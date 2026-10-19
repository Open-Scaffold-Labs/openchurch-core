// A refused service window used to become [], and the desk said
// "No services in this window". A refused roster became
// "No one checked in yet" and "0 present". A refused room list and a
// refused recent report disappeared the same way a real empty one does.

import { render, screen, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
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
const MASS = { id: 18, title: 'Mass TODAY', date: today, start_time: '10:30', end_time: '11:45', type: 'service' }
const PERSON = { id: 1, client_id: 4, person_name: 'Ana Delgado', kind: 'member', checked_out_at: null }

const ok = (body) => ({ ok: true, status: 200, json: async () => body })
const refused = () => ({ ok: false, status: 500, json: async () => ({ error: 'no' }) })

function stub({
  calendar = ok([MASS]),
  rooms = ok({ rooms: [{ id: 2, name: 'Cry room' }] }),
  checkins = ok({ checkins: [], present: 0 }),
  recent = ok({ services: [] }),
  locale,
} = {}) {
  if (locale) localStorage.setItem('ochr_locale', locale)
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    if (u.includes('/api/calendar?')) return calendar
    if (u.includes('/api/rooms')) return rooms
    if (u.includes('/api/checkins/recent')) return recent
    if (u.includes('/api/checkins')) return checkins
    if (u.includes('/api/clients')) return ok([])
    return ok({})
  }))
}

function mount() {
  return render(
    <MemoryRouter initialEntries={['/checkin']}>
      <LocaleProvider>
        <ToastProvider>
          <ConfirmProvider>
            <Checkin />
          </ConfirmProvider>
        </ToastProvider>
      </LocaleProvider>
    </MemoryRouter>
  )
}

const EMPTY_WINDOW = /No services in this window/i
const EMPTY_ROSTER = /No one checked in yet/i

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('check-in lists when a read is refused', () => {
  it('does not call a refused service window an empty one', async () => {
    const en = STRINGS.en
    stub({ calendar: refused() })
    mount()
    expect(await screen.findByText(en['checkin.servicesUnread'])).toBeInTheDocument()
    expect(screen.getByText(en['checkin.servicesUnreadBody'])).toBeInTheDocument()
    expect(screen.queryByText(EMPTY_WINDOW)).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Choose a service')).not.toBeInTheDocument()
  })

  it('does not call a service window that is not a list an empty one', async () => {
    const en = STRINGS.en
    stub({ calendar: ok({ events: [] }) })
    mount()
    expect(await screen.findByText(en['checkin.servicesUnread'])).toBeInTheDocument()
    expect(screen.queryByText(EMPTY_WINDOW)).not.toBeInTheDocument()
  })

  it('still says when the window truly has no service', async () => {
    const en = STRINGS.en
    stub({ calendar: ok([]) })
    mount()
    expect(await screen.findByText(EMPTY_WINDOW)).toBeInTheDocument()
    expect(screen.queryByText(en['checkin.servicesUnread'])).not.toBeInTheDocument()
  })

  it('shows a service that did load', async () => {
    stub()
    mount()
    expect(await screen.findByLabelText('Choose a service')).toBeInTheDocument()
    expect(screen.getByText(/Mass TODAY/)).toBeInTheDocument()
  })

  it('does not call refused rooms a church with none', async () => {
    const en = STRINGS.en
    stub({ rooms: refused() })
    mount()
    expect(await screen.findByText(en['checkin.roomsUnread'])).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Cry room' })).not.toBeInTheDocument()
  })

  it('does not call a room body that is not a list a church with none', async () => {
    const en = STRINGS.en
    stub({ rooms: ok({ rooms: { name: 'Cry room' } }) })
    mount()
    expect(await screen.findByText(en['checkin.roomsUnread'])).toBeInTheDocument()
  })

  it('still offers a room that did load, and stays quiet when there are none', async () => {
    const en = STRINGS.en
    stub()
    mount()
    expect(await screen.findByRole('option', { name: 'Cry room' })).toBeInTheDocument()
    expect(screen.queryByText(en['checkin.roomsUnread'])).not.toBeInTheDocument()
  })

  it('stays quiet when the parish truly has no rooms', async () => {
    const en = STRINGS.en
    stub({ rooms: ok({ rooms: [] }) })
    mount()
    expect(await screen.findByLabelText('Room for the next check-in')).toBeInTheDocument()
    expect(screen.queryByText(en['checkin.roomsUnread'])).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Cry room' })).not.toBeInTheDocument()
  })

  it('does not call a refused roster an empty service', async () => {
    const en = STRINGS.en
    stub({ checkins: refused() })
    mount()
    expect(await screen.findByText(en['checkin.rosterUnread'])).toBeInTheDocument()
    expect(screen.queryByText(EMPTY_ROSTER)).not.toBeInTheDocument()
    expect(screen.queryByText(/0 present/)).not.toBeInTheDocument()
  })

  it('does not call a roster that is not a list an empty service', async () => {
    const en = STRINGS.en
    stub({ checkins: ok({ present: 0 }) })
    mount()
    expect(await screen.findByText(en['checkin.rosterUnread'])).toBeInTheDocument()
    expect(screen.queryByText(EMPTY_ROSTER)).not.toBeInTheDocument()
  })

  it('still says when nobody is checked in', async () => {
    const en = STRINGS.en
    stub({ checkins: ok({ checkins: [], present: 0 }) })
    mount()
    expect(await screen.findByText(EMPTY_ROSTER)).toBeInTheDocument()
    expect(screen.getByText('0 present')).toBeInTheDocument()
    expect(screen.queryByText(en['checkin.rosterUnread'])).not.toBeInTheDocument()
  })

  it('shows a person who is checked in', async () => {
    stub({ checkins: ok({ checkins: [PERSON], present: 1 }) })
    mount()
    expect(await screen.findByText('Ana Delgado')).toBeInTheDocument()
    expect(screen.getByText('1 present')).toBeInTheDocument()
  })

  it('does not hide a refused recent report', async () => {
    const en = STRINGS.en
    stub({ recent: refused() })
    mount()
    expect(await screen.findByText(en['checkin.recentUnread'])).toBeInTheDocument()
    expect(screen.getByText('Recent attendance')).toBeInTheDocument()
  })

  it('does not hide a recent report that is not a list', async () => {
    const en = STRINGS.en
    stub({ recent: ok({ services: null }) })
    mount()
    expect(await screen.findByText(en['checkin.recentUnread'])).toBeInTheDocument()
  })

  it('stays quiet when recent attendance is truly empty', async () => {
    const en = STRINGS.en
    stub({ recent: ok({ services: [] }) })
    mount()
    expect(await screen.findByText(EMPTY_ROSTER)).toBeInTheDocument()
    expect(screen.queryByText('Recent attendance')).not.toBeInTheDocument()
    expect(screen.queryByText(en['checkin.recentUnread'])).not.toBeInTheDocument()
  })

  it('says the refused window in Spanish', async () => {
    const es = STRINGS.es
    stub({ calendar: refused(), locale: 'es' })
    mount()
    expect(await screen.findByText(es['checkin.servicesUnread'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['checkin.servicesUnread'])).not.toBeInTheDocument()
    expect(screen.queryByText(EMPTY_WINDOW)).not.toBeInTheDocument()
  })
})

// R300-1 (TARS): loadRecent runs on mount and again whenever the roster is
// replaced, so two recent-attendance requests can be in flight. Only the
// latest one may own the rows and the failure flag. Deferred responses,
// resolved in a controlled order; no timers.
describe('recent attendance: only the latest request owns the result', () => {
  const RECENT_SVC = { event_id: 18, title: 'Vigil Mass', date: today, start_time: '17:00', attendance: 7 }
  const NEWER_SVC = { event_id: 18, title: 'Newer Mass', date: today, start_time: '18:00', attendance: 9 }

  function stubDeferredRecent() {
    const pending = []
    vi.stubGlobal('fetch', vi.fn((url) => {
      const u = String(url)
      if (u.includes('/api/calendar?')) return Promise.resolve(ok([MASS]))
      if (u.includes('/api/rooms')) return Promise.resolve(ok({ rooms: [] }))
      if (u.includes('/api/checkins/recent')) {
        return new Promise((resolve, reject) => { pending.push({ resolve, reject }) })
      }
      if (u.includes('/api/checkins')) return Promise.resolve(ok({ checkins: [], present: 0 }))
      if (u.includes('/api/clients')) return Promise.resolve(ok([]))
      return Promise.resolve(ok({}))
    }))
    return pending
  }
  // Wait until the roster load has replaced `checkins` and fired the second request.
  async function twoInFlight(pending) {
    await waitFor(() => expect(pending.length).toBeGreaterThanOrEqual(2))
    const newest = pending[pending.length - 1]
    const older = pending.slice(0, -1)
    return { newest, older }
  }

  it('an older failure arriving after a newer success does not wipe the newer rows', async () => {
    const en = STRINGS.en
    const pending = stubDeferredRecent()
    mount()
    const { newest, older } = await twoInFlight(pending)
    await act(async () => { newest.resolve(ok({ services: [NEWER_SVC] })) })
    expect(await screen.findByTitle('Show who attended Newer Mass')).toBeInTheDocument()
    await act(async () => { for (const o of older) o.reject(new Error('late network failure')) })
    await act(async () => { for (const o of older) o.resolve(refused()) })
    expect(screen.getByTitle('Show who attended Newer Mass')).toBeInTheDocument()
    expect(screen.queryByText(en['checkin.recentUnread'])).not.toBeInTheDocument()
  })

  it('an older success arriving after a newer failure does not replace the failure', async () => {
    const en = STRINGS.en
    const pending = stubDeferredRecent()
    mount()
    const { newest, older } = await twoInFlight(pending)
    await act(async () => { newest.resolve(refused()) })
    expect(await screen.findByText(en['checkin.recentUnread'])).toBeInTheDocument()
    await act(async () => { for (const o of older) o.resolve(ok({ services: [RECENT_SVC] })) })
    expect(screen.getByText(en['checkin.recentUnread'])).toBeInTheDocument()
    expect(screen.queryByTitle('Show who attended Vigil Mass')).not.toBeInTheDocument()
  })
})
