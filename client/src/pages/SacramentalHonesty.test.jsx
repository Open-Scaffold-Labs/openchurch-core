// Sacramental honesty regressions (Pass 6).
//
// Two defects observed at runtime on 27 Aug 2026, both of the same family:
// a failed read rendered as a confident, complete-looking answer.
//
//   1. GET /api/sacraments failing (500 / malformed body / aborted / 403)
//      rendered "No sacraments recorded yet" — the register claiming the
//      parish has never administered a sacrament.
//   2. GET /api/sacraments/:id returning 200 with `{}` rendered a full,
//      printable, letterheaded certificate certifying no person, no
//      sacrament, no date and no minister — offered with "Save as PDF".
//
// Both tests assert the CONTROL first: the honest state must not be what
// the page shows when the read succeeds, or the assertion proves nothing.

import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import SacramentalRegister from './SacramentalRegister'
import SacramentCertificate from './SacramentCertificate'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 'test-token',
    loading: false,
  }),
}))

const RECORD = {
  id: 1,
  type: 'baptism',
  member_name: 'Maria Test',
  date: '2026-05-10',
  place: 'St Test',
  minister: 'Fr. Corrected',
  certificate_no: 'P6-001',
  meta_attributes: {},
  voided_at: null,
}

// Every route the pages touch answers; the one under test is overridden.
const stubFetch = (handler) => {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    const override = handler(u)
    if (override) return override
    return { ok: true, status: 200, json: async () => ({ records: [], anniversaries: [] }) }
  }))
}

const ok   = (body) => ({ ok: true,  status: 200, json: async () => body })
const fail = (status) => ({ ok: false, status, json: async () => ({ error: 'boom' }) })
const malformed = () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <') } })

const renderRegister = () =>
  render(
    <MemoryRouter>
      <LocaleProvider><SacramentalRegister /></LocaleProvider>
    </MemoryRouter>
  )

const renderCertificate = () =>
  render(
    <MemoryRouter initialEntries={['/register/1/certificate']}>
      <LocaleProvider>
        <Routes><Route path="/register/:id/certificate" element={<SacramentCertificate />} /></Routes>
      </LocaleProvider>
    </MemoryRouter>
  )

const EMPTY_CLAIM = /no sacraments recorded yet/i

beforeEach(() => { vi.unstubAllGlobals() })

describe('SacramentalRegister — a failed read is not an empty register', () => {
  it('CONTROL: a successful read shows the record and never the empty claim', async () => {
    stubFetch(u => u.includes('/api/sacraments?') ? ok({ records: [RECORD] }) : null)
    renderRegister()
    expect(await screen.findByText('Maria Test')).toBeInTheDocument()
    expect(screen.queryByText(EMPTY_CLAIM)).not.toBeInTheDocument()
  })

  it('CONTROL: a genuinely empty register DOES show the empty claim', async () => {
    stubFetch(u => u.includes('/api/sacraments?') ? ok({ records: [] }) : null)
    renderRegister()
    expect(await screen.findByText(EMPTY_CLAIM)).toBeInTheDocument()
  })

  for (const [label, response] of [
    ['a 500',           () => fail(500)],
    ['a 403',           () => fail(403)],
    ['a malformed body', malformed],
  ]) {
    it(`${label} must not claim the parish has recorded no sacraments`, async () => {
      stubFetch(u => u.includes('/api/sacraments?') ? response() : null)
      renderRegister()
      await waitFor(() => expect(screen.getByText(/couldn't open the register/i)).toBeInTheDocument())
      expect(screen.queryByText(EMPTY_CLAIM)).not.toBeInTheDocument()
    })
  }
})

describe('SacramentCertificate — a 200 is not a record', () => {
  it('CONTROL: a complete record produces the certificate', async () => {
    stubFetch(u => u.match(/\/api\/sacraments\/1$/) ? ok(RECORD) : null)
    renderCertificate()
    expect(await screen.findByText('Certificate of Baptism')).toBeInTheDocument()
    expect(screen.getByText('Maria Test')).toBeInTheDocument()
    expect(screen.getByText(/print \/ save as pdf/i)).toBeInTheDocument()
  })

  for (const [label, body] of [
    ['an empty object',        {}],
    ['a null member_name',     { ...RECORD, member_name: null }],
    ['a blank member_name',    { ...RECORD, member_name: '   ' }],
    ['a missing type',         { ...RECORD, type: null }],
    ['a bare {ok:true}',       { ok: true }],
  ]) {
    it(`${label} must not produce a printable certificate`, async () => {
      stubFetch(u => u.match(/\/api\/sacraments\/1$/) ? ok(body) : null)
      renderCertificate()
      expect(await screen.findByText(/came back incomplete/i)).toBeInTheDocument()
      // None of the certificate's attesting furniture may be on screen.
      expect(screen.queryByText(/this is to certify that/i)).not.toBeInTheDocument()
      expect(screen.queryByText(/according to the rites of the church/i)).not.toBeInTheDocument()
      expect(screen.queryByText(/officiating minister/i)).not.toBeInTheDocument()
      expect(screen.queryByText(/print \/ save as pdf/i)).not.toBeInTheDocument()
      expect(screen.queryByText('St Test')).not.toBeInTheDocument()
    })
  }

  it('a voided record still refuses with the void message, not the incomplete one', async () => {
    stubFetch(u => u.match(/\/api\/sacraments\/1$/)
      ? ok({ ...RECORD, voided_at: '2026-08-01T00:00:00Z', voided_reason: 'Entered twice' })
      : null)
    renderCertificate()
    expect(await screen.findByText(/this entry is void/i)).toBeInTheDocument()
    expect(screen.queryByText(/came back incomplete/i)).not.toBeInTheDocument()
  })
})
