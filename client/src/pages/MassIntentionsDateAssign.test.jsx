// Mass date owns which Masses the Assign dropdown offers.
// Mutate any one of these and the matching test goes red:
//   1. massesOnLocalDay returns every Mass, ignoring the chosen day
//   2. An empty day says nothing and offers no way onto the Schedule
//   3. Save sends a typed day together with a Mass on another day
//   4. Picking a Mass does not set the Mass date

import { ToastProvider } from '../components/ToastProvider'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { calendarDay } from '../utils/dates'
import MassIntentions, {
  massesOnLocalDay,
  intentionDateConflicts,
  assignedMassDayUnknown,
  stashIntentionDraft,
  peekIntentionDraft,
  takeIntentionDraft,
  INTENTION_DRAFT_KEY,
  INTENTION_DRAFT_TTL_MS,
  groupAssignableEntries,
} from './MassIntentions'
import { scheduleNewMassHref, intentionResumeHref, isIntentionReturn, isCalendarDayParam } from './Schedule'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en', tradition: 'catholic' } },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const ok = (body) => ({ ok: true, status: 200, json: async () => body })
const notFound = () => ({ ok: false, status: 404, json: async () => ({ error: 'Event not found' }) })

const OCT4_EARLY = { id: 4, title: 'Sunday Mass', date: '2026-10-04', start_time: '08:00:00', type: 'service' }
const OCT4_LATE = { id: 5, title: 'Sunday Mass', date: '2026-10-04', start_time: '10:30:00', type: 'service' }
const OCT4_UTC = { id: 6, title: 'Sunday Evening', date: '2026-10-04T00:00:00.000Z', start_time: '17:00:00', type: 'service' }
const OCT11 = { id: 11, title: 'Sunday Mass', date: '2026-10-11', start_time: '10:30:00', type: 'service' }
const OCT5 = { id: 15, title: 'Monday Mass', date: '2026-10-05', start_time: '09:00:00', type: 'service' }
const SHIFTED = { id: 99, title: 'Shifted instant', date: '2026-10-03T07:00:00.000Z', start_time: '09:00:00', type: 'service' }
const OCT4_MEETING = { id: 40, title: 'Finance meeting', date: '2026-10-04', start_time: '19:00:00', type: 'meeting' }
const OCT18_MEETING = { id: 41, title: 'Parish council', date: '2026-10-18', start_time: '19:00:00', type: 'meeting' }
const CHRISTMAS = { id: 25, title: 'Christmas Mass', date: '2026-12-25', start_time: '10:00:00', type: 'service' }
const ALL = [OCT4_EARLY, OCT4_LATE, OCT4_UTC, OCT11, SHIFTED, OCT4_MEETING, OCT18_MEETING]

function stubFetch({ byId = { 4: OCT4_EARLY, 11: OCT11 }, list = ALL, intentions = [] } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    const m = u.match(/\/api\/calendar\/(\d+)/)
    if (m) return byId[m[1]] ? ok(byId[m[1]]) : notFound()
    if (u.includes('/api/calendar')) return ok(list)
    if (u.includes('/api/mass-intentions')) return ok({ intentions })
    return ok({})
  }))
}

function renderBook(path = '/mass-intentions') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <LocaleProvider>
        <Routes>
          <Route path="/mass-intentions" element={<ToastProvider><MassIntentions /></ToastProvider>} />
          <Route path="/schedule" element={<div>Schedule</div>} />
        </Routes>
      </LocaleProvider>
    </MemoryRouter>,
  )
}

function assignSelect() {
  return screen.getByLabelText(/assign to mass/i)
}

function optionValues() {
  return [...assignSelect().options].map(o => o.value)
}

function writes() {
  return fetch.mock.calls
    .filter(([, opts]) => opts && (opts.method === 'POST' || opts.method === 'PATCH'))
    .map(([, opts]) => ({ method: opts.method, body: JSON.parse(opts.body) }))
}

beforeEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.removeItem(INTENTION_DRAFT_KEY)
})

describe('calendar day filter', () => {
  it('keeps a DATE and UTC-midnight JSON on that parish day, and drops a shifted instant', () => {
    expect(calendarDay('2026-10-04')).toBe('2026-10-04')
    expect(calendarDay('2026-10-04T00:00:00.000Z')).toBe('2026-10-04')
    expect(calendarDay('2026-10-03T07:00:00.000Z')).toBe('')
    expect(massesOnLocalDay(ALL, '2026-10-04').map(m => m.id)).toEqual([4, 5, 6])
    expect(massesOnLocalDay(ALL, '2026-10-11').map(m => m.id)).toEqual([11])
    expect(massesOnLocalDay(ALL, '2026-10-18')).toEqual([])
    expect(massesOnLocalDay(ALL, '2026-10-04').map(m => m.id)).not.toContain(40)
    const storedAsMass = { id: 70, title: 'Misa Dominical', date: '2026-10-04', type: 'mass' }
    const storedAsMassWord = { id: 73, title: 'Misa', date: '2026-10-04', type: 'Mass' }
    const picnic = { id: 71, title: 'Parish picnic', date: '2026-10-04', type: 'event' }
    const untyped = { id: 72, title: '10:30 Mass', date: '2026-10-04' }
    const onTheDay = massesOnLocalDay([storedAsMass, storedAsMassWord, picnic, untyped, OCT4_MEETING], '2026-10-04')
    expect(onTheDay.map(m => m.id)).toEqual([70, 73, 71, 72])
    const casedMeeting = { id: 90, title: 'Vestry', date: '2026-10-04', type: 'Meeting' }
    const spacedMeeting = { id: 91, title: 'Vestry', date: '2026-10-04', type: ' meeting ' }
    expect(massesOnLocalDay([casedMeeting, spacedMeeting, storedAsMass], '2026-10-04').map(m => m.id)).toEqual([70])
    const grouped = groupAssignableEntries(onTheDay)
    expect(grouped.primary.map(m => m.id)).toEqual([70, 73])
    expect(grouped.other.map(m => m.id)).toEqual([71, 72])
    expect(intentionDateConflicts('2026-10-04', '2026-10-05')).toBe(true)
    expect(intentionDateConflicts('2026-10-05', '2026-10-05')).toBe(false)
    expect(intentionDateConflicts('', '2026-10-05')).toBe(false)
    expect(assignedMassDayUnknown('77', '')).toBe(true)
    expect(assignedMassDayUnknown('', '')).toBe(false)
    expect(assignedMassDayUnknown('15', '2026-10-05')).toBe(false)
  })

  it('scheduleNewMassHref reuses the Schedule create flow for that day', () => {
    expect(scheduleNewMassHref('2026-10-04')).toBe('/schedule?new=1&return=intention&date=2026-10-04')
    expect(scheduleNewMassHref('Sunday')).toBe('/schedule?new=1&return=intention')
    expect(isCalendarDayParam('Sunday')).toBe(false)
    expect(isCalendarDayParam('2026-10-04')).toBe(true)
    expect(isCalendarDayParam('2026-10-04junk')).toBe(false)
    expect(isCalendarDayParam('2026-02-31')).toBe(false)
    expect(scheduleNewMassHref('2026-10-04junk')).toBe('/schedule?new=1&return=intention')
    expect(intentionResumeHref({ date: 'Sunday' })).toBe('/mass-intentions')
    const nonce = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    expect(intentionResumeHref({ eventId: 80, date: '2026-10-04', nonce })).toBe(`/mass-intentions?event=80&date=2026-10-04&resume=${nonce}`)
    expect(isIntentionReturn('intention')).toBe(true)
    expect(isIntentionReturn('https://evil.example/phish')).toBe(false)
    expect(isIntentionReturn('')).toBe(false)
  })

  it('Spanish names the empty day and the way to add a Mass', () => {
    expect(STRINGS.es['mi.noMassOnDate']).toBe('No hay Misa el {date}')
    expect(STRINGS.en['mi.otherCalendarEntries']).toBe('Other calendar entries')
    expect(STRINGS.es['mi.otherCalendarEntries']).toBe('Otras entradas del calendario')
    expect(STRINGS.es['mi.addMassOnDate']).toMatch(/Misa/)
    expect(STRINGS.es['mi.dateDisagrees']).toBe('Escribió {entered}, pero esta Misa es {massDate}')
    expect(STRINGS.es['mi.useMassDate']).toMatch(/Misa/)
    expect(STRINGS.es['mi.clearAssignment']).toMatch(/asignación/)
    expect(STRINGS.en['mi.notAMass']).toBe("That calendar entry isn't a Mass")
    expect(STRINGS.es['mi.notAMass']).toBe('Esa entrada del calendario no es una Misa')
    expect(STRINGS.en['mi.stampedHistory']).toMatch(/Nothing was lost/)
    expect(STRINGS.en['mi.stampConflict']).toMatch(/Nothing was changed/)
    expect(STRINGS.es['mi.stampedHistory']).toMatch(/No se perdió nada/)
    expect(STRINGS.es['mi.stampConflict']).toMatch(/No se cambió nada/)
    expect(STRINGS.es['mi.stampedHistory']).not.toBe(STRINGS.en['mi.stampedHistory'])
    expect(STRINGS.es['mi.stampConflict']).not.toBe(STRINGS.en['mi.stampConflict'])
    expect(STRINGS.es['mi.dateConflictRefused']).toMatch(/no se guardó nada/)
    expect(STRINGS.es['mi.dateConflictRefused']).not.toBe(STRINGS.en['mi.dateConflictRefused'])
    expect(STRINGS.en['err.save']).toMatch(/nothing was lost/i)
    expect(STRINGS.es['err.save']).toMatch(/no se perdió nada/i)
    expect(STRINGS.es['err.save']).not.toBe(STRINGS.en['err.save'])
    expect(STRINGS.es['sched.backIntention']).toMatch(/intención/)
    expect(STRINGS.es['mi.noMassOnDate']).not.toBe(STRINGS.en['mi.noMassOnDate'])
  })
})

describe('Assign dropdown follows the Mass date', () => {
  it('shows only Masses on the chosen day, and none when that day is empty', async () => {
    stubFetch()
    renderBook()
    fireEvent.click(await screen.findByRole('button', { name: /add intention/i }))
    await waitFor(() => {
      expect(optionValues()).toEqual(expect.arrayContaining(['4', '5', '6', '11']))
    })
    expect(optionValues()).not.toContain('40')
    expect(optionValues()).not.toContain('41')
    fireEvent.change(screen.getByLabelText(/^mass date$/i), { target: { value: '2026-10-04' } })
    await waitFor(() => {
      expect(optionValues()).toEqual(['', '4', '5', '6'])
    })
    expect(optionValues()).not.toContain('11')
    expect(optionValues()).not.toContain('99')

    fireEvent.change(screen.getByLabelText(/^mass date$/i), { target: { value: '2026-10-18' } })
    const note = await screen.findByTestId('no-mass-on-date')
    expect(note.textContent).toMatch(/No Mass on Sun, Oct 18/)
    const link = screen.getByRole('link', { name: /add a mass on this date/i })
    expect(link.getAttribute('href')).toMatch(/^\/schedule\?new=1&return=intention&date=2026-10-18&draft=[0-9a-f-]{36}$/i)
    expect(optionValues()).toEqual([''])
    expect(optionValues()).not.toContain('41')
  })

  it('lists an event-typed Mass in Other calendar entries, and says No Mass only when nothing is assignable', async () => {
    const service = { id: 4, title: 'Sunday Mass', date: '2026-10-04', start_time: '08:00:00', type: 'service' }
    const storedEvent = { id: 71, title: '10:30 Mass', date: '2026-10-04', start_time: '10:30:00', type: 'event' }
    const meeting = { id: 40, title: 'Finance meeting', date: '2026-10-04', start_time: '19:00:00', type: 'meeting' }
    const onlyEvent = { id: 80, title: 'Vigil', date: '2026-10-18', start_time: '17:00:00', type: 'event' }
    const onlyMeeting = { id: 81, title: 'Vestry', date: '2026-11-01', start_time: '19:00:00', type: 'meeting' }
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      if (u.includes('start=2026-10-04')) return ok([service, storedEvent, meeting])
      if (u.includes('start=2026-10-18')) return ok([onlyEvent])
      if (u.includes('start=2026-11-01')) return ok([onlyMeeting])
      if (u.includes('/api/calendar')) return ok([service, storedEvent, meeting, onlyEvent, onlyMeeting])
      if (u.includes('/api/mass-intentions')) return ok({ intentions: [] })
      return ok({})
    }))
    renderBook()
    fireEvent.click(await screen.findByRole('button', { name: /add intention/i }))
    fireEvent.change(screen.getByLabelText(/^mass date$/i), { target: { value: '2026-10-04' } })
    await waitFor(() => expect(optionValues()).toEqual(['', '4', '71']))
    const eventOption = assignSelect().querySelector('option[value="71"]')
    expect(eventOption.parentElement.tagName).toBe('OPTGROUP')
    expect(eventOption.parentElement.label).toBe('Other calendar entries')
    const serviceOption = assignSelect().querySelector('option[value="4"]')
    expect(serviceOption.parentElement.tagName).toBe('SELECT')
    expect(screen.queryByTestId('no-mass-on-date')).toBeNull()
    expect(optionValues()).not.toContain('40')

    fireEvent.change(screen.getByLabelText(/^mass date$/i), { target: { value: '2026-10-18' } })
    await waitFor(() => expect(optionValues()).toEqual(['', '80']))
    expect(assignSelect().querySelector('option[value="80"]').parentElement.label).toBe('Other calendar entries')
    expect(screen.queryByTestId('no-mass-on-date')).toBeNull()

    fireEvent.change(screen.getByLabelText(/^mass date$/i), { target: { value: '2026-11-01' } })
    const note = await screen.findByTestId('no-mass-on-date')
    expect(note.textContent).toMatch(/No Mass on Sun, Nov 1/)
    expect(optionValues()).toEqual([''])
  })

  it('does not say No Mass when the day lookup fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      if (u.includes('start=2026-10-18')) return { ok: false, status: 500, json: async () => ({}) }
      const m = u.match(/\/api\/calendar\/(\d+)/)
      if (m) return notFound()
      if (u.includes('/api/calendar')) return ok(ALL)
      if (u.includes('/api/mass-intentions')) return ok({ intentions: [] })
      return ok({})
    }))
    renderBook()
    fireEvent.click(await screen.findByRole('button', { name: /add intention/i }))
    fireEvent.change(screen.getByLabelText(/^mass date$/i), { target: { value: '2026-10-18' } })
    expect(await screen.findByText(/couldn't check which masses/i)).toBeInTheDocument()
    expect(screen.queryByTestId('no-mass-on-date')).toBeNull()
  })

  it('does not say No Mass from the window alone when the day lookup finds a Mass', async () => {
    let releaseDay
    const dayReady = new Promise((resolve) => { releaseDay = resolve })
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      if (u.includes('start=2026-12-25')) {
        await dayReady
        return ok([CHRISTMAS])
      }
      const m = u.match(/\/api\/calendar\/(\d+)/)
      if (m) return m[1] === '25' ? ok(CHRISTMAS) : notFound()
      if (u.includes('/api/calendar')) return ok(ALL)
      if (u.includes('/api/mass-intentions')) return ok({ intentions: [] })
      return ok({})
    }))
    renderBook()
    fireEvent.click(await screen.findByRole('button', { name: /add intention/i }))
    fireEvent.change(screen.getByLabelText(/^mass date$/i), { target: { value: '2026-12-25' } })
    await waitFor(() => {
      expect(fetch.mock.calls.some(c => String(c[0]).includes('start=2026-12-25'))).toBe(true)
    })
    expect(screen.queryByTestId('no-mass-on-date')).toBeNull()
    releaseDay()
    await waitFor(() => expect(optionValues()).toContain('25'))
    expect(screen.queryByTestId('no-mass-on-date')).toBeNull()
  })

  it('leaves an unchanged unknown Mass off the request', async () => {
    stubFetch({
      intentions: [{
        id: 9,
        intention: 'For the parish',
        requested_by: 'The family',
        calendar_event_id: 77,
        mass_date: '2026-12-25',
        status: 'scheduled',
      }],
    })
    renderBook()
    fireEvent.click(await screen.findByRole('button', { name: /edit intention/i }))
    await waitFor(() => expect(assignSelect().value).toBe('77'))
    fireEvent.change(screen.getByLabelText(/^note$/i), { target: { value: 'vespers' } })
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()[0].body.note).toBe('vespers')
    expect(writes()[0].body.calendar_event_id).toBeUndefined()
    expect(writes()[0].body.mass_date).toBeUndefined()
    expect(screen.queryByText(/isn't known yet/i)).toBeNull()
  })

  it('does not send a new Mass whose day is unknown', async () => {
    stubFetch()
    renderBook()
    fireEvent.click(await screen.findByRole('button', { name: /add intention/i }))
    fireEvent.change(screen.getByLabelText(/^intention$/i), { target: { value: 'For the parish' } })
    await waitFor(() => expect(optionValues()).toContain('99'))
    fireEvent.change(assignSelect(), { target: { value: '99' } })
    expect(assignSelect().value).toBe('99')
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(writes()).toEqual([])
    expect(await screen.findByText(/isn't known yet/i)).toBeInTheDocument()
  })

  it('picking a Mass sets the date, and a different date keeps that Mass selected', async () => {
    stubFetch()
    renderBook()
    fireEvent.click(await screen.findByRole('button', { name: /add intention/i }))
    await waitFor(() => expect(optionValues()).toContain('11'))
    fireEvent.change(assignSelect(), { target: { value: '11' } })
    expect(screen.getByLabelText(/^mass date$/i).value).toBe('2026-10-11')
    await waitFor(() => expect(optionValues()).toEqual(['', '11']))

    fireEvent.change(screen.getByLabelText(/^mass date$/i), { target: { value: '2026-10-04' } })
    expect(assignSelect().value).toBe('11')
    const conflict = await screen.findByTestId('save-date-conflict')
    expect(conflict.textContent).toMatch(/You entered Sun, Oct 4, but this Mass is Sun, Oct 11/)
    expect(optionValues()).toContain('11')
    expect(optionValues()).toEqual(expect.arrayContaining(['', '4', '5', '6', '11']))
  })

  async function typeOct4OverMondayMass() {
    stubFetch({ list: [...ALL, OCT5], byId: { 15: OCT5, 4: OCT4_EARLY, 11: OCT11 } })
    renderBook()
    fireEvent.click(await screen.findByRole('button', { name: /add intention/i }))
    fireEvent.change(screen.getByLabelText(/^intention$/i), { target: { value: 'For the parish' } })
    await waitFor(() => expect(optionValues()).toContain('15'))
    fireEvent.change(assignSelect(), { target: { value: '15' } })
    expect(screen.getByLabelText(/^mass date$/i).value).toBe('2026-10-05')
    fireEvent.change(screen.getByLabelText(/^mass date$/i), { target: { value: '2026-10-04' } })
    expect(assignSelect().value).toBe('15')
    const conflict = await screen.findByTestId('save-date-conflict')
    expect(conflict.textContent).toMatch(/You entered Sun, Oct 4, but this Mass is Mon, Oct 5/)
    return conflict
  }

  it('save does not send a typed day with a Mass on another day', async () => {
    await typeOct4OverMondayMass()
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(writes()).toEqual([])
    expect(screen.getByTestId('save-date-conflict')).toBeInTheDocument()
  })

  it('using the Mass date saves that day with the Mass', async () => {
    await typeOct4OverMondayMass()
    fireEvent.click(screen.getByRole('button', { name: /use the mass's date/i }))
    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()[0]).toMatchObject({
      method: 'POST',
      body: { mass_date: '2026-10-05', calendar_event_id: 15, intention: 'For the parish' },
    })
  })

  it('clearing the assignment saves the typed day with no Mass', async () => {
    await typeOct4OverMondayMass()
    fireEvent.click(screen.getByRole('button', { name: /clear the assignment/i }))
    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()[0].method).toBe('POST')
    expect(writes()[0].body.mass_date).toBe('2026-10-04')
    expect(writes()[0].body.calendar_event_id).toBeUndefined()
    expect(writes()[0].body.status).toBe('open')
  })

  it('an already-saved mismatch stays selected and says the days disagree', async () => {
    stubFetch({
      intentions: [{
        id: 9,
        intention: 'For a safe journey',
        requested_by: 'The family',
        calendar_event_id: 4,
        mass_date: '2026-10-18',
        status: 'scheduled',
      }],
    })
    renderBook()
    fireEvent.click(await screen.findByRole('button', { name: /edit intention/i }))
    await waitFor(() => expect(assignSelect().value).toBe('4'))
    const note = await screen.findByTestId('save-date-conflict')
    expect(note.textContent).toMatch(/You entered Sun, Oct 18, but this Mass is Sun, Oct 4/)
    expect(assignSelect().value).toBe('4')
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
    expect(writes()).toEqual([])
  })

  it('a 409 says the date was not the Mass and that nothing was saved', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      const u = String(url)
      const m = u.match(/\/api\/calendar\/(\d+)/)
      if (m) return byIdOk(m[1])
      if (u.includes('/api/calendar')) return ok(ALL)
      if (opts?.method === 'PATCH') {
        return { ok: false, status: 409, json: async () => ({ error: 'That date is not the assigned Mass. Nothing was changed.', code: 'date_conflict' }) }
      }
      if (u.includes('/api/mass-intentions')) {
        return ok({
          intentions: [{
            id: 9,
            intention: 'For the parish',
            requested_by: 'The family',
            calendar_event_id: 4,
            mass_date: '2026-10-04',
            status: 'scheduled',
          }],
        })
      }
      return ok({})
    }))
    function byIdOk(id) {
      const ev = ALL.find(m => String(m.id) === String(id))
      return ev ? ok(ev) : notFound()
    }
    renderBook()
    fireEvent.click(await screen.findByRole('button', { name: /edit intention/i }))
    await waitFor(() => expect(assignSelect().value).toBe('4'))
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/nothing was saved/i)
    expect(alert.textContent).not.toMatch(/Nothing was changed/)
    expect(screen.getByLabelText(/^intention$/i)).toBeInTheDocument()
  })

  it('a non-Mass 409 says the calendar entry is not a Mass', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      const u = String(url)
      const m = u.match(/\/api\/calendar\/(\d+)/)
      if (m) {
        const ev = ALL.find(row => String(row.id) === String(m[1]))
        return ev ? ok(ev) : notFound()
      }
      if (u.includes('/api/calendar')) return ok(ALL)
      if (opts?.method === 'PATCH') {
        return { ok: false, status: 409, json: async () => ({ error: "That isn't a Mass. Nothing was changed.", code: 'not_a_mass' }) }
      }
      if (u.includes('/api/mass-intentions')) {
        return ok({
          intentions: [{
            id: 9,
            intention: 'For the parish',
            requested_by: 'The family',
            calendar_event_id: 4,
            mass_date: '2026-10-04',
            status: 'scheduled',
          }],
        })
      }
      return ok({})
    }))
    renderBook()
    fireEvent.click(await screen.findByRole('button', { name: /edit intention/i }))
    await waitFor(() => expect(assignSelect().value).toBe('4'))
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe("That calendar entry isn't a Mass")
    expect(alert.textContent).not.toMatch(/nothing was saved/i)
  })

  it('a stamped-history 409 says the link was not changed', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      const u = String(url)
      const m = u.match(/\/api\/calendar\/(\d+)/)
      if (m) {
        const ev = ALL.find(row => String(row.id) === String(m[1]))
        return ev ? ok(ev) : notFound()
      }
      if (u.includes('/api/calendar')) return ok(ALL)
      if (opts?.method === 'PATCH') {
        return {
          ok: false,
          status: 409,
          json: async () => ({
            error: 'This intention was already recorded at a Mass. The link was not changed. Nothing was lost.',
            code: 'stamped_history',
          }),
        }
      }
      if (u.includes('/api/mass-intentions')) {
        return ok({
          intentions: [{
            id: 9,
            intention: 'For the parish',
            requested_by: 'The family',
            calendar_event_id: 4,
            mass_date: '2026-10-04',
            status: 'scheduled',
          }],
        })
      }
      return ok({})
    }))
    renderBook()
    fireEvent.click(await screen.findByRole('button', { name: /edit intention/i }))
    await waitFor(() => expect(assignSelect().value).toBe('4'))
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(STRINGS.en['mi.stampedHistory'])
    expect(alert.textContent).not.toMatch(/nothing was saved/i)
  })

  it('a stamp-conflict 409 says the recorded Mass changed and nothing was changed', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      const u = String(url)
      const m = u.match(/\/api\/calendar\/(\d+)/)
      if (m) {
        const ev = ALL.find(row => String(row.id) === String(m[1]))
        return ev ? ok(ev) : notFound()
      }
      if (u.includes('/api/calendar')) return ok(ALL)
      if (opts?.method === 'PATCH') {
        return {
          ok: false,
          status: 409,
          json: async () => ({
            error: 'This intention was already recorded at a Mass whose day, name, or time has changed. Nothing was changed.',
            code: 'stamp_conflict',
          }),
        }
      }
      if (u.includes('/api/mass-intentions')) {
        return ok({
          intentions: [{
            id: 9,
            intention: 'For the parish',
            requested_by: 'The family',
            calendar_event_id: 4,
            mass_date: '2026-10-04',
            status: 'scheduled',
          }],
        })
      }
      return ok({})
    }))
    renderBook()
    fireEvent.click(await screen.findByRole('button', { name: /edit intention/i }))
    await waitFor(() => expect(assignSelect().value).toBe('4'))
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(STRINGS.en['mi.stampConflict'])
    expect(alert.textContent).not.toMatch(/nothing was saved/i)
  })

  it('a 409 that is not a date conflict says the save failed and nothing was lost', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      const u = String(url)
      const m = u.match(/\/api\/calendar\/(\d+)/)
      if (m) {
        const ev = ALL.find(row => String(row.id) === String(m[1]))
        return ev ? ok(ev) : notFound()
      }
      if (u.includes('/api/calendar')) return ok(ALL)
      if (opts?.method === 'PATCH') {
        return {
          ok: false,
          status: 409,
          json: async () => ({ error: 'This intention is not offered at a Mass yet — nothing was lost.' }),
        }
      }
      if (u.includes('/api/mass-intentions')) {
        return ok({
          intentions: [{
            id: 9,
            intention: 'For the parish',
            requested_by: 'The family',
            calendar_event_id: 4,
            mass_date: '2026-10-04',
            status: 'scheduled',
          }],
        })
      }
      return ok({})
    }))
    renderBook()
    fireEvent.click(await screen.findByRole('button', { name: /edit intention/i }))
    await waitFor(() => expect(assignSelect().value).toBe('4'))
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/nothing was lost/i)
    expect(alert.textContent).not.toMatch(/nothing was saved/i)
    expect(alert.textContent).not.toMatch(/isn't a Mass/)
  })

  it('does not pre-select a meeting opened from the schedule', async () => {
    stubFetch({ byId: { 40: { ...OCT4_MEETING, type: 'Meeting' }, 43: { ...OCT4_MEETING, id: 43, type: ' meeting ' } } })
    const first = renderBook('/mass-intentions?event=40&date=2026-10-04&compose=1')
    const select = await screen.findByLabelText(/assign to mass/i)
    await waitFor(() => expect(select.value).toBe(''))
    expect(optionValues()).not.toContain('40')
    first.unmount()
    renderBook('/mass-intentions?event=43&date=2026-10-04&compose=1')
    const again = await screen.findByLabelText(/assign to mass/i)
    await waitFor(() => expect(again.value).toBe(''))
    expect(optionValues()).not.toContain('43')
  })

  it('returning from Schedule restores the intention and adopts the new Mass', async () => {
    const nonce = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    stashIntentionDraft({
      form: {
        intention: 'For the Rivera family',
        requested_by: 'Ana',
        mass_date: '2026-10-04',
        calendar_event_id: '',
        stipend: '',
        status: 'open',
        note: 'morning',
        departed: false,
      },
      editingId: null,
      nonce,
    })
    stubFetch({ byId: { 6: OCT4_UTC } })
    renderBook(`/mass-intentions?event=6&date=2026-10-04&resume=${nonce}`)
    await waitFor(() => {
      expect(screen.getByLabelText(/^intention$/i).value).toBe('For the Rivera family')
    })
    expect(screen.getByLabelText(/requested by/i).value).toBe('Ana')
    expect(screen.getByLabelText(/^mass date$/i).value).toBe('2026-10-04')
    await waitFor(() => expect(assignSelect().value).toBe('6'))
    await waitFor(() => expect(peekIntentionDraft()).toBeNull())
  })

  it('the add-a-Mass link keeps the in-progress intention for the return', async () => {
    stubFetch()
    renderBook()
    fireEvent.click(await screen.findByRole('button', { name: /add intention/i }))
    fireEvent.change(screen.getByLabelText(/^intention$/i), { target: { value: 'For the Rivera family' } })
    fireEvent.change(screen.getByLabelText(/^mass date$/i), { target: { value: '2026-10-18' } })
    const link = await screen.findByRole('link', { name: /add a mass on this date/i })
    expect(link.getAttribute('href')).toMatch(/[?&]draft=[0-9a-f-]{36}/i)
    fireEvent.click(link)
    const draft = peekIntentionDraft()
    const nonce = new URL(link.getAttribute('href'), 'http://local').searchParams.get('draft')
    expect(draft.form.intention).toBe('For the Rivera family')
    expect(draft.form.mass_date).toBe('2026-10-18')
    expect(draft.nonce).toBe(nonce)
    takeIntentionDraft()
  })

  it('resume=1 does not restore a draft or its editing id, and does not consume it', async () => {
    stashIntentionDraft({
      form: {
        intention: 'Stale draft',
        requested_by: 'Old',
        mass_date: '2026-01-01',
        calendar_event_id: '',
        stipend: '',
        status: 'open',
        note: '',
        departed: false,
      },
      editingId: 44,
      nonce: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    })
    stubFetch({ byId: { 6: OCT4_UTC } })
    renderBook('/mass-intentions?event=6&date=2026-10-04&resume=1')
    await waitFor(() => expect(screen.getByLabelText(/^mass date$/i).value).toBe('2026-10-04'))
    expect(screen.getByLabelText(/^intention$/i).value).toBe('')
    expect(screen.queryByRole('button', { name: /save changes/i })).toBeNull()
    expect(peekIntentionDraft()?.form.intention).toBe('Stale draft')
    expect(peekIntentionDraft()?.editingId).toBe(44)
  })

  it('a resume nonce that does not match the draft does not restore the editing id', async () => {
    stashIntentionDraft({
      form: {
        intention: 'Stale draft',
        requested_by: 'Old',
        mass_date: '2026-01-01',
        calendar_event_id: '',
        stipend: '',
        status: 'open',
        note: '',
        departed: false,
      },
      editingId: 44,
      nonce: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    })
    stubFetch({ byId: { 6: OCT4_UTC } })
    renderBook('/mass-intentions?event=6&date=2026-10-04&resume=bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee')
    await waitFor(() => expect(screen.getByLabelText(/^mass date$/i).value).toBe('2026-10-04'))
    expect(screen.getByLabelText(/^intention$/i).value).toBe('')
    expect(screen.queryByRole('button', { name: /save changes/i })).toBeNull()
    expect(peekIntentionDraft()?.editingId).toBe(44)
  })

  it('an expired draft is not restored', async () => {
    const nonce = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    stashIntentionDraft({
      form: {
        intention: 'Expired draft',
        requested_by: 'Old',
        mass_date: '2026-01-01',
        calendar_event_id: '',
        stipend: '',
        status: 'open',
        note: '',
        departed: false,
      },
      editingId: 44,
      nonce,
      now: Date.now() - INTENTION_DRAFT_TTL_MS - 1000,
    })
    stubFetch({ byId: { 6: OCT4_UTC } })
    renderBook(`/mass-intentions?event=6&date=2026-10-04&resume=${nonce}`)
    await waitFor(() => expect(screen.getByLabelText(/^mass date$/i).value).toBe('2026-10-04'))
    expect(screen.getByLabelText(/^intention$/i).value).toBe('')
    expect(screen.queryByRole('button', { name: /save changes/i })).toBeNull()
    expect(peekIntentionDraft()).toBeNull()
  })

  it('a note on a fulfilled row with a blank date omits the link and the date', async () => {
    stubFetch({
      intentions: [{
        id: 9,
        intention: 'For the parish',
        requested_by: 'The family',
        calendar_event_id: 77,
        mass_date: '',
        status: 'fulfilled',
        note: '',
      }],
    })
    renderBook()
    fireEvent.click(await screen.findByRole('button', { name: /edit intention/i }))
    await waitFor(() => expect(assignSelect().value).toBe('77'))
    fireEvent.change(screen.getByLabelText(/^note$/i), { target: { value: 'said at the rail' } })
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()[0].method).toBe('PATCH')
    expect(writes()[0].body.note).toBe('said at the rail')
    expect(writes()[0].body.calendar_event_id).toBeUndefined()
    expect(writes()[0].body.mass_date).toBeUndefined()
    expect(screen.queryByText(/isn't known yet/i)).toBeNull()
    expect(screen.queryByTestId('save-date-conflict')).toBeNull()
  })

  it('a note on a fulfilled row whose Mass later moved omits the stamp and the link', async () => {
    stubFetch({
      list: [...ALL, OCT5],
      byId: { 15: OCT5 },
      intentions: [{
        id: 9,
        intention: 'For the parish',
        requested_by: 'The family',
        calendar_event_id: 15,
        mass_date: '2026-10-04',
        status: 'fulfilled',
        note: '',
      }],
    })
    renderBook()
    fireEvent.click(await screen.findByRole('button', { name: /edit intention/i }))
    await waitFor(() => expect(assignSelect().value).toBe('15'))
    expect(screen.queryByTestId('save-date-conflict')).toBeNull()
    fireEvent.change(screen.getByLabelText(/^note$/i), { target: { value: 'offered' } })
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()[0].body.note).toBe('offered')
    expect(writes()[0].body.calendar_event_id).toBeUndefined()
    expect(writes()[0].body.mass_date).toBeUndefined()
  })
})
