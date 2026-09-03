// The sacrament section of a member's profile (Pass 6 §3).
//
// This is the screen a secretary opens when someone asks "was she baptised
// here?", and it is the only place in the app that writes to the register.
// Four defects observed at runtime on 27 Aug 2026:
//
//   1. A failed read rendered "No sacraments recorded yet." — the member
//      being declared unbaptised because a request 500'd.
//   2. Worse: after a SUCCESSFUL save, the reload ran, failed, and emptied
//      the list silently. The record was in the database; the page said the
//      member had none, with no error at all.
//   3. Editing was impossible. The server has required an amendment reason
//      since migration 073 (REG.1) and this form had no such field, so every
//      correction returned "A reason is required to change the register".
//   4. Remove called DELETE, which the server refuses for everyone with a
//      405 and an instruction to void instead — and the UI threw that
//      instruction away, showing "Failed (405)".

import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import MemberDetail from './MemberDetail'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 'test-token',
    loading: false,
  }),
}))

const MEMBER = { id: 20013, name: 'Default Probe', email: 'probe@x.com', status: 'active' }
const REC = {
  id: 2, type: 'baptism', date: '2026-05-10', minister: 'Fr. Corrected',
  place: 'St Test', certificate_no: 'P6-002', notes: null,
}

const EMPTY_CLAIM = /no sacraments recorded yet/i
const UNREAD      = /could not be read/i

// One stub for every endpoint the profile touches; `routes` overrides the
// ones a given test cares about. Each entry is [matcher, handler].
const stubFetch = (routes = []) => {
  const calls = []
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url), method = opts.method || 'GET'
    calls.push({ url: u, method, body: opts.body ? JSON.parse(opts.body) : null })
    for (const [match, handler] of routes) {
      if (match(u, method)) return handler()
    }
    if (u.includes(`/api/clients/${MEMBER.id}/donations`)) return ok({ lines: [], total: 0, gift_count: 0 })
    if (u.match(/\/api\/clients\/\d+$/))                   return ok(MEMBER)
    if (u.includes('/api/sacraments?client_id'))           return ok({ records: [REC] })
    return ok({ records: [], entries: [], checkins: [], pledges: [], dates: [] })
  }))
  return calls
}
const ok   = (body) => ({ ok: true,  status: 200, json: async () => body })
const err  = (status, body = { error: 'boom' }) => ({ ok: false, status, json: async () => body })

const renderProfile = () =>
  render(
    <MemoryRouter initialEntries={[`/clients/${MEMBER.id}`]}>
      <LocaleProvider>
        <ToastProvider><ConfirmProvider>
          <Routes><Route path="/clients/:id" element={<MemberDetail />} /></Routes>
        </ConfirmProvider></ToastProvider>
      </LocaleProvider>
    </MemoryRouter>
  )

const sacramentList = () => u => u.includes('/api/sacraments?client_id')

beforeEach(() => { vi.unstubAllGlobals() })

describe("a member's sacramental record", () => {
  it('CONTROL: a successful read shows the record and never the empty claim', async () => {
    stubFetch()
    renderProfile()
    expect(await screen.findByText(/Cert\. P6-002/)).toBeInTheDocument()
    expect(screen.queryByText(EMPTY_CLAIM)).not.toBeInTheDocument()
    expect(screen.queryByText(UNREAD)).not.toBeInTheDocument()
  })

  it('CONTROL: a member with genuinely no sacraments DOES show the empty claim', async () => {
    stubFetch([[sacramentList(), () => ok({ records: [] })]])
    renderProfile()
    expect(await screen.findByText(EMPTY_CLAIM)).toBeInTheDocument()
    expect(screen.queryByText(UNREAD)).not.toBeInTheDocument()
  })

  for (const status of [500, 403]) {
    it(`a ${status} must not declare the member has no sacraments`, async () => {
      stubFetch([[sacramentList(), () => err(status)]])
      renderProfile()
      expect(await screen.findByText(UNREAD)).toBeInTheDocument()
      expect(screen.queryByText(EMPTY_CLAIM)).not.toBeInTheDocument()
    })
  }

  it('a saved record whose reload fails is reported as saved, not as absent', async () => {
    let listCalls = 0
    stubFetch([
      [sacramentList(), () => (++listCalls === 1 ? ok({ records: [REC] }) : err(500))],
      [(u, m) => u.endsWith('/api/sacraments') && m === 'POST', () => ok({ id: 9 })],
    ])
    renderProfile()
    await screen.findByText(/Cert\. P6-002/)

    fireEvent.click(screen.getByRole('button', { name: /record a sacrament/i }))
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    expect(await screen.findByText(/was saved, but this list could not be refreshed/i)).toBeInTheDocument()
    // The record that was already on screen must not disappear...
    expect(screen.getByText(/Cert\. P6-002/)).toBeInTheDocument()
    // ...and the page must not claim the member has none.
    expect(screen.queryByText(EMPTY_CLAIM)).not.toBeInTheDocument()
  })
})

describe('correcting a register entry (REG.1)', () => {
  const openEdit = async () => {
    renderProfile()
    await screen.findByText(/Cert\. P6-002/)
    fireEvent.click(screen.getByRole('button', { name: /edit baptism record/i }))
  }

  it('Save is refused until a reason is given', async () => {
    stubFetch()
    await openEdit()
    const save = screen.getByRole('button', { name: /save changes/i })
    expect(save).toBeDisabled()
    fireEvent.change(screen.getByPlaceholderText(/misspelled/i), { target: { value: 'ok' } })
    expect(save).toBeDisabled()          // under the server's 3-char minimum
    fireEvent.change(screen.getByPlaceholderText(/misspelled/i), { target: { value: 'name was misspelled' } })
    expect(save).toBeEnabled()
  })

  it('the reason reaches the server, which is what the PATCH requires', async () => {
    const calls = stubFetch([[(u, m) => u.includes('/api/sacraments/2') && m === 'PATCH', () => ok(REC)]])
    await openEdit()
    fireEvent.change(screen.getByPlaceholderText(/misspelled/i), { target: { value: 'name was misspelled' } })
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
    await waitFor(() => {
      const patch = calls.find(c => c.method === 'PATCH')
      expect(patch).toBeTruthy()
      expect(patch.body.reason).toBe('name was misspelled')
    })
  })

  it('a new record is not a correction and asks for no reason', async () => {
    stubFetch()
    renderProfile()
    await screen.findByText(/Cert\. P6-002/)
    fireEvent.click(screen.getByRole('button', { name: /record a sacrament/i }))
    expect(screen.queryByPlaceholderText(/misspelled/i)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled()
  })
})

describe('removing a register entry', () => {
  it("the server's refusal is shown, and the entry stays", async () => {
    stubFetch([[
      (u, m) => u.includes('/api/sacraments/2') && m === 'DELETE',
      () => err(405, { error: 'Register entries are never deleted. Void the entry instead — it stays in the record, marked void, with your reason.' }),
    ]])
    renderProfile()
    await screen.findByText(/Cert\. P6-002/)
    fireEvent.click(screen.getByRole('button', { name: /remove baptism record/i }))
    expect(await screen.findByText(/never deleted\. Void the entry instead/i)).toBeInTheDocument()
    expect(screen.queryByText(/Failed \(405\)/)).not.toBeInTheDocument()
    expect(screen.getByText(/Cert\. P6-002/)).toBeInTheDocument()
  })
})
