// Committing a draft to the register: the row's error must tell the truth
// about what happened, because a secretary acts on it.
//
// The commit path used to answer EVERY failure with err.save — "That
// didn't save — nothing was lost. Please try again." Three of those were
// false:
//
//   (a) the draft PATCH succeeded and the commit 400'd on a field the
//       server named ("date must be YYYY-MM-DD…"). The edit DID save, and
//       the one sentence that would let her fix it was thrown away.
//   (b) the commit wrote the record (201) but the answer never arrived;
//       her retry gets 409 "Draft is already committed". The record IS in
//       the register, and "nothing was lost — try again" invites her to
//       type it in a second time.
//   (c) the network dropped. Nothing is known — and "nothing was lost" is
//       knowledge the page does not have.
//
// The control comes first: a clean commit still removes the row and says
// "Entered in the register."

import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { ToastProvider } from '../components/ToastProvider'
import RegisterDrafts from './RegisterDrafts'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 'test-token', loading: false,
  }),
}))

const DRAFT = {
  id: 41, source: 'csv', status: 'pending',
  raw_payload: { type: 'baptism', date: '10/05/1953' },
  draft: { type: 'baptism', date: '10/05/1953', member_name: 'Maria Test' },
}

const ok  = (b, status = 200) => ({ ok: true,  status, json: async () => b })
const err = (status, error)   => ({ ok: false, status, json: async () => (error === undefined ? {} : { error }) })

// `commitResponse` may be a response object or a function that throws (to
// stand in for a dropped connection). `patchResponse` likewise.
const stubFetch = ({ patchResponse = ok({ draft: DRAFT }), commitResponse }) => {
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url)
    if (u.includes('/api/sacraments/drafts?')) return ok({ drafts: [DRAFT] })
    if (u.endsWith('/api/clients')) return ok([])
    if (u.match(/\/api\/sacraments\/drafts\/41$/) && opts.method === 'PATCH') {
      return typeof patchResponse === 'function' ? patchResponse() : patchResponse
    }
    if (u.match(/\/api\/sacraments\/drafts\/41\/commit$/)) {
      return typeof commitResponse === 'function' ? commitResponse() : commitResponse
    }
    return ok({})
  }))
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <LocaleProvider><ToastProvider><RegisterDrafts /></ToastProvider></LocaleProvider>
    </MemoryRouter>
  )

const NOTHING_LOST = /nothing was lost/i
const DIDNT_SAVE   = /didn't save/i

async function pressCommit() {
  fireEvent.click(await screen.findByRole('button', { name: /commit to register/i }))
}

beforeEach(() => vi.unstubAllGlobals())

describe('RegisterDrafts — commit outcomes', () => {
  it('CONTROL: a 201 removes the row and says it was entered', async () => {
    stubFetch({ commitResponse: ok({ id: 900 }, 201) })
    renderPage()
    await pressCommit()
    expect(await screen.findByText(/entered in the register/i)).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText('Maria Test')).not.toBeInTheDocument())
  })

  it('(a) a 400 with a server message shows that message verbatim, not "nothing was lost"', async () => {
    const MSG = 'date must be YYYY-MM-DD (the register does not take "10/05/1953" until a person has resolved which day that was)'
    stubFetch({ commitResponse: err(400, MSG) })
    renderPage()
    await pressCommit()
    expect(await screen.findByText(MSG)).toBeInTheDocument()
    expect(screen.queryByText(NOTHING_LOST)).not.toBeInTheDocument()
    expect(screen.queryByText(DIDNT_SAVE)).not.toBeInTheDocument()
    // The draft is still here to be fixed.
    expect(screen.getByDisplayValue('Maria Test')).toBeInTheDocument()
  })

  it('(b) a 409 "already committed" is treated as committed: the row goes, and no "didn\'t save"', async () => {
    stubFetch({ commitResponse: err(409, 'Draft is already committed') })
    renderPage()
    await pressCommit()
    expect(await screen.findByText(/already in the register/i)).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByDisplayValue('Maria Test')).not.toBeInTheDocument())
    expect(screen.queryByText(DIDNT_SAVE)).not.toBeInTheDocument()
    expect(screen.queryByText(NOTHING_LOST)).not.toBeInTheDocument()
  })

  it('(b2) the REAL retry path: the pre-commit save answers 404 "no longer pending" — the commit route is asked, and it says already committed', async () => {
    // Driven in Chromium against the real server: a draft committed in
    // another tab makes the PATCH 404 first, so the 409 branch above was
    // never reached and the secretary read "Draft not found or no longer
    // pending" beside a line that was already in the register.
    stubFetch({ patchResponse: err(404, 'Draft not found or no longer pending'), commitResponse: err(409, 'Draft is already committed') })
    renderPage()
    await pressCommit()
    expect(await screen.findByText(/already in the register/i)).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByDisplayValue('Maria Test')).not.toBeInTheDocument())
    expect(screen.queryByText(/no longer pending/i)).not.toBeInTheDocument()
  })

  it('(c) a dropped connection on commit says the page does not know, and to check the register', async () => {
    stubFetch({ commitResponse: () => { throw new TypeError('Failed to fetch') } })
    renderPage()
    await pressCommit()
    expect(await screen.findByText(/couldn't reach the server/i)).toBeInTheDocument()
    expect(screen.getByText(/check the register before/i)).toBeInTheDocument()
    expect(screen.queryByText(NOTHING_LOST)).not.toBeInTheDocument()
    expect(screen.queryByText(DIDNT_SAVE)).not.toBeInTheDocument()
    // Nothing was confirmed, so the row stays.
    expect(screen.getByDisplayValue('Maria Test')).toBeInTheDocument()
  })

  it('a PATCH refusal with a server message shows that message, and the row stays', async () => {
    stubFetch({ patchResponse: err(400, 'meta_attributes.godparents must be an array of names'), commitResponse: ok({}, 201) })
    renderPage()
    await pressCommit()
    expect(await screen.findByText('meta_attributes.godparents must be an array of names')).toBeInTheDocument()
    expect(screen.queryByText(NOTHING_LOST)).not.toBeInTheDocument()
    expect(screen.getByDisplayValue('Maria Test')).toBeInTheDocument()
  })
})
