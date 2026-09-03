// The kiosk is the surface with the least context of all. (Pass 10 §5)
//
// A volunteer at a door, a queue behind them, no admin panel, no console, and
// a screen they have no reason to doubt. Two defects:
//
//   A 500 on the kiosk read said "We couldn't find that kiosk. The link may
//   have been rotated." — sending someone to hunt for a replacement link that
//   was never broken.
//
//   A failed roster search set matches to [] and rendered "No members match —
//   try the guest button below", steering the volunteer into creating a
//   DUPLICATE record for someone who IS on the roster. The duplicate outlives
//   the outage; the outage does not.

import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import Kiosk from './Kiosk'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: null, token: null, loading: false }),
}))

const KIOSK = {
  org: { name: 'St Test', locale: 'en' },
  services: [{ id: 1, title: 'Sunday Mass', time: '10:00' }],
  rooms: [],
}
const MEMBER = { id: 7, name: 'Maria Ruiz' }

const ok  = (b) => ({ ok: true,  status: 200, json: async () => b })
const err = (s, b = { error: 'boom' }) => ({ ok: false, status: s, json: async () => b })

let calls
const routes = (over = {}) => {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url)
    calls.push({ url: u, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null })
    for (const [frag, h] of Object.entries(over)) if (u.includes(frag)) return h()
    if (u.includes('/members')) return ok({ members: [MEMBER] })
    if (u.includes('/checkin')) return ok({ person_name: 'Maria Ruiz', kind: 'member' })
    return ok(KIOSK)
  }))
}

const mount = () => render(
  <MemoryRouter initialEntries={['/kiosk/tok123']}>
    <LocaleProvider>
      <Routes><Route path="/kiosk/:token" element={<Kiosk />} /></Routes>
    </LocaleProvider>
  </MemoryRouter>
)

const ROTATED   = /link may have been rotated/i
const OUR_SIDE  = /couldn'?t reach the kiosk just now/i
const NO_MATCH  = /no members match/i
const SEARCH_BAD= /couldn'?t search the roster/i

const search = async (q = 'Mar') => {
  const box = await screen.findByRole('textbox')
  fireEvent.change(box, { target: { value: q } })
  await act(async () => { await new Promise(r => setTimeout(r, 400)) })
}

beforeEach(() => vi.unstubAllGlobals())

describe('reading the kiosk', () => {
  it('CONTROL: a working kiosk shows its services', async () => {
    routes(); mount()
    expect(await screen.findByText(/Sunday Mass/i)).toBeInTheDocument()
    expect(screen.queryByText(ROTATED)).not.toBeInTheDocument()
  })

  it('a 404 really is a rotated link, and still says so', async () => {
    routes({ '/api/kiosk/tok123': () => err(404) }); mount()
    expect(await screen.findByText(ROTATED)).toBeInTheDocument()
    expect(screen.getByText(/fresh kiosk link/i)).toBeInTheDocument()
  })

  for (const status of [500, 503]) {
    it(`a ${status} must not blame the link`, async () => {
      routes({ '/api/kiosk/tok123': () => err(status) }); mount()
      expect(await screen.findByText(OUR_SIDE)).toBeInTheDocument()
      expect(screen.queryByText(ROTATED)).not.toBeInTheDocument()
      // The advice must match the diagnosis: a retry, not a fresh link.
      expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument()
      expect(screen.queryByText(/fresh kiosk link/i)).not.toBeInTheDocument()
    })
  }
})

describe('searching the roster', () => {
  it('CONTROL: a match is offered', async () => {
    routes(); mount()
    await screen.findByText(/Sunday Mass/i)
    await search()
    expect(await screen.findByText('Maria Ruiz')).toBeInTheDocument()
    expect(screen.queryByText(SEARCH_BAD)).not.toBeInTheDocument()
  })

  it('CONTROL: a genuine non-match still points at the guest button', async () => {
    routes({ '/members': () => ok({ members: [] }) }); mount()
    await screen.findByText(/Sunday Mass/i)
    await search('Zzz')
    expect(await screen.findByText(NO_MATCH)).toBeInTheDocument()
    expect(screen.queryByText(SEARCH_BAD)).not.toBeInTheDocument()
  })

  it('a failed search must NOT steer the volunteer into a duplicate guest record', async () => {
    routes({ '/members': () => err(500) }); mount()
    await screen.findByText(/Sunday Mass/i)
    await search()
    expect(await screen.findByText(SEARCH_BAD)).toBeInTheDocument()
    expect(screen.queryByText(NO_MATCH)).not.toBeInTheDocument()
  })
})

describe('the check-in write — the one that must never lie', () => {
  it('CONTROL: a successful check-in confirms by name', async () => {
    routes(); mount()
    await screen.findByText(/Sunday Mass/i)
    await search()
    await act(async () => { fireEvent.click(await screen.findByText('Maria Ruiz')) })
    await waitFor(() => expect(calls.some(c => c.method === 'POST' && c.url.includes('/checkin'))).toBe(true))
  })

  for (const [label, handler] of [
    ['a 500',                  () => err(500)],
    ['a 409 already checked in', () => err(409, { error: 'Already checked in' })],
    ['a dropped connection',   () => { throw new TypeError('Failed to fetch') }],
  ]) {
    it(`${label} on the write must not show anyone as checked in`, async () => {
      routes({ '/checkin': handler }); mount()
      await screen.findByText(/Sunday Mass/i)
      await search()
      await act(async () => { fireEvent.click(await screen.findByText('Maria Ruiz')) })
      await waitFor(() => expect(calls.some(c => c.method === 'POST' && c.url.includes('/checkin'))).toBe(true))
      await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
      // The SUCCESS SCREEN specifically — not any text containing "checked
      // in". The first version of this assertion used /checked in/i and the
      // 409's own honest refusal ("Already checked in") tripped it: a matcher
      // that cannot tell the lie from the truthful refusal is not a test.
      expect(screen.queryByText(/You'?re checked in!/i)).not.toBeInTheDocument()
    })
  }
})
