// SP-076 / SP-078. The secretary adds a Mass for an empty day and comes
// back to the intention they were writing.
// Mutate any one of these and the matching test goes red:
//   1. The new Mass is not the selected Assign option before the calendar
//      read returns (a "Looking up…" label is not the Mass they just saved)
//   2. Success is announced before the server confirms the write, or a
//      failed write is announced as success
//   3. The empty-day note, the Assign option, the book row, and the toast
//      do not share one locale date (weekday, month, day, year)

import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { TRADITION_STRINGS } from '../i18n/traditions'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import MassIntentions from './MassIntentions'
import Schedule from './Schedule'
import { attachCreatedMass, peekIntentionDraft, stashIntentionDraft } from '../utils/intentionDraft'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: {
      id: 1,
      name: 'Secretary',
      role: 'admin',
      organization: {
        id: 1,
        name: 'St Test',
        locale: 'en',
        tradition: 'catholic',
        timezone: 'America/Los_Angeles',
      },
    },
    token: 't',
    loading: false,
    canWrite: true,
    isAdmin: true,
  }),
}))

const DAY = '2026-10-18'
const EN_DAY = 'Sun, Oct 18, 2026'
const ES_DAY = 'dom, 18 oct 2026'
const TITLE = 'Sunday Morning Mass'
const NONCE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const SAVED_NOT_SELECTED = 'The Mass was saved, but it could not be selected on the intention.'
const UNCONFIRMED = "The schedule's answer could not be confirmed, so this Mass was not selected."

const ok = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

let posted = false
let postMode = 'ok'
let badId = null
let heldAnswer = 'mass'
let pending = []

function releaseHeld() {
  const waiting = pending
  pending = []
  for (const resolve of waiting) resolve()
}

function hang() {
  return new Promise((resolve) => { pending.push(resolve) })
}

function stubFetch() {
  posted = false
  heldAnswer = postMode === 'missing' ? 'missing' : 'mass'
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url)
    const method = opts.method || 'GET'
    if (method === 'POST' && /\/api\/calendar(?:\?|$)/.test(u)) {
      posted = true
      const body = JSON.parse(opts.body)
      if (postMode === 'throw') throw new Error('offline')
      if (postMode === '500') return { ok: false, status: 500, json: async () => ({ error: 'refused' }) }
      if (postMode === 'noid') return ok({ title: body.title, date: body.date }, 201)
      const created = {
        id: postMode === 'stringid' ? '80' : 80,
        title: body.title,
        date: body.date,
        start_time: body.start_time,
        end_time: body.end_time,
        type: body.type,
      }
      if (postMode === 'badid') created.id = badId
      const status = postMode === '200' ? 200 : postMode === '202' ? 202 : 201
      return ok(created, status)
    }
    if (posted && method === 'GET' && /\/api\/calendar(?:\/\d+)?(?:\?|$)/.test(u)) {
      await hang()
      if (/\/api\/calendar\/80(?:\?|$)/.test(u)) {
        if (heldAnswer === 'missing') return { ok: false, status: 404, json: async () => ({ error: 'Event not found' }) }
        return ok({ id: 80, title: TITLE, date: DAY, start_time: '10:00:00', end_time: '11:00:00', type: 'service' })
      }
      if (u.includes(`start=${DAY}`)) {
        if (heldAnswer === 'missing') return ok([])
        return ok([{ id: 80, title: TITLE, date: DAY, start_time: '10:00:00', end_time: '11:00:00', type: 'service' }])
      }
      return ok([])
    }
    if (u.includes('/api/calendar')) return ok([])
    if (u.includes('/api/liturgical')) return ok({})
    if (u.includes('/api/mass-intentions')) return ok({ intentions: [] })
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

function view(path = '/mass-intentions') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <LocaleProvider>
        <ToastProvider>
          <ConfirmProvider>
            <LocationProbe />
            <Routes>
              <Route path="/mass-intentions" element={<MassIntentions />} />
              <Route path="/schedule" element={<Schedule />} />
            </Routes>
          </ConfirmProvider>
        </ToastProvider>
      </LocaleProvider>
    </MemoryRouter>,
  )
}

function calendarPosts() {
  return vi.mocked(fetch).mock.calls.filter((call) => {
    const [url, opts] = call
    return opts?.method === 'POST' && /\/api\/calendar(?:\?|$)/.test(String(url))
  })
}

function stashOpenDraft() {
  stashIntentionDraft({
    form: {
      intention: 'For the Rivera family',
      requested_by: '',
      mass_date: DAY,
      stipend: '',
      status: 'open',
      note: '',
      calendar_event_id: '',
      departed: false,
    },
    editingId: null,
    nonce: NONCE,
  })
}

function returnPath() {
  return `/schedule?new=1&return=intention&date=${DAY}&draft=${NONCE}`
}

function notices() {
  return screen.getByRole('region', { name: /notif/i }).textContent
}

async function openEmptyDay() {
  fireEvent.click(await screen.findByRole('button', { name: /add intention|agregar intención/i }))
  fireEvent.change(screen.getByLabelText(/^intention$|^intención$/i), { target: { value: 'For the Rivera family' } })
  fireEvent.change(screen.getByLabelText(/^mass date$|^fecha de la misa$/i), { target: { value: DAY } })
  return screen.findByTestId('no-mass-on-date')
}

async function saveNewMass() {
  // The dialog heading is translated now (App Review 2026-10-26).
  await waitFor(() => expect(screen.getByText(/^(New Event|Nuevo evento)$/)).toBeInTheDocument())
  fireEvent.change(screen.getByLabelText(/^(Title|Título)/), { target: { value: TITLE } })
  const times = [...document.querySelectorAll('input[type="time"]')]
  fireEvent.change(times[0], { target: { value: '10:00' } })
  fireEvent.change(times[1], { target: { value: '11:00' } })
  const submit = screen.getAllByRole('button', { name: /^(Add Event|Agregar evento)$/ }).find(b => b.className.includes('rounded-lg'))
  fireEvent.click(submit)
}

beforeEach(() => {
  posted = false
  postMode = 'ok'
  badId = null
  heldAnswer = 'mass'
  pending = []
  sessionStorage.clear()
  localStorage.removeItem('ochr_locale')
})

afterEach(() => {
  releaseHeld()
  vi.unstubAllGlobals()
  sessionStorage.clear()
  localStorage.removeItem('ochr_locale')
})

describe('SP-076 / SP-078 add a Mass and return to the intention', () => {
  it('pre-selects the new Mass and confirms it only after the write, in one date format', async () => {
    stubFetch()
    view()
    const note = await openEmptyDay()
    expect.soft(note.textContent).toContain(EN_DAY)
    expect.soft(note.textContent).not.toMatch(/2026-10-18/)

    fireEvent.click(screen.getByRole('link', { name: /add a mass on this date/i }))
    await saveNewMass()

    const select = await screen.findByLabelText(/assign to mass/i)
    await waitFor(() => expect(select.value).toBe('80'))
    const chosen = select.options[select.selectedIndex]
    expect.soft(select.selectedIndex).toBeGreaterThan(0)
    expect.soft(chosen.textContent).toContain(TITLE)
    expect.soft(chosen.textContent).toContain(EN_DAY)
    expect.soft(chosen.textContent).not.toMatch(/Looking up/i)
    expect.soft(chosen.textContent).not.toMatch(/2026-10-18/)
    expect.soft(screen.getByLabelText(/^status$/i).value).toBe('scheduled')
    expect.soft(screen.getByLabelText(/^intention$/i).value).toBe('For the Rivera family')
    expect.soft(notices()).toContain(`Mass added for ${EN_DAY}.`)
    expect.soft(notices()).not.toMatch(/save failed/i)

    const heldNode = chosen
    releaseHeld()
    await waitFor(() => expect(select.options[select.selectedIndex].textContent).toContain(TITLE))
    expect(select.options[select.selectedIndex]).toBe(heldNode)
    expect(select.value).toBe('80')
    expect(select.selectedIndex).toBeGreaterThan(0)
    expect(notices()).toContain(`Mass added for ${EN_DAY}.`)
  })

  it('uses the same Spanish date on the empty day, the new Mass, and the confirmation', async () => {
    localStorage.setItem('ochr_locale', 'es')
    stubFetch()
    view()
    const note = await openEmptyDay()
    expect.soft(note.textContent).toContain(ES_DAY)
    expect.soft(note.textContent).not.toMatch(/2026-10-18/)

    fireEvent.click(screen.getByRole('link', { name: /agregar una misa en esta fecha/i }))
    await saveNewMass()

    const select = await screen.findByLabelText(/asignar a una misa/i)
    await waitFor(() => expect(select.value).toBe('80'))
    expect.soft(select.options[select.selectedIndex].textContent).toContain(ES_DAY)
    expect.soft(select.options[select.selectedIndex].textContent).toContain(TITLE)
    expect.soft(notices()).toContain(`Misa agregada para el ${ES_DAY}.`)
    expect.soft(notices()).not.toMatch(/Mass added/i)
  })

  it('drops a seeded title when this church has no such Mass', async () => {
    postMode = 'missing'
    stubFetch()
    view()
    await openEmptyDay()
    fireEvent.click(screen.getByRole('link', { name: /add a mass on this date/i }))
    await saveNewMass()
    const select = await screen.findByLabelText(/assign to mass/i)
    await waitFor(() => expect(select.options[select.selectedIndex].textContent).toContain(TITLE))
    releaseHeld()
    await waitFor(() => expect(select.options[select.selectedIndex].textContent).toMatch(/isn't on this church's schedule/i))
    expect(select.options[select.selectedIndex].textContent).not.toContain(TITLE)
    expect(select.value).toBe('80')
  })

  it('shows the book row in that same date, not a shorter month-and-day line', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      if (u.includes('/api/mass-intentions')) {
        return ok({
          intentions: [{
            id: 3,
            intention: 'For the parish',
            requested_by: 'The family',
            mass_date: DAY,
            mass_title: 'Sunday Mass',
            mass_time: '10:00',
            status: 'scheduled',
          }],
        })
      }
      if (u.includes('/api/calendar')) return ok([])
      return ok({})
    }))
    view()
    const row = (await screen.findByText('For the parish')).closest('tr')
    expect(row.textContent).toContain(EN_DAY)
    expect(row.textContent).not.toMatch(/2026-10-18/)
  })

  it('a refused save never announces the Mass as added', async () => {
    postMode = '500'
    stubFetch()
    view(`/schedule?new=1&return=intention&date=${DAY}&draft=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee`)
    await saveNewMass()
    await waitFor(() => expect(notices()).toMatch(/refused|save failed/i))
    expect(notices()).not.toMatch(/Mass added/i)
    expect(screen.getByText('New Event')).toBeInTheDocument()
  })

  it('a lost connection never announces the Mass as added', async () => {
    postMode = 'throw'
    stubFetch()
    view(`/schedule?new=1&return=intention&date=${DAY}&draft=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee`)
    await saveNewMass()
    await waitFor(() => expect(notices()).toMatch(/didn't save/i))
    expect(notices()).not.toMatch(/Mass added/i)
  })

  it('a confirmed write with no readable Mass id does not announce success or say the save failed', async () => {
    postMode = 'noid'
    stubFetch()
    view(`/schedule?new=1&return=intention&date=${DAY}&draft=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee`)
    await saveNewMass()
    await waitFor(() => expect(screen.queryByText('New Event')).toBeNull())
    expect(notices()).toBe(SAVED_NOT_SELECTED)
    expect(notices()).not.toMatch(/Mass added/i)
    expect(notices()).not.toMatch(/nothing else was lost/i)
    expect(notices()).not.toMatch(/save failed/i)
    expect(screen.getByTestId('loc').textContent).toMatch(/^\/schedule/)
    expect(calendarPosts()).toHaveLength(1)
  })

  it.each([
    ['200', 200],
    ['202', 202],
  ])('a %s with an id does not announce or adopt the Mass, and does not post again', async (mode) => {
    postMode = mode
    stubFetch()
    stashOpenDraft()
    view(returnPath())
    await saveNewMass()
    await waitFor(() => expect(notices()).toBe(UNCONFIRMED))
    expect(notices()).not.toMatch(/Mass added/i)
    expect(notices()).not.toMatch(/could not be selected/i)
    expect(notices()).not.toMatch(/nothing else was lost/i)
    expect(screen.getByTestId('loc').textContent).toMatch(/^\/schedule/)
    expect(peekIntentionDraft()?.createdMass).toBeUndefined()
    expect(peekIntentionDraft()?.form.calendar_event_id).toBe('')
    expect(calendarPosts()).toHaveLength(1)
  })

  it.each([
    ['array', [80]],
    ['object', { n: 80 }],
    ['boolean', true],
    ['fraction', 1.5],
    ['zero', 0],
    ['negative', -3],
    ['decimal string', '80.0'],
    ['padded string', '080'],
    ['unsafe magnitude', Number.MAX_SAFE_INTEGER + 1],
  ])('a 201 whose id is %s is not adopted', async (_label, id) => {
    postMode = 'badid'
    badId = id
    stubFetch()
    stashOpenDraft()
    view(returnPath())
    await saveNewMass()
    await waitFor(() => expect(notices()).toBe(SAVED_NOT_SELECTED))
    expect(notices()).not.toMatch(/Mass added/i)
    expect(screen.getByTestId('loc').textContent).toMatch(/^\/schedule/)
    expect(peekIntentionDraft()?.createdMass).toBeUndefined()
    expect(peekIntentionDraft()?.form.calendar_event_id).toBe('')
    expect(calendarPosts()).toHaveLength(1)
  })

  it('a 201 with a canonical id string selects that Mass', async () => {
    postMode = 'stringid'
    stubFetch()
    stashOpenDraft()
    view(returnPath())
    await saveNewMass()
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toMatch(/\/mass-intentions\?event=80/))
    expect(notices()).toContain(`Mass added for ${EN_DAY}.`)
    const select = await screen.findByLabelText(/assign to mass/i)
    await waitFor(() => expect(select.value).toBe('80'))
    expect(select.options[select.selectedIndex].textContent).toContain(TITLE)
  })

  it('the stored createdMass reader accepts only a positive safe integer', async () => {
    const { parseCreatedMassId } = await import('../utils/intentionDraft.js')
    expect(parseCreatedMassId(80)).toBe(80)
    expect(parseCreatedMassId('80')).toBe(80)
    expect(parseCreatedMassId(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER)
    for (const raw of [[80], { n: 80 }, true, false, 1.5, 0, -3, '80.0', '080', ' 80', '', Number.MAX_SAFE_INTEGER + 1, null]) {
      expect(parseCreatedMassId(raw), JSON.stringify(raw)).toBeNull()
    }
    stashOpenDraft()
    expect(attachCreatedMass(NONCE, { id: [80], title: TITLE, date: DAY, start_time: '10:00', end_time: '11:00', type: 'service' })).toBe(false)
    expect(peekIntentionDraft()?.createdMass).toBeUndefined()
    sessionStorage.setItem('ochr:intention-draft', JSON.stringify({
      form: { intention: 'For the Rivera family', mass_date: DAY, status: 'open', calendar_event_id: '' },
      editingId: null,
      nonce: NONCE,
      expiresAt: Date.now() + 60_000,
      createdMass: { id: [80], title: TITLE, date: DAY, start_time: '10:00', end_time: '11:00', type: 'service' },
    }))
    expect(peekIntentionDraft()?.createdMass).toBeUndefined()
    expect(attachCreatedMass(NONCE, { id: '80', title: TITLE, date: DAY, start_time: '10:00', end_time: '11:00', type: 'service' })).toBe(true)
    expect(peekIntentionDraft()?.createdMass).toEqual({
      id: 80, title: TITLE, date: DAY, start_time: '10:00', end_time: '11:00', type: 'service',
    })
  })

  it('keeps a civil day in a western parish zone and shifts only a real instant', async () => {
    const dates = await import('../utils/dates.js')
    expect(typeof dates.formatParishDay).toBe('function')
    expect(dates.formatParishDay(DAY, 'en-US', 'America/Los_Angeles')).toBe(EN_DAY)
    expect(dates.formatParishDay(`${DAY}T00:00:00.000Z`, 'en-US', 'America/Los_Angeles')).toBe(EN_DAY)
    expect(dates.formatParishDay('2026-10-18T03:00:00.000Z', 'en-US', 'America/Los_Angeles')).toBe('Sat, Oct 17, 2026')
    expect(dates.formatParishDay('2026-10-18T03:00:00.000Z', 'en-US', 'UTC')).toBe(EN_DAY)
    expect(dates.formatParishDay('not-a-day', 'en-US', 'America/Los_Angeles')).toBe('')
    expect(dates.formatParishDay(DAY, 'es', 'America/Los_Angeles')).toBe(ES_DAY)
  })

  it('has English and Spanish confirmation copy, and service wording for the other traditions', () => {
    expect(STRINGS.en['sched.massAdded']).toBe('Mass added for {date}.')
    expect(STRINGS.es['sched.massAdded']).toBe('Misa agregada para el {date}.')
    expect(STRINGS.en['sched.massReturnFailed']).toBe(SAVED_NOT_SELECTED)
    expect(STRINGS.en['sched.massReturnFailed']).not.toMatch(/nothing else was lost/i)
    expect(STRINGS.es['sched.massReturnFailed']).toBe('La Misa se guardó, pero no se pudo seleccionar en la intención.')
    expect(STRINGS.es['sched.massReturnFailed']).not.toMatch(/no se perdió nada más/i)
    expect(STRINGS.en['sched.massUnconfirmed']).toBe(UNCONFIRMED)
    expect(STRINGS.es['sched.massUnconfirmed']).toBe('No se pudo confirmar la respuesta del horario, así que esta Misa no quedó seleccionada.')
    for (const tradition of ['episcopal', 'anglican', 'lutheran', 'general']) {
      expect(TRADITION_STRINGS[tradition].en['sched.massAdded']).toBe('Service added for {date}.')
      expect(TRADITION_STRINGS[tradition].es['sched.massAdded']).toBe('Servicio agregado para el {date}.')
      expect(TRADITION_STRINGS[tradition].en['sched.massReturnFailed']).toBe('The service was saved, but it could not be selected on the intention.')
      expect(TRADITION_STRINGS[tradition].es['sched.massReturnFailed']).toBe('El servicio se guardó, pero no se pudo seleccionar en la intención.')
      expect(TRADITION_STRINGS[tradition].en['sched.massUnconfirmed']).toBe("The schedule's answer could not be confirmed, so this service was not selected.")
      expect(TRADITION_STRINGS[tradition].es['sched.massUnconfirmed']).toBe('No se pudo confirmar la respuesta del horario, así que este servicio no quedó seleccionado.')
    }
  })
})
