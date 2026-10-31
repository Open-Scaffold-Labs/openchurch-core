// Saint SP-190..193.
// SP-190: Ctrl+K finds Worship, a service plan, and a Mass, inside role.
// SP-192: Escape closes the Add element dialog.
// SP-193: Service Mode formats the civil date in the parish locale.
// SP-189: a new plan with no ?date= opens on the next Sunday in the
// parish zone (today when today is Sunday). ?date= still wins.

import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import ServicePlanner from './ServicePlanner'
import ServiceMode from './ServiceMode'
import GlobalSearchPalette, { pageCommandsForQuery, pathForSearchItem } from '../components/GlobalSearchPalette'

const { auth } = vi.hoisted(() => ({ auth: { role: 'staff' } }))

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Sacristan', role: auth.role, organization: { id: 1, name: 'St Test', locale: 'en', timezone: 'America/Los_Angeles' } },
    token: 't',
    loading: false,
    canWrite: auth.role !== 'viewer',
    isAdmin: auth.role === 'admin',
  }),
}))

vi.mock('../components/ToastProvider', () => ({
  useToast: () => ({ success: () => {}, error: () => {}, info: () => {} }),
}))

vi.mock('../components/ConfirmProvider', () => ({
  useConfirm: () => async () => false,
}))

const { en, es } = STRINGS
const ok = (body) => ({ ok: true, status: 200, json: async () => body })

const PLANS = [
  { id: 3, date: '2026-10-04', title: 'Earlier Plan', element_count: 0 },
  { id: 9, date: '2026-11-01', title: 'Asked Plan', element_count: 1 },
]

function stubPlanner() {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    const detail = u.match(/\/api\/service-plans\/(\d+)/)
    if (detail) {
      const plan = PLANS.find(p => String(p.id) === detail[1]) || PLANS[0]
      return ok({ ...plan, elements: [{ id: 1, kind: 'hymn', title: 'Entrance', reference: null }] })
    }
    if (u.includes('/api/service-plans')) return ok({ plans: PLANS })
    if (u.includes('/api/clients')) return ok([])
    if (u.includes('/api/organization')) return ok({ name: 'St Test' })
    if (u.includes('/api/liturgical')) return ok({ season: null, feast_name: null, color: null })
    return ok([])
  }))
}

function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="loc">{`${loc.pathname}${loc.search}`}</div>
}

beforeEach(() => {
  auth.role = 'staff'
  localStorage.clear()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('SP-190 command palette', () => {
  it('offers Worship to staff and admins in either language, and not to a Viewer', () => {
    expect(pageCommandsForQuery('worship', 'staff').map(c => c.to)).toContain('/service-planner')
    expect(pageCommandsForQuery('liturgia', 'admin').map(c => c.to)).toContain('/service-planner')
    expect(pageCommandsForQuery('misa', 'staff').map(c => c.to)).toContain('/service-planner')
    expect(pageCommandsForQuery('worship', 'viewer')).toEqual([])
    expect(pageCommandsForQuery('sacristy', 'staff').map(c => c.to)).toEqual(['/packet'])
    expect(en['shell.cmd.worshipHint']).toBeTruthy()
    expect(es['shell.cmd.worshipHint']).toBeTruthy()
    expect(es['shell.cmd.worshipHint']).not.toBe(en['shell.cmd.worshipHint'])
    expect(es['shell.search.masses']).not.toBe(en['shell.search.masses'])
  })

  it('opens Worship from the palette and keeps the packet command', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok([])))
    render(
      <LocaleProvider>
        <MemoryRouter initialEntries={['/']}>
          <LocationProbe />
          <GlobalSearchPalette open onClose={() => {}} typeFilter={null} setTypeFilter={() => {}} />
        </MemoryRouter>
      </LocaleProvider>,
    )
    fireEvent.change(screen.getByLabelText(en['shell.search.query']), { target: { value: 'worship' } })
    const row = await screen.findByRole('button', { name: new RegExp(en['shell.cmd.worshipHint']) })
    expect(row).toHaveTextContent(en['nav.Worship'])
    fireEvent.click(row)
    expect(screen.getByTestId('loc').textContent).toBe('/service-planner')
  })

  it('opens this parish\'s plan and Mass from search results', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok([
      { id: 9, type: 'service_plan', title: 'Advent Worship', date: '2026-11-01' },
      { id: 4, type: 'mass', title: 'Sunday Mass', date: '2026-11-01', start_time: '10:00' },
    ])))
    render(
      <LocaleProvider>
        <MemoryRouter initialEntries={['/']}>
          <LocationProbe />
          <GlobalSearchPalette open onClose={() => {}} typeFilter={null} setTypeFilter={() => {}} />
        </MemoryRouter>
      </LocaleProvider>,
    )
    fireEvent.change(screen.getByLabelText(en['shell.search.query']), { target: { value: 'Advent Worship' } })
    const plan = await screen.findByRole('button', { name: /Advent Worship/i })
    expect(plan).toHaveTextContent(/Nov/)
    expect(plan).not.toHaveTextContent('2026-11-01')
    fireEvent.click(plan)
    expect(screen.getByTestId('loc').textContent).toBe('/service-planner?plan=9')

    fireEvent.change(screen.getByLabelText(en['shell.search.query']), { target: { value: 'Sunday Mass' } })
    const mass = await screen.findByRole('button', { name: /Sunday Mass/i })
    expect(screen.getAllByText(en['shell.search.masses']).length).toBeGreaterThan(0)
    expect(mass).not.toHaveTextContent('2026-11-01')
    fireEvent.click(mass)
    expect(screen.getByTestId('loc').textContent).toBe('/schedule?event=4')
  })

  it('does not show a service plan to a Viewer', async () => {
    auth.role = 'viewer'
    vi.stubGlobal('fetch', vi.fn(async () => ok([
      { id: 9, type: 'service_plan', title: 'Hidden Plan', date: '2026-11-01' },
      { id: 4, type: 'mass', title: 'Sunday Mass', date: '2026-11-01', start_time: '10:00' },
    ])))
    render(
      <LocaleProvider>
        <MemoryRouter>
          <GlobalSearchPalette open onClose={() => {}} typeFilter={null} setTypeFilter={() => {}} />
        </MemoryRouter>
      </LocaleProvider>,
    )
    fireEvent.change(screen.getByLabelText(en['shell.search.query']), { target: { value: 'Sunday Mass' } })
    expect(await screen.findByRole('button', { name: /Sunday Mass/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Hidden Plan/i })).toBeNull()
  })

  it('paths stay inside the planner and the schedule', () => {
    expect(pathForSearchItem({ type: 'service_plan', id: 9 })).toBe('/service-planner?plan=9')
    expect(pathForSearchItem({ type: 'mass', id: 4 })).toBe('/schedule?event=4')
  })
})

describe('SP-192 Escape closes Add element', () => {
  it('closes the dialog and leaves the plan open', async () => {
    stubPlanner()
    render(
      <MemoryRouter>
        <LocaleProvider>
          <ServicePlanner />
        </LocaleProvider>
      </MemoryRouter>,
    )
    fireEvent.click(await screen.findByRole('button', { name: en['plan.addElement'] }))
    expect(screen.getByRole('heading', { name: en['plan.addElement'] })).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: en['plan.addElement'] })).toBeNull()
    })
    expect(screen.getByRole('button', { name: en['plan.addElement'] })).toBeInTheDocument()
  })
})

describe('SP-193 Service Mode date', () => {
  function mount(locale) {
    if (locale) localStorage.setItem('ochr_locale', locale)
    vi.stubGlobal('fetch', vi.fn(async () => ok({
      id: 7,
      title: 'Sunday Mass',
      date: '2026-11-01',
      elements: [{ id: 1, kind: 'hymn', title: 'Entrance', reference: 'Hymn 12' }],
    })))
    return render(
      <MemoryRouter initialEntries={['/service-mode/7']}>
        <LocaleProvider>
          <Routes>
            <Route path="/service-mode/:planId" element={<ServiceMode />} />
          </Routes>
        </LocaleProvider>
      </MemoryRouter>,
    )
  }

  it('formats 2026-11-01 in English', async () => {
    mount('en')
    const date = await screen.findByTestId('svc-date')
    expect(date.textContent).not.toBe('2026-11-01')
    expect(date.textContent).toMatch(/November/i)
    expect(date.textContent).toMatch(/2026/)
    expect(date.textContent).toMatch(/\b1\b/)
  })

  it('formats the same day in Spanish', async () => {
    mount('es')
    const date = await screen.findByTestId('svc-date')
    expect(date.textContent).not.toBe('2026-11-01')
    expect(date.textContent.toLowerCase()).toMatch(/noviembre/)
    expect(date.textContent).toMatch(/2026/)
  })
})

describe('new plan date', () => {
  // SP-189 / UAT SVC-16: New-plan defaults to the next Sunday in the parish
  // zone (today when today is Sunday). ?date= still wins.
  it('defaults to the next Sunday when the address has no date, and ?date= still wins', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-28T20:00:00.000Z')) // Tuesday afternoon PT
    stubPlanner()
    const { unmount } = render(
      <MemoryRouter>
        <LocaleProvider>
          <ServicePlanner />
        </LocaleProvider>
      </MemoryRouter>,
    )
    expect(await screen.findByLabelText(en['plan.newDate'])).toHaveValue('2026-11-01')
    unmount()

    render(
      <MemoryRouter initialEntries={['/service-planner?date=2026-11-08']}>
        <LocaleProvider>
          <ServicePlanner />
        </LocaleProvider>
      </MemoryRouter>,
    )
    expect(await screen.findByLabelText(en['plan.newDate'])).toHaveValue('2026-11-08')
  })

  it('selects the plan named in ?plan=', async () => {
    vi.useRealTimers()
    stubPlanner()
    render(
      <MemoryRouter initialEntries={['/service-planner?plan=9']}>
        <LocaleProvider>
          <ServicePlanner />
        </LocaleProvider>
      </MemoryRouter>,
    )
    expect(await screen.findByDisplayValue('Asked Plan')).toBeInTheDocument()
  })
})
