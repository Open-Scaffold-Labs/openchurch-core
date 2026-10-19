// Service-day / post-service loop: the Mass and the person stay named.
//
// THE JOB: open a roster name, read the profile, return to THAT Mass;
// from the profile open a historical service, then return to THAT person.
//
// Mutate any one of these and the matching test goes red:
//   1. Roster link drops ?from=checkin&event=
//   2. from=checkin + event id no longer returns to /checkin?event=
//   3. A garbled event (title, zero, missing) is treated as a Mass
//   4. Attendance hop drops ?from=member&client=
//   5. from=member + client id no longer returns to /clients/:id
//   6. A name in the URL is treated as a person
//   7. Guest / orphan roster rows start linking
//   8. Switching members without params keeps a previous Mass return
//   9. A deleted Mass with from=member loses the person

import { render, screen, waitFor, act } from '@testing-library/react'
import { MemoryRouter, Route, Routes, Link } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import Checkin, {
  parsePositiveIntId,
  rosterPersonHref,
  checkinReturnHome,
  checkinServiceHref,
} from './Checkin'
import MemberDetail, {
  parseMemberId,
  memberReturnHome,
  attendanceServiceHref,
} from './MemberDetail'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 't', loading: false, isAdmin: false, canWrite: true,
  }),
}))

const today = new Date().toISOString().slice(0, 10)
const EVENT = { id: 17, title: 'Sunday Mass 10:30am', date: today, start_time: '10:30', end_time: '11:45', type: 'service' }
const OTHER = { id: 19, title: 'Sunday Mass 10:30am', date: today, start_time: '12:00', end_time: '13:00', type: 'service' }
const ANA = { id: 25, name: 'Ana Delgado', email: 'ana@x.com', status: 'active' }
const BERNARD = { id: 26, name: 'Bernard Okonkwo', email: 'bernard@x.com', status: 'active' }

const MEMBER_ROW = {
  id: 1, calendar_event_id: 17, client_id: 25, person_name: 'Ana Delgado',
  kind: 'member', checked_in_at: '2026-09-10T17:30:00Z', checked_out_at: null,
}
const GUEST_ROW = {
  id: 2, calendar_event_id: 17, client_id: null, person_name: 'Visiting Friend',
  kind: 'guest', checked_in_at: '2026-09-10T17:31:00Z', checked_out_at: null,
}
const ORPHAN_ROW = {
  id: 3, calendar_event_id: 17, client_id: null, person_name: 'Cecilia Moreno',
  kind: 'member', checked_in_at: '2026-09-10T17:32:00Z', checked_out_at: null,
}

const ATTENDANCE = [
  { id: 101, event_id: 17, event_title: 'Sunday Mass 10:30am', event_date: today },
  { id: 102, event_id: 19, event_title: 'Sunday Mass 10:30am', event_date: today },
]

const ok = (body) => ({ ok: true, status: 200, json: async () => body })
const notFound = () => ({ ok: false, status: 404, json: async () => ({}) })

const stubCheckin = ({ roster = [MEMBER_ROW], events = [EVENT], members = [ANA], recent = [], byId = {} } = {}) => {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    const one = u.match(/\/api\/calendar\/(\d+)/)
    if (one) return byId[one[1]] ? ok(byId[one[1]]) : (events.find(e => String(e.id) === one[1]) ? ok(events.find(e => String(e.id) === one[1])) : notFound())
    if (u.includes('/api/calendar?')) return ok(events)
    if (u.includes('/api/clients')) return ok(members)
    if (u.includes('/api/rooms')) return ok({ rooms: [] })
    if (u.includes('/api/checkins/recent')) return ok({ services: recent })
    if (u.includes('/api/checkins')) return ok({ checkins: roster, present: roster.filter(c => !c.checked_out_at).length })
    return ok({})
  }))
}

const stubProfile = ({ member = ANA, checkins = ATTENDANCE } = {}) => {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    if (u.includes(`/api/clients/${member.id}/donations`)) return ok({ lines: [], total: 0, gift_count: 0 })
    if (u.includes(`/api/clients/${member.id}/checkins`)) return ok({ checkins })
    if (u.match(/\/api\/clients\/\d+$/)) return ok(member)
    return ok({ records: [], entries: [], checkins: [], pledges: [], dates: [], unavailability: [] })
  }))
}

const wrapCheckin = (path) => render(
  <MemoryRouter initialEntries={[path]}>
    <LocaleProvider><ToastProvider><ConfirmProvider>
      <Routes><Route path="/checkin" element={<Checkin />} /></Routes>
    </ConfirmProvider></ToastProvider></LocaleProvider>
  </MemoryRouter>
)

const wrapProfile = (path) => render(
  <MemoryRouter initialEntries={[path]}>
    <LocaleProvider><ToastProvider><ConfirmProvider>
      <Routes><Route path="/clients/:id" element={<MemberDetail />} /></Routes>
    </ConfirmProvider></ToastProvider></LocaleProvider>
  </MemoryRouter>
)

const sp = (q) => new URLSearchParams(q)

beforeEach(() => vi.unstubAllGlobals())

describe('ID readers refuse labels', () => {
  it('parsePositiveIntId and parseMemberId accept only a positive integer', () => {
    for (const fn of [parsePositiveIntId, parseMemberId]) {
      expect(fn('17')).toBe(17)
      expect(fn(17)).toBe(17)
      expect(fn('0')).toBeNull()
      expect(fn('-3')).toBeNull()
      expect(fn('Sunday')).toBeNull()
      expect(fn('17.5')).toBeNull()
      expect(fn('17abc')).toBeNull()
      expect(fn('')).toBeNull()
      expect(fn(null)).toBeNull()
    }
  })
})

describe('rosterPersonHref / memberReturnHome', () => {
  it('a live member on a named Mass carries both ids', () => {
    expect(rosterPersonHref(25, 17)).toBe('/clients/25?from=checkin&event=17')
    expect(memberReturnHome(sp('from=checkin&event=17'))).toEqual({
      to: '/checkin?event=17', labelKey: 'member.backCheckin',
    })
  })

  it('garbled or missing Mass falls back to the Members roll — never invents a service', () => {
    expect(rosterPersonHref(25, 'Sunday')).toBe('/clients/25')
    expect(rosterPersonHref(25, 0)).toBe('/clients/25')
    expect(rosterPersonHref(25, null)).toBe('/clients/25')
    expect(memberReturnHome(sp('from=checkin'))).toEqual({ to: '/clients', labelKey: 'member.backMembers' })
    expect(memberReturnHome(sp('from=checkin&event=Sunday'))).toEqual({ to: '/clients', labelKey: 'member.backMembers' })
    expect(memberReturnHome(sp('from=checkin&event=0'))).toEqual({ to: '/clients', labelKey: 'member.backMembers' })
    expect(memberReturnHome(sp('event=17'))).toEqual({ to: '/clients', labelKey: 'member.backMembers' })
    expect(memberReturnHome(sp(''))).toEqual({ to: '/clients', labelKey: 'member.backMembers' })
  })

  it('a missing client_id is not a person', () => {
    expect(rosterPersonHref(null, 17)).toBeNull()
    expect(rosterPersonHref('Ana Delgado', 17)).toBeNull()
  })
})

describe('attendanceServiceHref / checkinReturnHome', () => {
  it('a named service carries the person back', () => {
    expect(attendanceServiceHref(19, 25)).toBe('/checkin?event=19&from=member&client=25')
    expect(checkinReturnHome(sp('from=member&client=25'), [ANA])).toEqual({
      to: '/clients/25', labelKey: 'member.backNamed', name: 'Ana Delgado',
    })
  })

  it('without a live name on file the return is still the profile, never a URL name', () => {
    expect(checkinReturnHome(sp('from=member&client=25'), [])).toEqual({
      to: '/clients/25', labelKey: 'member.backProfile',
    })
    expect(checkinReturnHome(sp('from=member&client=25&name=Somebody Else'), [])).toEqual({
      to: '/clients/25', labelKey: 'member.backProfile',
    })
  })

  it('a garbled person is not a return — no invented member', () => {
    expect(checkinReturnHome(sp('from=member'), [ANA])).toBeNull()
    expect(checkinReturnHome(sp('from=member&client=Ana'), [ANA])).toBeNull()
    expect(checkinReturnHome(sp('from=member&client=0'), [ANA])).toBeNull()
    expect(checkinReturnHome(sp('client=25'), [ANA])).toBeNull()
    expect(attendanceServiceHref('Sunday Mass', 25)).toBeNull()
    expect(attendanceServiceHref(null, 25)).toBeNull()
  })

  it('another Mass from this desk keeps the person thread', () => {
    expect(checkinServiceHref(19, sp('from=member&client=25')))
      .toBe('/checkin?event=19&from=member&client=25')
    expect(checkinServiceHref(19, sp(''))).toBe('/checkin?event=19')
    expect(checkinServiceHref('Sunday', sp('from=member&client=25'))).toBe('/checkin')
  })
})

describe('roster hop carries the Mass', () => {
  it('opens the member with from=checkin and this event id', async () => {
    stubCheckin()
    wrapCheckin('/checkin?event=17')
    const link = await screen.findByRole('link', { name: 'Ana Delgado' })
    expect(link.getAttribute('href')).toBe('/clients/25?from=checkin&event=17')
  })

  it('guest and orphan names stay text — identity, not the label', async () => {
    stubCheckin({ roster: [MEMBER_ROW, GUEST_ROW, ORPHAN_ROW] })
    wrapCheckin('/checkin?event=17')
    await screen.findByText('Visiting Friend')
    await screen.findByText('Cecilia Moreno')
    const hrefs = [...document.querySelectorAll('a[href^="/clients/"]')].map(a => a.getAttribute('href'))
    expect(hrefs).toEqual(['/clients/25?from=checkin&event=17'])
  })
})

describe('profile return to the Mass', () => {
  it('CONTROL: a directory open still says Members', async () => {
    stubProfile()
    wrapProfile('/clients/25')
    const back = await screen.findByRole('link', { name: /back to members/i })
    expect(back.getAttribute('href')).toBe('/clients')
    expect(screen.queryByRole('link', { name: /back to this mass/i })).toBeNull()
  })

  it('from=checkin + event returns to that Mass', async () => {
    stubProfile()
    wrapProfile('/clients/25?from=checkin&event=17')
    const back = await screen.findByRole('link', { name: /back to this mass/i })
    expect(back.getAttribute('href')).toBe('/checkin?event=17')
    expect(screen.queryByRole('link', { name: /back to members/i })).toBeNull()
  })

  it('from=checkin without a real event stays on Members — no invented Mass', async () => {
    stubProfile()
    wrapProfile('/clients/25?from=checkin&event=Sunday')
    const back = await screen.findByRole('link', { name: /back to members/i })
    expect(back.getAttribute('href')).toBe('/clients')
  })

  it('attendance rows carry this person back to each Mass, by event id', async () => {
    stubProfile()
    wrapProfile('/clients/25')
    const rows = await screen.findAllByRole('link', { name: 'Sunday Mass 10:30am' })
    expect(rows.map(a => a.getAttribute('href'))).toEqual([
      '/checkin?event=17&from=member&client=25',
      '/checkin?event=19&from=member&client=25',
    ])
  })

  it('a vanished member opened from a Mass still returns to that Mass', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => notFound()))
    wrapProfile('/clients/99?from=checkin&event=17')
    expect(await screen.findByText(/member not found/i)).toBeInTheDocument()
    const back = screen.getByRole('link', { name: /back to this mass/i })
    expect(back.getAttribute('href')).toBe('/checkin?event=17')
  })
})

describe('check-in return to the person', () => {
  it('from=member + client returns to that profile, named from the live list', async () => {
    stubCheckin()
    wrapCheckin('/checkin?event=17&from=member&client=25')
    const back = await screen.findByRole('link', { name: /back to ana delgado/i })
    expect(back.getAttribute('href')).toBe('/clients/25')
  })

  it('from=member without a real client invents nobody', async () => {
    stubCheckin()
    wrapCheckin('/checkin?event=17&from=member&client=Ana')
    await screen.findByRole('heading', { name: 'Check-in' })
    expect(screen.queryByRole('link', { name: /back to/i })).toBeNull()
  })

  it('a deleted Mass still offers the person who opened it', async () => {
    stubCheckin({ events: [EVENT], byId: {} })
    wrapCheckin('/checkin?event=999&from=member&client=25')
    await screen.findByText(/isn't on this church's schedule/i)
    const back = screen.getByRole('link', { name: /back to ana delgado/i })
    expect(back.getAttribute('href')).toBe('/clients/25')
    expect(screen.queryByLabelText('Choose a service')).toBeNull()
  })

  it('recent-panel hops keep the person thread, keyed on event id', async () => {
    stubCheckin({
      events: [EVENT, OTHER],
      recent: [
        { event_id: 17, title: 'Sunday Mass 10:30am', date: `${today}T07:00:00.000Z`, attendance: 4 },
        { event_id: 19, title: 'Sunday Mass 10:30am', date: `${today}T07:00:00.000Z`, attendance: 1 },
      ],
    })
    wrapCheckin('/checkin?event=17&from=member&client=25')
    await screen.findByText(/Recent attendance/i)
    const recent = [...document.querySelectorAll('a[href^="/checkin?event="]')]
    expect(recent.map(a => a.getAttribute('href'))).toEqual([
      '/checkin?event=17&from=member&client=25',
      '/checkin?event=19&from=member&client=25',
    ])
  })
})

describe('rapid member switching drops a Mass that is not this hop', () => {
  it('⌘K to another member without params returns to Members, not the previous Mass', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      if (u.includes(`/api/clients/${ANA.id}/donations`)) return ok({ lines: [], total: 0, gift_count: 0 })
      if (u.includes(`/api/clients/${BERNARD.id}/donations`)) return ok({ lines: [], total: 0, gift_count: 0 })
      if (u.endsWith(`/api/clients/${ANA.id}`)) return ok(ANA)
      if (u.endsWith(`/api/clients/${BERNARD.id}`)) return ok(BERNARD)
      return ok({ records: [], entries: [], checkins: [], pledges: [], dates: [], unavailability: [] })
    }))
    render(
      <MemoryRouter initialEntries={[`/clients/${ANA.id}?from=checkin&event=17`]}>
        <LocaleProvider><ToastProvider><ConfirmProvider>
          <Link to={`/clients/${BERNARD.id}`}>go to bernard</Link>
          <Routes><Route path="/clients/:id" element={<MemberDetail />} /></Routes>
        </ConfirmProvider></ToastProvider></LocaleProvider>
      </MemoryRouter>
    )
    expect((await screen.findByRole('link', { name: /back to this mass/i })).getAttribute('href'))
      .toBe('/checkin?event=17')

    await act(async () => { screen.getByText('go to bernard').click() })
    await screen.findByRole('heading', { name: BERNARD.name })
    const back = screen.getByRole('link', { name: /back to members/i })
    expect(back.getAttribute('href')).toBe('/clients')
    expect(screen.queryByRole('link', { name: /back to this mass/i })).toBeNull()
  })
})

describe('CONTROL — recent panel without a person stays event-only', () => {
  it('does not invent from=member', async () => {
    stubCheckin({
      events: [EVENT, OTHER],
      recent: [
        { event_id: 17, title: 'Sunday Mass 10:30am', date: `${today}T07:00:00.000Z`, attendance: 4 },
        { event_id: 19, title: 'Sunday Mass 10:30am', date: `${today}T07:00:00.000Z`, attendance: 1 },
      ],
    })
    wrapCheckin('/checkin?event=17')
    await waitFor(() => {
      const recent = [...document.querySelectorAll('a[href^="/checkin?event="]')]
      expect(recent.map(a => a.getAttribute('href'))).toEqual([
        '/checkin?event=17',
        '/checkin?event=19',
      ])
    })
  })
})
