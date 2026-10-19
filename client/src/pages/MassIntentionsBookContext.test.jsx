// E1 — book context and this intention's assignment can be two Masses.
// Same day, same title, different times. Mutate any one and the test goes red:
//   1. Chrome (Opened from) follows ?event=A while the form is forced onto A
//   2. Editing an intention assigned to B hides B or invents A
//   3. The two identities are unlabeled so A and B read as one Mass

import { ToastProvider } from '../components/ToastProvider'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import MassIntentions from './MassIntentions'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const ok = (body) => ({ ok: true, status: 200, json: async () => body })
const notFound = () => ({ ok: false, status: 404, json: async () => ({ error: 'Event not found' }) })

const MASS_A = { id: 40, title: 'Sunday Mass', date: '2026-09-13', start_time: '08:00:00' }
const MASS_B = { id: 41, title: 'Sunday Mass', date: '2026-09-13', start_time: '10:30:00' }
const BY_ID = { 40: MASS_A, 41: MASS_B }

const INTENTION_ON_B = {
  id: 9,
  intention: '† Rivera',
  requested_by: 'The family',
  calendar_event_id: 41,
  mass_date: '2026-09-13',
  status: 'scheduled',
}

function stubFetch({ byId = BY_ID, list = [MASS_A, MASS_B], intentions = [INTENTION_ON_B] } = {}) {
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

beforeEach(() => { vi.unstubAllGlobals() })

describe('book context vs this intention\'s assignment (E1)', () => {
  it('REPRODUCED: chrome names Mass A while the form keeps Mass B', async () => {
    stubFetch()
    renderBook('/mass-intentions?event=40')
    const chrome = await screen.findByTestId('intention-mass-chrome')
    await waitFor(() => {
      expect(chrome.textContent).toMatch(/08:00/)
      expect(chrome.textContent).toMatch(/Sunday Mass/)
    })
    fireEvent.click(await screen.findByRole('button', { name: /edit intention/i }))
    await waitFor(() => {
      expect(screen.getByText(/^Edit intention$/i)).toBeInTheDocument()
    })
    const s = assignSelect()
    await waitFor(() => {
      expect(s.options[s.selectedIndex].value).toBe('41')
      expect(s.options[s.selectedIndex].textContent).toMatch(/10:30/)
    })
    expect(chrome.textContent).toMatch(/08:00/)
    expect(chrome.textContent).not.toMatch(/10:30/)
    expect(s.options[s.selectedIndex].textContent).not.toMatch(/08:00/)
  })

  it('labels the book Mass as distinct from this intention\'s assignment', async () => {
    stubFetch()
    renderBook('/mass-intentions?event=40')
    const chrome = await screen.findByTestId('intention-mass-chrome')
    await waitFor(() => {
      expect(chrome.textContent).toMatch(/opened from this mass/i)
    })
    fireEvent.click(await screen.findByRole('button', { name: /edit intention/i }))
    await waitFor(() => {
      expect(screen.getByTestId('intention-assign-differs').textContent)
        .toMatch(/different mass/i)
    })
    expect(assignSelect().options[assignSelect().selectedIndex].value).toBe('41')
    expect(chrome.textContent).toMatch(/08:00/)
  })

  it('does not claim a different Mass when the assignment is the hop Mass', async () => {
    stubFetch({
      intentions: [{ ...INTENTION_ON_B, calendar_event_id: 40 }],
    })
    renderBook('/mass-intentions?event=40')
    fireEvent.click(await screen.findByRole('button', { name: /edit intention/i }))
    await waitFor(() => {
      expect(assignSelect().options[assignSelect().selectedIndex].value).toBe('40')
    })
    expect(screen.queryByTestId('intention-assign-differs')).toBeNull()
    expect(screen.getByTestId('intention-mass-chrome').textContent).toMatch(/opened from this mass/i)
  })
})
