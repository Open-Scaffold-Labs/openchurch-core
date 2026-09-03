// The third public surface with the same defect. (Pass 10 §6)
//
// A volunteer opens a swap link from a text message. No session, no admin
// panel, no way to tell a dead link from a bad minute.
//
// The page showed "Link not found" as its HEADING above a body that said
// "We couldn't reach the server" — contradicting itself — and then advised
// asking an admin for a fresh link, which is right for one of those and
// useless for the other.

import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import PublicSwap from './PublicSwap'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: null, token: null, loading: false }),
}))

// Copied from server/src/routes/swap.js, not guessed. Three fixtures this
// pass were invented from memory and every one of them died on a field the
// page reads — which looks exactly like a component defect until you check.
const SWAP = {
  me:  { id: 1, name: 'Ana Probe', organization_id: 1, reminders_opt_out: false },
  org: { locale: 'en' },
  upcoming_assignments: [{ id: 11, calendar_event_id: 5, title: 'Sunday Mass', date: '2026-09-06', time: '10:00', role: 'Reader' }],
  swap_requests: [],
  roster: [],
}
const ok  = (b) => ({ ok: true,  status: 200, json: async () => b })
const err = (s, b = { error: 'boom' }) => ({ ok: false, status: s, json: async () => b })

const routes = (over = {}) => vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
  const u = String(url)
  for (const [frag, h] of Object.entries(over)) if (u.includes(frag)) return h()
  if (u.includes('/members')) return ok({ members: [{ id: 2, name: 'Luis Probe' }] })
  return ok(SWAP)
}))

const mount = () => render(
  <MemoryRouter initialEntries={['/swap/tok-abc']}>
    <LocaleProvider>
      <Routes><Route path="/swap/:token" element={<PublicSwap />} /></Routes>
    </LocaleProvider>
  </MemoryRouter>
)

const NOT_FOUND = /link not found/i
const OUR_SIDE  = /couldn'?t open your swap link/i
const FRESH     = /fresh swap link/i

beforeEach(() => vi.unstubAllGlobals())

describe('asking someone to swap', () => {
  const openRequest = async () => {
    mount()
    await screen.findByText(/Sunday Mass/i)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /request swap/i })) })
    const box = await screen.findByPlaceholderText(/start typing a name/i)
    fireEvent.change(box, { target: { value: 'Lui' } })
    await act(async () => { await new Promise(r => setTimeout(r, 400)) })
  }

  it('CONTROL: a match is offered, and a genuine non-match says nobody by that name', async () => {
    routes(); await openRequest()
    expect(await screen.findByText('Luis Probe')).toBeInTheDocument()
    expect(screen.queryByText(/couldn'?t search just now/i)).not.toBeInTheDocument()
  })

  it('a genuine non-match keeps its own answer', async () => {
    routes({ '/members': () => ok({ members: [] }) }); await openRequest()
    expect(await screen.findByText(/nobody by that name/i)).toBeInTheDocument()
    expect(screen.queryByText(/couldn'?t search just now/i)).not.toBeInTheDocument()
  })

  it('a failed search must not say nobody by that name', async () => {
    routes({ '/members': () => err(500) }); await openRequest()
    expect(await screen.findByText(/couldn'?t search just now/i)).toBeInTheDocument()
    expect(screen.queryByText(/nobody by that name/i)).not.toBeInTheDocument()
  })
})

describe('opening the link', () => {
  it('CONTROL: a valid link opens', async () => {
    routes(); mount()
    await waitFor(() => expect(screen.queryByText(NOT_FOUND)).not.toBeInTheDocument())
    expect(screen.queryByText(OUR_SIDE)).not.toBeInTheDocument()
  })

  it('a 404 is a link that really is gone, and says so with the right advice', async () => {
    routes({ '/api/swap/by-token/tok-abc': () => err(404) }); mount()
    expect(await screen.findByText(NOT_FOUND)).toBeInTheDocument()
    expect(screen.getByText(FRESH)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument()
  })

  for (const status of [500, 503]) {
    it(`a ${status} must not headline "link not found"`, async () => {
      routes({ '/api/swap/by-token/tok-abc': () => err(status) }); mount()
      expect(await screen.findByText(OUR_SIDE)).toBeInTheDocument()
      expect(screen.queryByText(NOT_FOUND)).not.toBeInTheDocument()
      // The advice moves with the diagnosis.
      expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument()
      expect(screen.queryByText(FRESH)).not.toBeInTheDocument()
    })
  }

  it('§11 the chain: fails, the visitor retries, the page recovers in place', async () => {
    let first = true
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (!String(url).includes('/api/swap/by-token/tok-abc')) return ok({ members: [] })
      if (first) { first = false; return err(500) }
      return ok(SWAP)
    }))
    mount()
    expect(await screen.findByText(OUR_SIDE)).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /try again/i })) })
    await waitFor(() => expect(screen.queryByText(OUR_SIDE)).not.toBeInTheDocument())
    expect(screen.queryByText(NOT_FOUND)).not.toBeInTheDocument()
  })
})
