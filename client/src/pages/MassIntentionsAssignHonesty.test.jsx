// Assign-to-Mass dropdown honesty (FB1-06).
// Mutate any one of these and the matching test goes red:
//   1. A hop/past id held on the form has no <option> (browser paints
//      "Not assigned" while state still holds the id)
//   2. A missing id is invented from the hop title or date
//   3. The held id is silently cleared without a human action
//   4. Only the 60-day window is asked — GET /api/calendar/:id is skipped

import { ToastProvider } from '../components/ToastProvider'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import MassIntentions, {
  formatMassOptionLabel,
  withHeldMassOptions,
  massesIncludeId,
  fetchCalendarEventById,
} from './MassIntentions'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const ok = (body) => ({ ok: true, status: 200, json: async () => body })
const notFound = () => ({ ok: false, status: 404, json: async () => ({ error: 'Event not found' }) })

const IN_WINDOW = [
  { id: 18, title: 'Mass TODAY', date: '2026-09-12', start_time: '10:30:00' },
]
const FAR = { id: 55, title: 'Mass IN MARCH', date: '2026-03-01', start_time: '09:00:00' }

function stubFetch({ byId = {}, list = IN_WINDOW, intentions = [] } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    const m = u.match(/\/api\/calendar\/(\d+)/)
    if (m) return byId[m[1]] ? ok(byId[m[1]]) : notFound()
    if (u.includes('/api/calendar')) return ok(list)
    if (u.includes('/api/mass-intentions')) return ok({ intentions })
    return ok({})
  }))
}

function renderBook(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <LocaleProvider>
        <Routes>
          <Route path="/mass-intentions" element={<ToastProvider><MassIntentions /></ToastProvider>} />
        </Routes>
      </LocaleProvider>
    </MemoryRouter>,
  )
}

function assignSelect() {
  return screen.getByLabelText(/assign to (a )?(mass|service)/i)
}

// Headed browsers read the selected <option>, not the React value
// property. jsdom's select.value can stay on the held id while
// selectedIndex is 0 ("Not assigned") — that is the Mercury gap.
function selectedAssignOption() {
  const s = assignSelect()
  const idx = s.selectedIndex
  const opt = s.options[idx]
  return {
    value: opt?.value ?? '',
    label: opt?.textContent ?? '',
    selectedIndex: idx,
    notAssignedSelected: Boolean(s.options[0]?.selected),
    optionValues: [...s.options].map(o => o.value),
  }
}

beforeEach(() => { vi.unstubAllGlobals() })

describe('assign dropdown helpers', () => {
  it('withHeldMassOptions prepends a hop Mass that the window omitted', () => {
    const merged = withHeldMassOptions(IN_WINDOW, FAR)
    expect(massesIncludeId(merged, 55)).toBe(true)
    expect(merged[0].id).toBe(55)
    expect(massesIncludeId(IN_WINDOW, 55)).toBe(false)
  })

  it('formatMassOptionLabel does not invent a Mass from a date alone', () => {
    expect(formatMassOptionLabel(FAR)).toBe('2026-03-01 — Mass IN MARCH (09:00)')
    expect(formatMassOptionLabel(null)).toBe('')
  })
})

describe('Assign dropdown honesty', () => {
  it('a hop Mass outside the window is fetched by id and selected', async () => {
    stubFetch({ byId: { 55: FAR }, list: IN_WINDOW })
    renderBook('/mass-intentions?event=55&date=2026-03-01&compose=1')
    await waitFor(() => {
      expect(screen.getByText(/^New intention$/i)).toBeInTheDocument()
    })
    await waitFor(() => {
      const picked = selectedAssignOption()
      expect(picked.value).toBe('55')
      expect(picked.label).toMatch(/IN MARCH/)
      expect(picked.notAssignedSelected).toBe(false)
      expect(picked.selectedIndex).toBeGreaterThan(0)
    })
    expect(selectedAssignOption().label).not.toMatch(/not assigned/i)
    const urls = vi.mocked(fetch).mock.calls.map(c => String(c[0]))
    expect(urls.some(u => /\/api\/calendar\/55\b/.test(u))).toBe(true)
  })

  it('stays selected when the hop Mass option arrives after the form opens', async () => {
    let releaseFar
    const farReady = new Promise((resolve) => { releaseFar = resolve })
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      const m = u.match(/\/api\/calendar\/(\d+)/)
      if (m) {
        await farReady
        return m[1] === '55' ? ok(FAR) : notFound()
      }
      if (u.includes('/api/calendar')) return ok(IN_WINDOW)
      if (u.includes('/api/mass-intentions')) return ok({ intentions: [] })
      return ok({})
    }))
    renderBook('/mass-intentions?event=55&date=2026-03-01&compose=1')
    await waitFor(() => {
      expect(screen.getByText(/^New intention$/i)).toBeInTheDocument()
    })
    await waitFor(() => {
      const picked = selectedAssignOption()
      expect(picked.optionValues).toContain('55')
      expect(picked.value).toBe('55')
      expect(picked.notAssignedSelected).toBe(false)
    })
    const heldOption = assignSelect().querySelector('option[value="55"]')
    expect(heldOption).toBeTruthy()
    releaseFar()
    await waitFor(() => {
      const picked = selectedAssignOption()
      expect(picked.value).toBe('55')
      expect(picked.label).toMatch(/IN MARCH/)
      expect(picked.notAssignedSelected).toBe(false)
      expect(picked.selectedIndex).toBeGreaterThan(0)
    })
    // Same DOM node: swapping a placeholder for the resolved Mass is what
    // leaves a headed browser on "Not assigned" after the option exists.
    expect(assignSelect().querySelector('option[value="55"]')).toBe(heldOption)
  })

  it('editing a past Mass not in the window keeps that Mass selected', async () => {
    stubFetch({
      byId: { 55: FAR },
      list: IN_WINDOW,
      intentions: [{
        id: 9,
        intention: '† Rivera',
        requested_by: 'The family',
        calendar_event_id: 55,
        mass_date: '2026-03-01',
        status: 'scheduled',
      }],
    })
    renderBook('/mass-intentions')
    fireEvent.click(await screen.findByRole('button', { name: /edit intention/i }))
    await waitFor(() => {
      expect(screen.getByText(/^Edit intention$/i)).toBeInTheDocument()
    })
    await waitFor(() => {
      const picked = selectedAssignOption()
      expect(picked.value).toBe('55')
      expect(picked.label).toMatch(/IN MARCH/)
      expect(picked.notAssignedSelected).toBe(false)
      expect(picked.selectedIndex).toBeGreaterThan(0)
    })
    const urls = vi.mocked(fetch).mock.calls.map(c => String(c[0]))
    expect(urls.some(u => /\/api\/calendar\/55\b/.test(u))).toBe(true)
  })

  it('a missing held id does not invent a Mass and does not look unassigned', async () => {
    stubFetch({ byId: {}, list: IN_WINDOW })
    renderBook('/mass-intentions?event=999&date=2026-03-01&compose=1')
    await waitFor(() => {
      expect(screen.getByText(/^New intention$/i)).toBeInTheDocument()
    })
    await waitFor(() => {
      const picked = selectedAssignOption()
      expect(picked.value).toBe('999')
      expect(picked.label).toMatch(/isn't on this church's schedule/i)
      expect(picked.notAssignedSelected).toBe(false)
      expect(picked.selectedIndex).toBeGreaterThan(0)
    })
    const picked = selectedAssignOption()
    expect(picked.label).not.toMatch(/not assigned/i)
    expect(picked.label).not.toMatch(/IN MARCH/)
    expect(picked.label).not.toMatch(/TODAY/)
    expect(picked.label).not.toMatch(/2026-03-01/)
    expect(screen.getByText(/assignment is still held/i)).toBeInTheDocument()
  })
})

describe('fetchCalendarEventById refuse', () => {
  it('404 is missing — a 200 with the wrong id is not a Mass', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      if (u.includes('/api/calendar/999')) return notFound()
      if (u.includes('/api/calendar/40')) return ok({ id: 18, title: 'WRONG MASS', date: '2026-09-12' })
      return ok({})
    }))
    expect(await fetchCalendarEventById(999)).toEqual({ status: 'missing' })
    expect(await fetchCalendarEventById(40)).toEqual({ status: 'failed' })
    expect(await fetchCalendarEventById('Sunday')).toEqual({ status: 'invalid' })
  })
})
