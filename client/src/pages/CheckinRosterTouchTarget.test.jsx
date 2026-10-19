// The roster name is a thumb target, not only a link.
//
// #42 made the roster name open the member. It shipped at 17px tall, against
// the ~44px a thumb hits reliably — on the one screen in OpenChurch that is
// used standing up, on a tablet, in the ten minutes before Mass, often by a
// volunteer. The row already had the room: on a coarse pointer its Print and
// Out buttons are floored at 44px, so the row is 65px and the name was using
// 17 of them.
//
// WHY THIS IS TESTED AS A CONTRACT AND NOT AS A MEASUREMENT. jsdom performs no
// layout and evaluates no media query, so it cannot answer "is this 44px on a
// phone" — and a test that pretended to would be worse than no test. The real
// measurement is a hit test in a browser at 390x844, recorded in the pass
// notes. What is asserted here is the contract that measurement depends on,
// in the two halves that can actually rot independently:
//
//   1. the roster's member link carries `tap-line` (markup half)
//   2. `a.tap-line` is granted 44px, inside a `pointer: coarse` query
//      (stylesheet half)
//
// Break either half and the browser measurement silently returns to 17px, so
// both are pinned. The stylesheet half is read from source, the way the
// migration-source tests in the server suite assert what a migration may not
// contain.

import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { readFile } from 'node:fs/promises'
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
const ORPHAN = { id: 3, calendar_event_id: 17, client_id: null, person_name: 'Cecilia Moreno', kind: 'member', checked_in_at: '2026-09-10T17:32:00Z', checked_out_at: null }
const OUT    = { id: 4, calendar_event_id: 17, client_id: 26, person_name: 'Tomas Rivas', kind: 'member', checked_in_at: '2026-09-10T17:33:00Z', checked_out_at: '2026-09-10T18:10:00Z' }

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

const linkFor = async (name) => {
  const el = await screen.findByText(new RegExp(name), {}, { timeout: 4000 })
  const p = el.closest('p') ?? el
  return p.querySelector('a[href^="/clients/"]')
}

beforeEach(() => { vi.unstubAllGlobals() })

describe('the roster name is big enough for a thumb', () => {
  it('the member link carries the touch-target class', async () => {
    stubFetch([MEMBER])
    view()
    const link = await linkFor('Ana Delgado')
    expect(link).toBeTruthy()
    expect(link.classList.contains('tap-line')).toBe(true)
  })

  it('a checked-out member is still a target — they are still a person to open', async () => {
    stubFetch([OUT])
    view()
    const link = await linkFor('Tomas Rivas')
    expect(link.getAttribute('href')).toBe('/clients/26?from=checkin&event=17')
    expect(link.classList.contains('tap-line')).toBe(true)
  })

  it('GROWING THE TARGET DID NOT GROW WHAT IS TARGETABLE', async () => {
    // The whole risk of a touch-target change on this row: a bigger hit area
    // that now covers a guest or an orphan would hand staff a profile that is
    // not there. #42's invariant is re-asserted here, against this change.
    stubFetch([MEMBER, GUEST, ORPHAN, OUT])
    view()
    expect((await linkFor('Visiting Friend'))).toBeNull()
    expect((await linkFor('Cecilia Moreno'))).toBeNull()
    await waitFor(() => expect(document.querySelectorAll('a[href^="/clients/"]').length).toBe(2))
    for (const a of document.querySelectorAll('a[href^="/clients/"]')) {
      expect(a.classList.contains('tap-line')).toBe(true)
    }
  })
})

describe('the stylesheet actually grants the target', () => {
  // Vite serves modules over http, so import.meta.url is not a file URL here;
  // the client suite runs with cwd = client/.
  const css = async () => readFile('src/index.css', 'utf8')

  // The block the rule must live in, isolated so the assertions below cannot
  // be satisfied by a `tap-line` rule that sits outside the media query.
  const coarseBlocks = (src) => {
    const out = []
    const re = /@media\s*\(pointer:\s*coarse\)\s*\{/g
    let m
    while ((m = re.exec(src))) {
      let i = re.lastIndex, depth = 1
      while (i < src.length && depth > 0) {
        if (src[i] === '{') depth++
        else if (src[i] === '}') depth--
        i++
      }
      out.push(src.slice(re.lastIndex, i))
    }
    return out
  }

  it('a.tap-line is defined, and only inside a coarse-pointer query', async () => {
    const src = await css()
    const blocks = coarseBlocks(src)
    expect(blocks.length).toBeGreaterThan(0)
    const inside = blocks.filter(b => /a\.tap-line\s*\{/.test(b))
    expect(inside.length).toBe(1)
    // …and nowhere else: a copy outside the query would move the desktop line.
    const total = (src.match(/a\.tap-line\s*\{/g) || []).length
    expect(total).toBe(1)
  })

  it('IT GRANTS 44px, NOT MERELY A DISPLAY CHANGE', async () => {
    const src = await css()
    const rule = coarseBlocks(src).map(b => b.match(/a\.tap-line\s*\{([^}]*)\}/)).find(Boolean)[1]
    expect(rule).toMatch(/min-height:\s*44px/)
    // An inline box cannot take a height at all, so the display switch is
    // load-bearing, not cosmetic.
    expect(rule).toMatch(/display:\s*inline-block/)
    // The ellipsis a long name relies on: an inline-flex box would swallow it.
    expect(rule).toMatch(/text-overflow:\s*ellipsis/)
  })

  it('the roster row it sits in is not itself height-capped', async () => {
    // If the row ever gains a fixed height under 44px the target silently
    // shrinks back with the stylesheet still saying 44.
    const jsx = await readFile('src/pages/Checkin.jsx', 'utf8')
    const rowLine = jsx.split('\n').find(l => l.includes('checkins.map(c =>'))
    expect(rowLine).toBeTruthy()
    const rowMarkup = jsx.slice(jsx.indexOf(rowLine), jsx.indexOf(rowLine) + 400)
    expect(rowMarkup).not.toMatch(/\bh-\d+\b/)
    expect(rowMarkup).not.toMatch(/max-h-/)
  })
})
