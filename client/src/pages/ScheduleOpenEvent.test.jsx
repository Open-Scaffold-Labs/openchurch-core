// Schedule Open(eventId): a Mass is a stable destination.
//
// THE INVARIANT: /schedule?event=<positive-integer-calendar-event-id>
// opens THAT Mass — week/day + the existing detail — or refuses.
// Title and date never invent a Mass. A garbled, stale, or cross-org
// id must not silently pick today. Closing clears the URL so refresh
// does not reopen a Mass the secretary already put away.
//
// Mutate any one of these and the matching test goes red:
//   1. ?event= is ignored (week/day only, no detail)
//   2. Two same-title Masses are distinguished by date/title, not id
//   3. Garbled / stale ids open some other Mass
//   4. Opening from the grid does not write ?event=
//   5. Closing leaves ?event= on the URL

import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import Schedule, {
  parseScheduleEventId,
  findCalendarEventById,
  weekStartForEventDate,
  dayIndexForEventDate,
  scheduleEventHref,
  withScheduleEventParam,
} from './Schedule'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const pad = (n) => String(n).padStart(2, '0')
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const mondayOf = (d = new Date()) => {
  const x = new Date(d)
  const day = x.getDay()
  x.setDate(x.getDate() - (day === 0 ? 6 : day - 1))
  x.setHours(0, 0, 0, 0)
  return x
}
const addDays = (date, n) => {
  const d = new Date(date)
  d.setDate(d.getDate() + n)
  return d
}

const THIS_MON = mondayOf(new Date())
const THIS_WED = iso(addDays(THIS_MON, 2))
const MARCH_SUN = '2026-03-15'

const EARLY = {
  id: 17,
  title: 'Sunday Mass',
  date: THIS_WED,
  start_time: '08:00',
  end_time: '09:00',
  type: 'service',
  assigned_to: [],
}
const LATE = {
  id: 19,
  title: 'Sunday Mass',
  date: THIS_WED,
  start_time: '10:30',
  end_time: '11:45',
  type: 'service',
  assigned_to: [],
}
const FAR = {
  id: 55,
  title: 'Mass IN MARCH',
  date: MARCH_SUN,
  start_time: '09:00',
  end_time: '10:00',
  type: 'service',
  assigned_to: [],
}

const WEEK = [EARLY, LATE]
const ALL = [EARLY, LATE, FAR]

const ok = (body) => ({ ok: true, status: 200, json: async () => body })
const notFound = () => ({ ok: false, status: 404, json: async () => ({ error: 'Event not found' }) })

function windowed(events, url) {
  const q = String(url).split('?')[1] || ''
  const sp = new URLSearchParams(q)
  const start = sp.get('start')
  const end = sp.get('end')
  if (!start || !end) return events
  return events.filter(e => {
    const d = String(e.date).slice(0, 10)
    return d >= start && d <= end
  })
}

function stubFetch({ events = WEEK, byId = {} } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    if (u.includes('/api/calendar/conflicts')) return ok({ conflicts: [] })
    const m = u.match(/\/api\/calendar\/(\d+)/)
    if (m) return byId[m[1]] ? ok(byId[m[1]]) : notFound()
    if (u.includes('/api/calendar')) return ok(windowed(events, u))
    if (u.includes('/api/liturgical/range')) return ok({})
    if (u.includes('/api/liturgical')) return ok({ season: 'Ordinary Time', color: 'Green' })
    if (u.includes('/api/mass-intentions/weekly')) return ok({ intentions: [] })
    if (u.includes('/api/mass-intentions/awaiting')) return ok({ intentions: [] })
    if (u.includes('/api/clients')) return ok([])
    if (u.includes('/api/groups')) return ok({ groups: [] })
    if (u.includes('/api/invoices')) return ok([])
    if (u.includes('/api/availability')) return ok({ unavailability: [] })
    return ok({})
  }))
}

function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="loc">{loc.pathname}{loc.search}</div>
}

const view = (path) => render(
  <MemoryRouter initialEntries={[path]}>
    <LocaleProvider>
      <ToastProvider>
        <ConfirmProvider>
          <Routes>
            <Route path="/schedule" element={<><LocationProbe /><Schedule /></>} />
          </Routes>
        </ConfirmProvider>
      </ToastProvider>
    </LocaleProvider>
  </MemoryRouter>,
)

const titleInput = () => document.querySelector('input[aria-label="Event title"]')
const dateInput = () => document.querySelector('input[type="date"]')
const timeInputs = () => [...document.querySelectorAll('input[type="time"]')]

beforeEach(() => vi.unstubAllGlobals())

describe('parseScheduleEventId / findCalendarEventById', () => {
  it('accepts only a positive integer id — never a title or date', () => {
    expect(parseScheduleEventId('19')).toBe(19)
    expect(parseScheduleEventId(19)).toBe(19)
    expect(parseScheduleEventId('0')).toBeNull()
    expect(parseScheduleEventId('-3')).toBeNull()
    expect(parseScheduleEventId('1.5')).toBeNull()
    expect(parseScheduleEventId('Sunday Mass')).toBeNull()
    expect(parseScheduleEventId('2026-03-15')).toBeNull()
    expect(parseScheduleEventId('')).toBeNull()
    expect(parseScheduleEventId(null)).toBeNull()
  })

  it('two same-title Masses stay distinct by id', () => {
    expect(findCalendarEventById(WEEK, 19)?.start_time).toBe('10:30')
    expect(findCalendarEventById(WEEK, 17)?.start_time).toBe('08:00')
    expect(findCalendarEventById(WEEK, 999)).toBeNull()
    // Title/date matching would pick the first Sunday Mass. Id must not.
    expect(findCalendarEventById(WEEK, 'Sunday Mass')).toBeNull()
    expect(findCalendarEventById(WEEK, THIS_WED)).toBeNull()
  })

  it('weekStartForEventDate and dayIndex land on that Mass\'s week and day', () => {
    const monday = weekStartForEventDate(MARCH_SUN)
    expect(iso(monday)).toBe('2026-03-09')
    expect(dayIndexForEventDate(monday, MARCH_SUN)).toBe(6)
    expect(weekStartForEventDate('Sunday Mass')).toBeNull()
  })

  it('scheduleEventHref writes ?event= only for a real id', () => {
    expect(scheduleEventHref(19)).toBe('/schedule?event=19')
    expect(scheduleEventHref('Sunday Mass')).toBe('/schedule')
    expect(withScheduleEventParam('group=3', 19).get('event')).toBe('19')
    expect(withScheduleEventParam('group=3', 19).get('group')).toBe('3')
    expect(withScheduleEventParam('event=19&group=3', null).has('event')).toBe(false)
  })
})

describe('Open(eventId) on Schedule', () => {
  it('a valid id opens that Mass — not the other one with the same title', async () => {
    stubFetch()
    view('/schedule?event=19')
    await waitFor(() => expect(screen.getByText('Edit Event')).toBeInTheDocument())
    expect(titleInput().value).toBe('Sunday Mass')
    expect(dateInput().value).toBe(THIS_WED)
    expect(timeInputs()[0].value).toBe('10:30')
    expect(screen.getByTestId('loc').textContent).toBe('/schedule?event=19')
  })

  it('the earlier same-title Mass stays the earlier one', async () => {
    stubFetch()
    view('/schedule?event=17')
    await waitFor(() => expect(screen.getByText('Edit Event')).toBeInTheDocument())
    expect(timeInputs()[0].value).toBe('08:00')
    expect(screen.getByTestId('loc').textContent).toBe('/schedule?event=17')
  })

  it('reload with the same URL restores the detail (the Mass is visibly open)', async () => {
    stubFetch()
    view('/schedule?event=19')
    await waitFor(() => expect(screen.getByText('Edit Event')).toBeInTheDocument())
    expect(timeInputs()[0].value).toBe('10:30')
  })

  it('a Mass outside this week is fetched by id, then the week and day move to it', async () => {
    stubFetch({ events: ALL, byId: { 55: FAR } })
    view('/schedule?event=55')
    await waitFor(() => expect(screen.getByText('Edit Event')).toBeInTheDocument())
    expect(titleInput().value).toBe('Mass IN MARCH')
    expect(dateInput().value).toBe(MARCH_SUN)
    expect(screen.getByText('Mar 9–15, 2026')).toBeInTheDocument()
    // Sunday is selected on the phone list — Monday of that week is empty.
    expect(screen.queryByText(/No events on Monday, March 9/i)).toBeNull()
    expect(screen.getByTestId('loc').textContent).toBe('/schedule?event=55')
    const calls = fetch.mock.calls.map(c => String(c[0]))
    expect(calls.some(u => /\/api\/calendar\/55/.test(u))).toBe(true)
  })

  it('garbled ?event= does not invent a Mass and does not leave the token on the URL', async () => {
    stubFetch()
    view('/schedule?event=Sunday%20Mass')
    await waitFor(() => expect(screen.queryByText(/opening the week/i)).not.toBeInTheDocument())
    expect(screen.queryByText('Edit Event')).toBeNull()
    expect(titleInput()).toBeNull()
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/schedule'))
  })

  it('a stale / unknown id refuses — Schedule stays usable, no other Mass opens', async () => {
    stubFetch()
    view('/schedule?event=999')
    await waitFor(() => expect(screen.queryByText(/opening the week/i)).not.toBeInTheDocument())
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/schedule'))
    expect(screen.queryByText('Edit Event')).toBeNull()
    expect(titleInput()).toBeNull()
    // The week is still the week — tiles for the live Masses remain.
    expect(screen.getAllByRole('button', { name: /Sunday Mass/ }).length).toBeGreaterThan(0)
  })

  it('opening a Mass from the grid writes ?event= so the destination is shareable', async () => {
    stubFetch()
    view('/schedule')
    const tiles = await screen.findAllByRole('button', { name: /Sunday Mass/ })
    tiles[0].click()
    await waitFor(() => expect(screen.getByText('Edit Event')).toBeInTheDocument())
    await waitFor(() => {
      const loc = screen.getByTestId('loc').textContent
      expect(['/schedule?event=17', '/schedule?event=19']).toContain(loc)
    })
    const loc = screen.getByTestId('loc').textContent
    const openedId = Number(new URLSearchParams(loc.split('?')[1]).get('event'))
    expect(timeInputs()[0].value).toBe(openedId === 19 ? '10:30' : '08:00')
  })

  it('closing the detail clears ?event= so refresh does not reopen it', async () => {
    stubFetch()
    view('/schedule?event=19')
    await waitFor(() => expect(screen.getByText('Edit Event')).toBeInTheDocument())
    screen.getByRole('button', { name: /^cancel$/i }).click()
    await waitFor(() => expect(screen.queryByText('Edit Event')).toBeNull())
    expect(screen.getByTestId('loc').textContent).toBe('/schedule')
  })
})
