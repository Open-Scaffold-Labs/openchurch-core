// The intention book's "add a Mass" hop reuses Schedule's create modal.
// Mutate any one of these and the matching test goes red:
//   1. ?new=1&date= does not open the create modal on that day
//   2. Saving the new Mass does not return to the intention book

import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import Schedule, { isIntentionReturn, isCalendarDayParam, scheduleNewMassHref, intentionResumeHref } from './Schedule'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const ok = (body) => ({ ok: true, status: 200, json: async () => body })

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url)
    if (opts.method === 'POST' && u.includes('/api/calendar')) {
      const body = JSON.parse(opts.body)
      return ok({ id: 80, title: body.title, date: body.date, start_time: body.start_time, end_time: body.end_time })
    }
    if (u.includes('/api/calendar/conflicts')) return ok({ conflicts: [] })
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

function view(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <LocaleProvider>
        <ToastProvider>
          <ConfirmProvider>
            <LocationProbe />
            <Routes>
              <Route path="/schedule" element={<Schedule />} />
              <Route path="/mass-intentions" element={<div>Intention book</div>} />
            </Routes>
          </ConfirmProvider>
        </ToastProvider>
      </LocaleProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => vi.unstubAllGlobals())

describe('Schedule create returns to the intention', () => {
  it('opens the existing new-event modal on the requested day and comes back with that Mass', async () => {
    stubFetch()
    const nonce = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    view(`/schedule?new=1&return=intention&date=2026-10-04&draft=${nonce}`)
    await waitFor(() => expect(screen.getByText('New Event')).toBeInTheDocument())
    expect(document.querySelector('input[type="date"]').value).toBe('2026-10-04')
    await waitFor(() => {
      expect(screen.getByTestId('loc').textContent).toBe(`/schedule?return=intention&date=2026-10-04&draft=${nonce}`)
    })
    const back = screen.getByTestId('back-to-intention')
    expect(back.getAttribute('href')).toBe(`/mass-intentions?date=2026-10-04&resume=${nonce}`)

    fireEvent.change(screen.getByLabelText(/event title/i), { target: { value: 'Sunday Mass' } })
    const times = [...document.querySelectorAll('input[type="time"]')]
    fireEvent.change(times[0], { target: { value: '10:00' } })
    fireEvent.change(times[1], { target: { value: '11:00' } })
    const submit = screen.getAllByRole('button', { name: 'Add Event' })
      .find(b => b.className.includes('rounded-lg'))
    fireEvent.click(submit)

    await waitFor(() => {
      expect(screen.getByTestId('loc').textContent).toBe(`/mass-intentions?event=80&date=2026-10-04&resume=${nonce}`)
    })
    const post = vi.mocked(fetch).mock.calls.find(c => c[1]?.method === 'POST')
    expect(String(post[0])).toMatch(/\/api\/calendar$/)
    const posted = JSON.parse(post[1].body)
    expect(posted.date).toBe('2026-10-04')
    expect(posted.type).toBe('service')
  })

  it('rejects a return value that is not the intention token, and a date that is not a day', async () => {
    expect(isIntentionReturn('intention')).toBe(true)
    expect(isIntentionReturn('https://evil.example/phish')).toBe(false)
    expect(isIntentionReturn('Intention')).toBe(false)
    expect(isCalendarDayParam('2026-10-04')).toBe(true)
    expect(isCalendarDayParam('Sunday')).toBe(false)
    expect(isCalendarDayParam('2026-10-04junk')).toBe(false)
    expect(isCalendarDayParam('2026-02-31')).toBe(false)
    expect(scheduleNewMassHref('Sunday')).toBe('/schedule?new=1&return=intention')
    expect(scheduleNewMassHref('2026-10-04junk')).toBe('/schedule?new=1&return=intention')
    expect(intentionResumeHref({ date: 'not-a-date' })).toBe('/mass-intentions')

    stubFetch()
    view('/schedule?new=1&return=https://evil.example/phish&date=Sunday')
    await waitFor(() => expect(screen.getByText('New Event')).toBeInTheDocument())
    expect(document.querySelector('input[type="date"]').value).toBe('')
    expect(screen.queryByTestId('back-to-intention')).toBeNull()
    await waitFor(() => {
      expect(screen.getByTestId('loc').textContent).not.toMatch(/mass-intentions/)
    })

    fireEvent.change(screen.getByLabelText(/event title/i), { target: { value: 'Parish council' } })
    fireEvent.change(document.querySelector('input[type="date"]'), { target: { value: '2026-10-04' } })
    const times = [...document.querySelectorAll('input[type="time"]')]
    fireEvent.change(times[0], { target: { value: '10:00' } })
    fireEvent.change(times[1], { target: { value: '11:00' } })
    const submit = screen.getAllByRole('button', { name: 'Add Event' })
      .find(b => b.className.includes('rounded-lg'))
    fireEvent.click(submit)
    await waitFor(() => {
      expect(screen.queryByText('New Event')).toBeNull()
    })
    expect(screen.getByTestId('loc').textContent).not.toMatch(/mass-intentions/)
  })

  it('a date param that is not a real day leaves the create form empty', async () => {
    stubFetch()
    view('/schedule?new=1&return=intention&date=2026-10-04junk')
    await waitFor(() => expect(screen.getByText('New Event')).toBeInTheDocument())
    expect(document.querySelector('input[type="date"]').value).toBe('')
    view('/schedule?new=1&return=intention&date=2026-02-31')
    await waitFor(() => expect(screen.getAllByText('New Event').length).toBeGreaterThan(0))
    const dates = [...document.querySelectorAll('input[type="date"]')]
    expect(dates.every(input => input.value === '')).toBe(true)
  })

  it('a meeting drawer does not offer an intention at that event', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      if (u.includes('/api/calendar/9')) {
        return ok({ id: 9, title: 'Finance meeting', date: '2026-10-04', start_time: '19:00', end_time: '20:00', type: 'meeting' })
      }
      if (u.includes('/api/calendar/10')) {
        return ok({ id: 10, title: 'Sunday Mass', date: '2026-10-04', start_time: '10:00', end_time: '11:00', type: 'service' })
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
    view('/schedule?event=9')
    await waitFor(() => expect(screen.getByDisplayValue('Finance meeting')).toBeInTheDocument())
    expect(screen.queryByRole('link', { name: /open the intention book/i })).toBeNull()
    expect(screen.queryByText(/offer at this mass/i)).toBeNull()
  })

  it('a Mass stored as type mass offers an intention from the drawer', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      if (u.includes('/api/calendar/11')) {
        return ok({ id: 11, title: 'Misa Dominical', date: '2026-10-04', start_time: '10:00', end_time: '11:00', type: 'mass' })
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
    view('/schedule?event=11')
    expect(await screen.findByRole('link', { name: /open the intention book/i })).toBeInTheDocument()
  })

  it('an event-typed row offers an intention from the drawer', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      if (u.includes('/api/calendar/12')) {
        return ok({ id: 12, title: '10:30 Mass', date: '2026-10-04', start_time: '10:30', end_time: '11:30', type: 'event' })
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
    view('/schedule?event=12')
    expect(await screen.findByRole('link', { name: /open the intention book/i })).toBeInTheDocument()
  })
})
