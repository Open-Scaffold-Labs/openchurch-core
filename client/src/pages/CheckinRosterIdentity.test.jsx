// The roster carries who, and only when it actually knows who.
//
// THE INVARIANT: a roster row opens a member only when that check-in still
// names a live member of this parish. Otherwise the name stays as the
// historical record it is, and links nowhere.
//
// person_name is a snapshot — what this person was called at this service.
// client_id is identity. They come apart in two ordinary ways, and both are
// on a real parish roster within a month of opening:
//   · a guest has no member record at all;
//   · a deleted member leaves the row intact and nulls client_id
//     (ON DELETE SET NULL (client_id)), so the row still reads a member's
//     name, with kind still 'member', and there is no profile to open.
//
// The orphan case is the one that matters. Gating on kind, or on the presence
// of a name, produces a link to a member who is not there — and a screen that
// looks entirely correct while being wrong about a person.

import { render, screen, waitFor, within } from '@testing-library/react'
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
const EVENTS = [{ id: 17, title: 'Mass TODAY', date: today, start_time: '10:30', end_time: '11:45', type: 'service' }]

const MEMBER = { id: 1, calendar_event_id: 17, client_id: 25, person_name: 'Ana Delgado', kind: 'member', checked_in_at: '2026-09-10T17:30:00Z', checked_out_at: null }
const GUEST  = { id: 2, calendar_event_id: 17, client_id: null, person_name: 'Visiting Friend', kind: 'guest', checked_in_at: '2026-09-10T17:31:00Z', checked_out_at: null }
// The member record is gone; the row is not. kind is still 'member'.
const ORPHAN = { id: 3, calendar_event_id: 17, client_id: null, person_name: 'Cecilia Moreno', kind: 'member', checked_in_at: '2026-09-10T17:32:00Z', checked_out_at: null }

const ok = b => ({ ok: true, status: 200, json: async () => b })

const stubFetch = (roster) => {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    if (/\/api\/calendar\/\d+/.test(u)) return ok(EVENTS[0])
    if (u.includes('/api/calendar?')) return ok(EVENTS)
    if (u.includes('/api/clients')) return ok([])
    if (u.includes('/api/rooms')) return ok({ rooms: [] })
    if (u.includes('/api/checkins/recent')) return ok({ services: [] })
    if (u.includes('/api/checkins')) return ok({ checkins: roster, present: roster.length })
    return ok({})
  }))
}

const view = () => render(
  <MemoryRouter initialEntries={['/checkin?event=17']}>
    <LocaleProvider><ToastProvider><ConfirmProvider>
      <Checkin />
    </ConfirmProvider></ToastProvider></LocaleProvider></MemoryRouter>
)

/** The roster row for a name, and whether that name is a link. */
const row = async (name) => {
  const el = await screen.findByText(new RegExp(name), {}, { timeout: 4000 })
  const p = el.closest('p') ?? el
  return { el: p, link: p.querySelector('a[href^="/clients/"]') }
}

beforeEach(() => { vi.unstubAllGlobals() })

describe('a roster row and the person it names', () => {
  it('opens the member when the check-in still names one', async () => {
    stubFetch([MEMBER])
    view()
    const { link } = await row('Ana Delgado')
    expect(link).toBeTruthy()
    expect(link.getAttribute('href')).toBe('/clients/25?from=checkin&event=17')
  })

  it('a guest is named but is not a member, so it links nowhere', async () => {
    stubFetch([GUEST])
    view()
    const { el, link } = await row('Visiting Friend')
    expect(el).toBeTruthy()            // still on the roster
    expect(link).toBeNull()            // but not a profile
  })

  it('THE DEFECT: a member who has been deleted keeps their name and links nowhere', async () => {
    // kind is still 'member' and the name is intact. Gating on either of those
    // sends staff to a profile that does not exist.
    stubFetch([ORPHAN])
    view()
    const { el, link } = await row('Cecilia Moreno')
    expect(el).toBeTruthy()
    expect(link).toBeNull()
  })

  it('one roster, all three shapes, each treated on its own identity', async () => {
    stubFetch([MEMBER, GUEST, ORPHAN])
    view()
    expect((await row('Ana Delgado')).link?.getAttribute('href')).toBe('/clients/25?from=checkin&event=17')
    expect((await row('Visiting Friend')).link).toBeNull()
    expect((await row('Cecilia Moreno')).link).toBeNull()
    // exactly one profile link on the page — not three, not zero
    await waitFor(() => expect(document.querySelectorAll('a[href^="/clients/"]').length).toBe(1))
  })

  it('links to the id on the row, never to a member matched by name', async () => {
    // Same person, renamed since the service. The row records what was true
    // then; the link must still go to who they are now.
    stubFetch([{ ...MEMBER, person_name: 'Ana Delgado (was Ruiz)', client_id: 25 }])
    view()
    const { link } = await row('Ana Delgado')
    expect(link.getAttribute('href')).toBe('/clients/25?from=checkin&event=17')
  })
})
