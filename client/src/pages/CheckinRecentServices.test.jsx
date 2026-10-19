// The recent-attendance panel answers "how many". The next question is
// always "who", and the roster is on this same page.
//
// THE INVARIANT: a recent row opens the service it counted, identified by
// event_id — never by the title or date it displays.
//
// A parish lists the same title week after week. Two Sunday 10:30 Masses a
// fortnight apart are identical text and differ only by id, which is exactly
// the case the panel exists to disambiguate. A link keyed on anything visible
// would open the wrong Mass and show a roster that is true data about the
// wrong service — this codebase's recurring failure shape.
//
// The attendance figure is DISTINCT_PEOPLE (reporting/definitions.js): people,
// not check-in rows. Nothing here recomputes or restates it.

import { render, screen, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
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

const day = off => { const d = new Date(); d.setDate(d.getDate() + off); return d.toISOString().slice(0, 10) }
const NEWER = { id: 17, title: 'Sunday Mass 10:30am', date: day(-7), start_time: '10:30', end_time: '11:45', type: 'service' }
const OTHER = { id: 18, title: 'Sunday Mass 12pm', date: day(-7), start_time: '12:00', end_time: '13:00', type: 'service' }
// Same title as NEWER. Different service. This is the whole point.
const OLDER = { id: 19, title: 'Sunday Mass 10:30am', date: day(-14), start_time: '10:30', end_time: '11:45', type: 'service' }
const UPCOMING = { id: 20, title: 'Sunday Mass 10:30am', date: day(3), start_time: '10:30', end_time: '11:45', type: 'service' }
const EVENTS = [OLDER, NEWER, OTHER, UPCOMING]

// The server sends the calendar day as a full ISO timestamp for this panel.
const RECENT = [
  { event_id: 17, title: 'Sunday Mass 10:30am', date: `${day(-7)}T07:00:00.000Z`, attendance: 4 },
  { event_id: 18, title: 'Sunday Mass 12pm', date: `${day(-7)}T07:00:00.000Z`, attendance: 2 },
  { event_id: 19, title: 'Sunday Mass 10:30am', date: `${day(-14)}T07:00:00.000Z`, attendance: 1 },
]

const ROSTERS = {
  17: [{ id: 1, calendar_event_id: 17, client_id: 25, person_name: 'Ana Delgado', kind: 'member', checked_in_at: 'x', checked_out_at: null },
       { id: 2, calendar_event_id: 17, client_id: 26, person_name: 'Bernard Okonkwo', kind: 'member', checked_in_at: 'x', checked_out_at: null }],
  19: [{ id: 3, calendar_event_id: 19, client_id: 25, person_name: 'Ana Delgado', kind: 'member', checked_in_at: 'x', checked_out_at: null }],
}

const ok = b => ({ ok: true, status: 200, json: async () => b })

const stubFetch = () => vi.stubGlobal('fetch', vi.fn(async (url) => {
  const u = String(url)
  const one = u.match(/\/api\/calendar\/(\d+)/)
  if (one) { const e = EVENTS.find(x => String(x.id) === one[1]); return e ? ok(e) : { ok: false, status: 404, json: async () => ({}) } }
  if (u.includes('/api/calendar?')) return ok(EVENTS)
  if (u.includes('/api/checkins/recent')) return ok({ services: RECENT })
  const r = u.match(/\/api\/checkins\?event_id=(\d+)/)
  if (r) return ok({ checkins: ROSTERS[r[1]] ?? [], present: (ROSTERS[r[1]] ?? []).length })
  if (u.includes('/api/clients')) return ok([])
  if (u.includes('/api/rooms')) return ok({ rooms: [] })
  return ok({})
}))

const view = (path = '/checkin') => render(
  <MemoryRouter initialEntries={[path]}>
    <LocaleProvider><ToastProvider><ConfirmProvider>
      <Checkin />
    </ConfirmProvider></ToastProvider></LocaleProvider></MemoryRouter>
)

const panelRows = async () => {
  const head = await screen.findByText(/Recent attendance/i, {}, { timeout: 4000 })
  const card = head.closest('div').parentElement
  return [...card.querySelectorAll('a[href^="/checkin?event="]')]
}

beforeEach(() => { vi.unstubAllGlobals() })

describe('the recent-attendance panel', () => {
  it('offers every service it counted as a way in', async () => {
    stubFetch()
    view()
    const rows = await panelRows()
    expect(rows).toHaveLength(3)
    expect(rows.map(a => a.getAttribute('href')))
      .toEqual(['/checkin?event=17', '/checkin?event=18', '/checkin?event=19'])
  })

  it('THE DEFECT: two services with the SAME TITLE get different destinations', async () => {
    // Keyed on the title or the date, these two collapse into one and the
    // panel opens the wrong Mass on precisely the rows it exists to tell apart.
    stubFetch()
    view()
    const rows = await panelRows()
    const sameTitle = rows.filter(a => /Sunday Mass 10:30am/.test(a.textContent))
    expect(sameTitle).toHaveLength(2)
    const hrefs = sameTitle.map(a => a.getAttribute('href'))
    expect(new Set(hrefs).size).toBe(2)
    expect(hrefs).toEqual(['/checkin?event=17', '/checkin?event=19'])
  })

  it('still shows the figure the server computed, untouched', async () => {
    // DISTINCT_PEOPLE — people, not check-in rows. Not recomputed here.
    stubFetch()
    view()
    const rows = await panelRows()
    expect(within(rows[0]).getByText('4')).toBeTruthy()
    expect(within(rows[2]).getByText('1')).toBeTruthy()
  })

  it('marks the service currently on screen, and only that one', async () => {
    stubFetch()
    view('/checkin?event=19')
    await waitFor(async () => {
      const rows = await panelRows()
      const current = rows.filter(a => a.getAttribute('aria-current') === 'true')
      expect(current).toHaveLength(1)
      expect(current[0].getAttribute('href')).toBe('/checkin?event=19')
    }, { timeout: 4000 })
  })

  it('opening a row shows that service, and its roster only', async () => {
    stubFetch()
    view('/checkin?event=19')
    const picker = await screen.findByLabelText('Choose a service', {}, { timeout: 4000 })
    expect(picker.value).toBe('19')
    await screen.findByText('Ana Delgado')
    // Bernard was at the OTHER Mass with the same title. He must not be here.
    expect(screen.queryByText('Bernard Okonkwo')).toBeNull()
  })
})
