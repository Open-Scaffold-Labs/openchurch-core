// Mini Boss #4 — handoff integrity under async reorder.
//
// INVARIANT: when the desk switches from Mass A to Mass B, a late roster
// response for A must NOT paint under B. Identity is event_id.
//
// Duplicate-looking titles are intentional: both Masses are "Sunday Mass
// 10:30am". Labels must not decide whose roster is shown.
//
// Mutate any one of these and the matching test goes red:
//   1. remove the checkinsLoadGen guard in loadCheckins
//   2. apply setCheckins from a response whose generation is no longer current

import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
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

const day = off => { const d = new Date(); d.setDate(d.getDate() + off); return d.toISOString().slice(0, 10) }
const MASS_A = { id: 17, title: 'Sunday Mass 10:30am', date: day(-7), start_time: '10:30', end_time: '11:45', type: 'service' }
const MASS_B = { id: 19, title: 'Sunday Mass 10:30am', date: day(-14), start_time: '10:30', end_time: '11:45', type: 'service' }
const EVENTS = [MASS_B, MASS_A]

const ROSTER_A = [
  { id: 1, calendar_event_id: 17, client_id: 25, person_name: 'ONLY-ON-MASS-A', kind: 'member', checked_in_at: 'x', checked_out_at: null },
]
const ROSTER_B = [
  { id: 2, calendar_event_id: 19, client_id: 26, person_name: 'ONLY-ON-MASS-B', kind: 'member', checked_in_at: 'x', checked_out_at: null },
]

const ok = b => ({ ok: true, status: 200, json: async () => b })

beforeEach(() => { vi.unstubAllGlobals() })

const view = (path) => render(
  <MemoryRouter initialEntries={[path]}>
    <LocaleProvider><ToastProvider><ConfirmProvider>
      <Checkin />
    </ConfirmProvider></ToastProvider></LocaleProvider>
  </MemoryRouter>,
)

describe('Check-in stale roster race', () => {
  it('a late roster for Mass A does not replace Mass B after the desk switches', async () => {
    let releaseA
    const pendingA = new Promise(resolve => { releaseA = resolve })

    vi.stubGlobal('fetch', vi.fn((url) => {
      const u = String(url)
      if (u.includes('/api/calendar?')) return Promise.resolve(ok(EVENTS))
      if (u.includes('/api/clients')) return Promise.resolve(ok([]))
      if (u.includes('/api/rooms')) return Promise.resolve(ok({ rooms: [] }))
      if (u.includes('/api/checkins/recent')) return Promise.resolve(ok({ services: [] }))
      const r = u.match(/\/api\/checkins\?event_id=(\d+)/)
      if (r) {
        const id = r[1]
        if (id === '17') {
          return pendingA.then(() => ok({ checkins: ROSTER_A, present: 1 }))
        }
        if (id === '19') {
          return Promise.resolve(ok({ checkins: ROSTER_B, present: 1 }))
        }
      }
      return Promise.resolve(ok({}))
    }))

    view('/checkin?event=17')

    // Wait until Mass A is selected (URL asked for it), before its roster resolves.
    const picker = await screen.findByLabelText(/choose a service/i)
    await waitFor(() => expect(picker.value).toBe('17'))

    // Switch to Mass B before A's roster returns.
    await act(async () => {
      fireEvent.change(picker, { target: { value: '19' } })
    })
    await waitFor(() => expect(picker.value).toBe('19'))

    // B's roster arrives first.
    await waitFor(() => {
      expect(screen.getByText('ONLY-ON-MASS-B')).toBeInTheDocument()
    })
    expect(screen.queryByText('ONLY-ON-MASS-A')).not.toBeInTheDocument()

    // Late A response — must not overwrite B.
    await act(async () => { releaseA() })
    await act(async () => { await Promise.resolve() })

    expect(picker.value).toBe('19')
    expect(screen.getByText('ONLY-ON-MASS-B')).toBeInTheDocument()
    expect(screen.queryByText('ONLY-ON-MASS-A')).not.toBeInTheDocument()
  })
})
