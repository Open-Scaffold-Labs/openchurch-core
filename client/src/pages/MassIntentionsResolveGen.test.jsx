// E2 — hopResolveGen and heldResolveGen each refuse a stale Mass.
// Disable either guard independently and the matching test goes red
// for that stale reason, not the other.

import { ToastProvider } from '../components/ToastProvider'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useSearchParams } from 'react-router-dom'
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

function HopSwitch() {
  const [sp, setSp] = useSearchParams()
  return (
    <button
      type="button"
      onClick={() => {
        const next = new URLSearchParams(sp)
        next.set('event', '41')
        setSp(next, { replace: true })
      }}
    >
      hop-to-41
    </button>
  )
}

function renderBook(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <LocaleProvider>
        <Routes>
          <Route path="/mass-intentions" element={<><HopSwitch /><ToastProvider><MassIntentions /></ToastProvider></>} />
        </Routes>
      </LocaleProvider>
    </MemoryRouter>,
  )
}

function assignSelect() {
  return screen.getByLabelText(/assign to (a )?(mass|service)/i)
}

beforeEach(() => { vi.unstubAllGlobals() })

describe('hopResolveGen (E2)', () => {
  it('a late hop resolve for Mass A does not paint chrome after ?event= becomes B', async () => {
    let releaseA
    const pendingA = new Promise((resolve) => { releaseA = resolve })
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      const m = u.match(/\/api\/calendar\/(\d+)/)
      if (m?.[1] === '40') {
        await pendingA
        return ok(MASS_A)
      }
      if (m?.[1] === '41') return ok(MASS_B)
      if (u.includes('/api/calendar')) return ok([])
      if (u.includes('/api/mass-intentions')) return ok({ intentions: [] })
      return ok({})
    }))

    renderBook('/mass-intentions?event=40')
    await screen.findByTestId('intention-mass-chrome')
    fireEvent.click(screen.getByRole('button', { name: /hop-to-41/i }))
    const chrome = await screen.findByTestId('intention-mass-chrome')
    await waitFor(() => {
      expect(chrome.textContent).toMatch(/10:30/)
    })
    await act(async () => { releaseA() })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    // Stale A would paint 08:00 here if hopResolveGen were ignored.
    expect(chrome.textContent).toMatch(/10:30/)
    expect(chrome.textContent).not.toMatch(/08:00/)
  })
})

describe('heldResolveGen (E2)', () => {
  it('a late held resolve for Mass B does not replace the form\'s Mass A', async () => {
    let releaseB
    const pendingB = new Promise((resolve) => { releaseB = resolve })
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      const m = u.match(/\/api\/calendar\/(\d+)/)
      if (m?.[1] === '41') {
        await pendingB
        return ok(MASS_B)
      }
      if (m?.[1] === '40') return ok(MASS_A)
      if (u.includes('/api/calendar')) return ok([])
      if (u.includes('/api/mass-intentions')) {
        return ok({
          intentions: [
            { id: 7, intention: 'On B', calendar_event_id: 41, mass_date: '2026-09-13', status: 'scheduled' },
            { id: 8, intention: 'On A', calendar_event_id: 40, mass_date: '2026-09-13', status: 'scheduled' },
          ],
        })
      }
      return ok({})
    }))

    renderBook('/mass-intentions')
    const edits = await screen.findAllByRole('button', { name: /edit intention/i })
    expect(edits).toHaveLength(2)
    fireEvent.click(edits[0])
    await waitFor(() => {
      expect(screen.getByText(/^Edit intention$/i)).toBeInTheDocument()
    })
    await waitFor(() => {
      expect(assignSelect().options[assignSelect().selectedIndex].value).toBe('41')
    })
    fireEvent.click(edits[1])
    await waitFor(() => {
      const s = assignSelect()
      expect(s.options[s.selectedIndex].value).toBe('40')
    })
    await waitFor(() => {
      expect(assignSelect().options[assignSelect().selectedIndex].textContent).toMatch(/08:00/)
    })
    await act(async () => { releaseB() })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    // Stale B would replace A's label here if heldResolveGen were ignored.
    const after = assignSelect()
    expect(after.options[after.selectedIndex].value).toBe('40')
    expect(after.options[after.selectedIndex].textContent).toMatch(/08:00/)
    expect(after.options[after.selectedIndex].textContent).not.toMatch(/10:30/)
  })
})
