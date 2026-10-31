// SP-271: a Viewer opening a Mass with a booked intention must SEE it.
// Before: Schedule skipped the weekly fetch for viewers, so EventModal
// showed "No intention is offered at this Mass yet."
// SP-273: Viewers get a read-only modal — no Save button.
// SP-272: the Edit Event body is a scroll container so the footer stays reachable.
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import Schedule, { EventModal } from './Schedule'

const AUTH = {
  user: { id: 4, name: 'Vera Viewer', role: 'viewer', organization: { id: 3, name: 'St Test', locale: 'en' } },
  token: 't', loading: false, canWrite: false, isAdmin: false,
}
vi.mock('../context/AuthContext', () => ({ useAuth: () => AUTH }))

const ok = (body) => ({ ok: true, status: 200, json: async () => body })
const pad = (n) => String(n).padStart(2, '0')
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const mondayOf = (d = new Date()) => {
  const x = new Date(d); const day = x.getDay()
  x.setDate(x.getDate() - (day === 0 ? 6 : day - 1)); x.setHours(0, 0, 0, 0); return x
}
const addDays = (date, n) => { const d = new Date(date); d.setDate(d.getDate() + n); return d }
const THIS_MON = mondayOf(new Date())
const SUN = iso(addDays(THIS_MON, 6))

const MASS = {
  id: 47192,
  title: 'All Saints',
  date: SUN,
  start_time: '10:00',
  end_time: '11:00',
  type: 'service',
  assigned_to: [1, 2, 3],
}
const INTENTION = {
  id: 9702,
  formatted_intention: '† Joseph Testwalker',
  intention: '† Joseph Testwalker',
  requester_name: 'Teresa Testwalker',
  calendar_event_id: 47192,
  status: 'scheduled',
  mass_date: SUN,
}

beforeEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
})

describe('SP-271 Viewer sees booked Mass Intention', () => {
  it('fetches weekly intentions and shows the booked name in the Mass modal', async () => {
    const asked = []
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      if (u.includes('/api/')) asked.push(u)
      if (u.includes('/api/calendar?')) return ok([MASS])
      if (u.includes('/api/liturgical')) return ok({})
      if (u.includes('/api/mass-intentions/weekly')) return ok({ intentions: [INTENTION] })
      if (u.includes('/api/clients')) return ok([{ id: 1, name: 'A' }, { id: 2, name: 'B' }, { id: 3, name: 'C' }])
      if (u.includes('/api/groups')) return { ok: false, status: 403, json: async () => ({ code: 'viewer_scope' }) }
      return ok({})
    }))

    render(
      <MemoryRouter initialEntries={[`/schedule?event=${MASS.id}`]}>
        <LocaleProvider>
          <ToastProvider>
            <ConfirmProvider>
              <Routes>
                <Route path="/schedule" element={<Schedule />} />
              </Routes>
            </ConfirmProvider>
          </ToastProvider>
        </LocaleProvider>
      </MemoryRouter>,
    )

    await waitFor(() => expect(asked.some(u => u.includes('/api/mass-intentions/weekly'))).toBe(true))
    // Tile chip + modal both show the name; require the modal heading + name.
    expect(await screen.findByRole('heading', { name: STRINGS.en['sched.dlg.view'] })).toBeInTheDocument()
    const hits = await screen.findAllByText(/Joseph Testwalker/)
    expect(hits.length).toBeGreaterThanOrEqual(1)
    expect(screen.queryByText(STRINGS.en['sched.noneOnMass'])).toBeNull()
  })
})

describe('SP-273 Viewer EventModal is read-only', () => {
  it('shows the intention and has no Save button', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      if (u.includes('/api/liturgical')) return ok({ season: 'Ordinary Time', color: 'Green' })
      if (u.includes('/api/invoices')) return { ok: false, status: 403, json: async () => ({}) }
      if (u.includes('/api/calendar/conflicts')) return { ok: false, status: 403, json: async () => ({}) }
      if (u.includes('/api/availability')) return { ok: false, status: 403, json: async () => ({}) }
      if (u.includes('/api/mass-intentions')) return ok({ intentions: [] })
      return ok({})
    }))

    render(
      <MemoryRouter>
        <LocaleProvider>
          <ToastProvider>
            <ConfirmProvider>
              <EventModal
                event={MASS}
                onClose={() => {}}
                onSave={() => {}}
                onDelete={() => {}}
                members={[{ id: 1, name: 'A' }, { id: 2, name: 'B' }, { id: 3, name: 'C' }]}
                intentions={[INTENTION]}
              />
            </ConfirmProvider>
          </ToastProvider>
        </LocaleProvider>
      </MemoryRouter>,
    )

    expect(await screen.findByText(/Joseph Testwalker/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Save$/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /Save & apply/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Delete$/i })).toBeNull()
    // Heading is a view title, not "Edit Event"
    expect(screen.getByRole('heading', { name: STRINGS.en['sched.dlg.view'] })).toBeInTheDocument()
  })
})

describe('SP-272 EventModal body scrolls', () => {
  it('has a scroll container so the footer stays reachable', () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({})))
    render(
      <MemoryRouter>
        <LocaleProvider>
          <ToastProvider>
            <ConfirmProvider>
              <EventModal
                event={MASS}
                onClose={() => {}}
                onSave={() => {}}
                onDelete={() => {}}
                members={[{ id: 1, name: 'A' }, { id: 2, name: 'B' }, { id: 3, name: 'C' }]}
                intentions={[INTENTION]}
              />
            </ConfirmProvider>
          </ToastProvider>
        </LocaleProvider>
      </MemoryRouter>,
    )
    const body = screen.getByTestId('event-modal-scroll')
    expect(body.className).toMatch(/overflow-y-auto/)
    expect(body.className).toMatch(/min-h-0/)
    expect(body.className).toMatch(/flex-1/)
  })
})
