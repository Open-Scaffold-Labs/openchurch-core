// Certificate return home — the extract already knows the person when
// it was opened from their profile. Without from=member (or without a
// linked member on the entry) the book stays the parent.
//
// Mutate any one of these and the matching test goes red:
//   1. Profile Certificate drops ?from=member
//   2. from=member + client_id + name no longer returns to /clients/:id
//   3. A historical / unlinked name is treated as a member
//   4. Direct / register entry invents a member return

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import SacramentCertificate, { certificateReturnHome } from './SacramentCertificate'
import MemberDetail from './MemberDetail'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 'test-token', loading: false,
  }),
}))

const RECORD = {
  id: 1,
  type: 'baptism',
  member_name: 'Maria Test',
  client_id: 44,
  date: '2018-06-10',
  place: 'Parish Church',
  minister: 'Fr. James Wright',
  certificate_no: 'P2-001',
  meta_attributes: {},
  voided_at: null,
}

const MEMBER = { id: 44, name: 'Maria Test', email: 'maria@x.com', status: 'active' }

const ok = (body) => ({ ok: true, status: 200, json: async () => body })

const stubCert = (body = RECORD) => {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    if (u.match(/\/api\/sacraments\/1$/)) return ok(body)
    return ok({})
  }))
}

const stubProfile = () => {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    if (u.includes(`/api/clients/${MEMBER.id}/donations`)) return ok({ lines: [], total: 0, gift_count: 0 })
    if (u.match(/\/api\/clients\/\d+$/)) return ok(MEMBER)
    if (u.includes('/api/sacraments?client_id')) return ok({ records: [RECORD] })
    return ok({ records: [], entries: [], checkins: [], pledges: [], dates: [] })
  }))
}

const wrapCert = (path) => render(
  <MemoryRouter initialEntries={[path]}>
    <LocaleProvider>
      <Routes>
        <Route path="/register/:id/certificate" element={<SacramentCertificate />} />
      </Routes>
    </LocaleProvider>
  </MemoryRouter>
)

const CERT_SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'SacramentCertificate.jsx'),
  'utf8',
)

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.removeItem('ochr_locale')
})
afterEach(() => {
  localStorage.removeItem('ochr_locale')
})

describe('certificateReturnHome', () => {
  it('from=member returns to the linked profile; everything else stays on the book', () => {
    expect(certificateReturnHome('member', RECORD)).toEqual({
      to: '/clients/44', labelKey: 'cert.backMember', name: 'Maria Test',
    })
    expect(certificateReturnHome(null, RECORD)).toEqual({ to: '/register', labelKey: 'cert.back' })
    expect(certificateReturnHome('register', RECORD)).toEqual({ to: '/register', labelKey: 'cert.back' })
    expect(certificateReturnHome('member', { ...RECORD, client_id: null })).toEqual({
      to: '/register', labelKey: 'cert.back',
    })
    expect(certificateReturnHome('member', { ...RECORD, member_name: '   ' })).toEqual({
      to: '/register', labelKey: 'cert.back',
    })
    expect(certificateReturnHome('member', { ...RECORD, client_id: 'not-an-id' })).toEqual({
      to: '/register', labelKey: 'cert.back',
    })
  })
})

describe('certificate toolbar return', () => {
  it('CONTROL: a register/direct open still says Register and goes to the book', async () => {
    stubCert()
    wrapCert('/register/1/certificate')
    const back = await screen.findByRole('link', { name: /^register$/i })
    expect(back.getAttribute('href')).toBe('/register')
    expect(screen.queryByRole('link', { name: /back to maria/i })).toBeNull()
  })

  it('from=member + linked person returns to that profile', async () => {
    stubCert()
    wrapCert('/register/1/certificate?from=member')
    const back = await screen.findByRole('link', { name: /back to maria test/i })
    expect(back.getAttribute('href')).toBe('/clients/44')
    expect(screen.queryByRole('link', { name: /^register$/i })).toBeNull()
  })

  it('from=member without a linked member stays on the book — no invented person', async () => {
    stubCert({ ...RECORD, client_id: null })
    wrapCert('/register/1/certificate?from=member')
    const back = await screen.findByRole('link', { name: /^register$/i })
    expect(back.getAttribute('href')).toBe('/register')
    expect(screen.queryByRole('link', { name: /back to/i })).toBeNull()
  })

  it('a vanished record does not follow from=member', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 404, json: async () => ({}),
    })))
    wrapCert('/register/1/certificate?from=member')
    const back = await screen.findByRole('link', { name: /back to the register/i })
    expect(back.getAttribute('href')).toBe('/register')
  })
})

describe('member profile Certificate hop', () => {
  it('carries from=member so the extract can return', async () => {
    stubProfile()
    render(
      <MemoryRouter initialEntries={[`/clients/${MEMBER.id}`]}>
        <LocaleProvider>
          <ToastProvider><ConfirmProvider>
            <Routes><Route path="/clients/:id" element={<MemberDetail />} /></Routes>
          </ConfirmProvider></ToastProvider>
        </LocaleProvider>
      </MemoryRouter>
    )
    const cert = await screen.findByRole('link', { name: /^certificate$/i })
    expect(cert.getAttribute('href')).toBe('/register/1/certificate?from=member')
  })
})

describe('certificate void refuse is translated (POLISH-L0-02)', () => {
  const VOIDED = { ...RECORD, voided_at: '2026-01-01T00:00:00.000Z', voided_reason: 'entered twice' }

  it('ENGLISH VOID TITLE/BODY USE EXISTING record.voided* KEYS', async () => {
    stubCert(VOIDED)
    wrapCert('/register/1/certificate?from=member')
    expect(await screen.findByText(STRINGS.en['record.voidedTitle'])).toBeInTheDocument()
    expect(screen.getByText(STRINGS.en['record.voidedBody'])).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /print/i })).toBeNull()
  })

  it('SPANISH VOID TITLE/BODY ARE SPANISH — NOT THE ENGLISH SENTENCE', async () => {
    localStorage.setItem('ochr_locale', 'es')
    stubCert(VOIDED)
    wrapCert('/register/1/certificate?from=member')
    expect(await screen.findByText(STRINGS.es['record.voidedTitle'])).toBeInTheDocument()
    expect(screen.getByText(STRINGS.es['record.voidedBody'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['record.voidedTitle'])).not.toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['record.voidedBody'])).not.toBeInTheDocument()
  })

  it('i18n strings and the component wiring cannot reintroduce hard-EN void copy', () => {
    const jsx = stripComments(CERT_SRC)
    expect(CERT_SRC).toMatch(/t\('record\.voidedTitle'\)/)
    expect(CERT_SRC).toMatch(/t\('record\.voidedBody'\)/)
    expect(CERT_SRC).toMatch(/useLocale\(/)
    expect(jsx).not.toMatch(/>This entry is void</)
    expect(jsx).not.toMatch(/No certificate can be issued from a voided register entry/)
    expect(STRINGS.en['record.voidedTitle']).toBe('This entry is void')
    expect(STRINGS.es['record.voidedTitle']).toMatch(/esta partida está anulada/i)
    expect(STRINGS.es['record.voidedTitle']).not.toBe(STRINGS.en['record.voidedTitle'])
    expect(STRINGS.es['record.voidedBody']).not.toBe(STRINGS.en['record.voidedBody'])
  })
})
