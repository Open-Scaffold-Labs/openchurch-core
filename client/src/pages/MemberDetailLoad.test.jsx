// A member's profile, when the reads behind it fail. (C5)
//
// Two places on this page folded FAILED into something more comfortable:
//
//   1. `if (err === 'not-found' || !member)` — a 500 on /api/clients/:id
//      rendered "Member not found — This member doesn't exist or belongs to
//      another organization." A secretary reading that would go looking for
//      a member who was never missing.
//   2. The donations read mapped any failure to `{ lines: [], total: 0 }`,
//      which the panel rendered as "No gifts recorded for this member." — a
//      statement about a parishioner's giving, made from a dropped
//      connection.
//
// Not-found and empty are answers. Failed is the absence of one.

import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import MemberDetail from './MemberDetail'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 'test-token', loading: false,
  }),
}))

const MEMBER = { id: 20013, name: 'Default Probe', email: 'probe@x.com', status: 'active' }

const ok  = (b) => ({ ok: true,  status: 200, json: async () => b })
const err = (s) => ({ ok: false, status: s, json: async () => ({ error: 'boom' }) })

const stubFetch = (routes = []) => vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
  const u = String(url), method = opts.method || 'GET'
  for (const [match, handler] of routes) if (match(u, method)) return handler()
  if (u.includes(`/api/clients/${MEMBER.id}/donations`)) return ok({ lines: [], total: 0, gift_count: 0 })
  if (u.match(/\/api\/clients\/\d+$/))                   return ok(MEMBER)
  return ok({ records: [], entries: [], checkins: [], pledges: [], dates: [] })
}))

const mount = () => render(
  <MemoryRouter initialEntries={[`/clients/${MEMBER.id}`]}>
    <LocaleProvider><ToastProvider><ConfirmProvider>
      <Routes><Route path="/clients/:id" element={<MemberDetail />} /></Routes>
    </ConfirmProvider></ToastProvider></LocaleProvider>
  </MemoryRouter>
)

const NOT_FOUND = /member not found/i
const NO_GIFTS  = /no gifts recorded/i
const UNREAD    = /couldn'?t be read|could not be read|didn'?t load/i

beforeEach(() => vi.unstubAllGlobals())

describe('the member read', () => {
  it('a 500 is not "Member not found"', async () => {
    stubFetch([[u => /\/api\/clients\/\d+$/.test(u), () => err(500)]]); mount()
    await waitFor(() => expect(screen.getAllByText(UNREAD).length).toBeGreaterThan(0))
    expect(screen.queryByText(NOT_FOUND)).not.toBeInTheDocument()
    expect(screen.queryByText(/belongs to another organization/i)).not.toBeInTheDocument()
  })

  it('recovers on retry', async () => {
    let call = 0
    stubFetch([[u => /\/api\/clients\/\d+$/.test(u), () => (++call === 1 ? err(500) : ok(MEMBER))]]); mount()
    await waitFor(() => expect(screen.getAllByText(UNREAD).length).toBeGreaterThan(0))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /try again/i })) })
    expect(await screen.findByText('Default Probe')).toBeInTheDocument()
  })

  it('CONTROL — a 404 IS "Member not found"', async () => {
    stubFetch([[u => /\/api\/clients\/\d+$/.test(u), () => err(404)]]); mount()
    expect(await screen.findByText(NOT_FOUND)).toBeInTheDocument()
    expect(screen.queryByText(UNREAD)).not.toBeInTheDocument()
  })
})

describe('the donations read', () => {
  it('a 500 is not "No gifts recorded"', async () => {
    stubFetch([[u => u.includes('/donations'), () => err(500)]]); mount()
    expect(await screen.findByText('Default Probe')).toBeInTheDocument()
    await waitFor(() => expect(screen.getAllByText(UNREAD).length).toBeGreaterThan(0))
    expect(screen.queryByText(NO_GIFTS)).not.toBeInTheDocument()
  })

  it('recovers the gifts in place on retry', async () => {
    let call = 0
    const GIFTS = { lines: [{ id: 1, category: 'tithe', date: '2026-08-03', method: 'check', amount: 250 }], total: 250, gift_count: 1 }
    stubFetch([[u => u.includes('/donations'), () => (++call === 1 ? err(500) : ok(GIFTS))]]); mount()
    await waitFor(() => expect(screen.getAllByText(UNREAD).length).toBeGreaterThan(0))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /try again/i })) })
    // Once in the header total, once on the line — both are the gift.
    expect((await screen.findAllByText('$250.00')).length).toBeGreaterThan(0)
    expect(screen.queryByText(UNREAD)).not.toBeInTheDocument()
  })

  it('CONTROL — a successful empty read IS "No gifts recorded"', async () => {
    stubFetch(); mount()
    expect(await screen.findByText(NO_GIFTS)).toBeInTheDocument()
    expect(screen.queryByText(UNREAD)).not.toBeInTheDocument()
  })
})
