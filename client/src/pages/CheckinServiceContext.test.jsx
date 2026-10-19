// Check-in carries the service it was opened for.
//
// THE INVARIANT: the service named in the URL is the service the picker shows
// and the service a check-in is written to — or the page refuses.
//
// The dangerous failure here is not an empty screen. It is a full one: the
// desk follows a link to last Sunday's 10:30, the page quietly shows the next
// upcoming Mass instead, and everyone gets checked in to the wrong service
// while the screen looks completely normal. So the unknown case is tested for
// what it must NOT do — render a picker at all — not merely for a message.
//
// Instrument note: a <select>'s current value is invisible to innerText, and
// this whole feature lives in one. Every assertion reads the option marked
// selected, and every deep link names a service the page does NOT default to,
// so "honoured" and "ignored" cannot produce the same reading.

import { render, screen, waitFor } from '@testing-library/react'
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

const today = new Date().toISOString().slice(0, 10)
const past = (() => { const d = new Date(); d.setDate(d.getDate() - 7); return d.toISOString().slice(0, 10) })()
const soon = (() => { const d = new Date(); d.setDate(d.getDate() + 7); return d.toISOString().slice(0, 10) })()

const IN_WINDOW = [
  { id: 17, title: 'Mass LAST WEEK', date: past, start_time: '08:00', end_time: '09:00', type: 'service' },
  { id: 18, title: 'Mass TODAY', date: today, start_time: '10:30', end_time: '11:45', type: 'service' },
  { id: 19, title: 'Mass NEXT WEEK', date: soon, start_time: '08:00', end_time: '09:00', type: 'service' },
]
// Outside the picker's window entirely — a Mass from March.
const FAR = { id: 55, title: 'Mass IN MARCH', date: '2026-03-01', start_time: '09:00', end_time: '10:00', type: 'service' }

const ok = b => ({ ok: true, status: 200, json: async () => b })
const notFound = () => ({ ok: false, status: 404, json: async () => ({ error: 'Event not found' }) })

function stubFetch({ byId = {} } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    const m = u.match(/\/api\/calendar\/(\d+)/)
    if (m) return byId[m[1]] ? ok(byId[m[1]]) : notFound()
    if (u.includes('/api/calendar?')) return ok(IN_WINDOW)
    if (u.includes('/api/clients')) return ok([])
    if (u.includes('/api/rooms')) return ok({ rooms: [] })
    if (u.includes('/api/checkins/recent')) return ok({ services: [] })
    if (u.includes('/api/checkins')) return ok({ checkins: [], present: 0 })
    return ok({})
  }))
}

const view = (path) => render(
  <MemoryRouter initialEntries={[path]}>
    <LocaleProvider><ToastProvider><ConfirmProvider>
      <Checkin />
    </ConfirmProvider></ToastProvider></LocaleProvider>
  </MemoryRouter>
)

/** The service the picker is actually showing, read from the DOM. */
const picked = async () => {
  const s = await screen.findByLabelText('Choose a service', {}, { timeout: 4000 })
  return { value: s.value, label: s.options[s.selectedIndex]?.textContent ?? '' }
}

beforeEach(() => { vi.unstubAllGlobals() })

describe('the service check-in was opened for', () => {
  it('CONTROL: with nothing asked, defaults to the first UPCOMING service', async () => {
    // Not the first row — the window now reaches into the past, and last
    // week's Mass must not become the desk's default.
    stubFetch()
    view('/checkin')
    const p = await picked()
    expect(p.value).toBe('18')
    expect(p.label).toMatch(/TODAY/)
  })

  it('opens the service named in the URL, not the default one', async () => {
    stubFetch()
    view('/checkin?event=19')
    const p = await picked()
    expect(p.value).toBe('19')
    expect(p.label).toMatch(/NEXT WEEK/)
  })

  it('opens a service that has already happened', async () => {
    stubFetch()
    view('/checkin?event=17')
    const p = await picked()
    expect(p.value).toBe('17')
    expect(p.label).toMatch(/LAST WEEK/)
  })

  it('opens a service from outside the window by asking the server for it', async () => {
    stubFetch({ byId: { 55: FAR } })
    view('/checkin?event=55')
    const p = await picked()
    expect(p.value).toBe('55')
    expect(p.label).toMatch(/IN MARCH/)
  })

  it('THE DEFECT: an unknown service must NOT fall back to another one', async () => {
    // 404 = not this church's, or deleted. The page must refuse. A picker on
    // screen here means the desk is about to take attendance for a service
    // nobody asked for, and nothing would say so.
    stubFetch()
    view('/checkin?event=999')
    await screen.findByText(/isn't on this church's schedule/i, {}, { timeout: 4000 })
    expect(screen.queryByLabelText('Choose a service')).toBeNull()
    expect(screen.getByText(/Nobody has been checked in/i)).toBeTruthy()
  })

  it('says so honestly when the service could not be loaded at all', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      if (/\/api\/calendar\/\d+/.test(u)) return { ok: false, status: 500, json: async () => ({}) }
      if (u.includes('/api/calendar?')) return ok(IN_WINDOW)
      if (u.includes('/api/clients')) return ok([])
      if (u.includes('/api/rooms')) return ok({ rooms: [] })
      if (u.includes('/api/checkins')) return ok({ checkins: [], present: 0 })
      return ok({})
    }))
    view('/checkin?event=777')
    await screen.findByText(/couldn't open that service/i, {}, { timeout: 4000 })
    // FAILED is not "the next Mass".
    expect(screen.queryByLabelText('Choose a service')).toBeNull()
  })
})
