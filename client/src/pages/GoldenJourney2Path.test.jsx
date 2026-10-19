// GJ2-L1-03 — remaining certificate-path chrome, synthetic only.
//
// Happy hop + void refuse already live in GoldenJourney2.test.jsx.
// This file pins the leftover hard-EN on the same path: Sacraments
// heading, empty ≠ unread, Certificate hop label, 404 back-to-register,
// unknown-type title/phrase, parish-name fallback.
// No real parish / member / sacramental names.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import Clients from './Clients'
import MemberDetail from './MemberDetail'
import SacramentCertificate from './SacramentCertificate'
import {
  GJ2_AUTH_USER,
  GJ2_MEMBER_ID,
  GJ2_LIVE_NAME,
  GJ2_MISSING_ID,
  GJ2_FAIL_ID,
  GJ2_OTHER_ID,
  GJ2_OTHER_NAME,
  GJ2_UNKNOWN_ID,
  stubGoldenJourney2Fetch,
} from './goldenJourney2.fixture.js'

const auth = { ...GJ2_AUTH_USER }

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: auth,
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

function renderJourney(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <LocaleProvider>
        <ToastProvider>
          <ConfirmProvider>
            <Routes>
              <Route path="/clients" element={<Clients />} />
              <Route path="/clients/:id" element={<MemberDetail />} />
              <Route path="/register/:id/certificate" element={<SacramentCertificate />} />
            </Routes>
          </ConfirmProvider>
        </ToastProvider>
      </LocaleProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.removeItem('ochr_locale')
  auth.organization = { ...GJ2_AUTH_USER.organization }
  stubGoldenJourney2Fetch(vi)
})

afterEach(() => {
  localStorage.removeItem('ochr_locale')
})

const CERT_SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'SacramentCertificate.jsx'), 'utf8')
const MEMBER_SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'MemberDetail.jsx'), 'utf8')

describe('GJ2-L0-04 honesty — leftover language must stay localized', () => {
  it('cert.loadFailed no longer interpolates HTTP status (mutate this to RED)', () => {
    expect(CERT_SRC).not.toMatch(/cert\.loadFailed['"],\s*\{\s*status/)
    expect(STRINGS.en['cert.loadFailed']).not.toMatch(/\{status\}/)
    expect(STRINGS.es['cert.loadFailed']).not.toMatch(/\{status\}/)
    expect(STRINGS.en['cert.loadFailed']).not.toMatch(/\d{3}/)
    expect(STRINGS.es['cert.loadFailed']).not.toMatch(/\d{3}/)
  })

  it('write-form no longer hard-codes Certificate # or English type map', () => {
    expect(MEMBER_SRC).not.toMatch(/Certificate #/)
    expect(MEMBER_SRC).not.toMatch(/SACRAMENT_LABELS/)
    expect(MEMBER_SRC).toMatch(/member\.certificateNo/)
    expect(MEMBER_SRC).toMatch(/member\.sacramentsSub/)
  })
})

describe('GJ2-L1-03 certificate-path chrome', () => {
  it('EN: Sacraments heading + Certificate hop; empty ≠ unread', async () => {
    renderJourney(`/clients/${GJ2_OTHER_ID}`)
    expect(await screen.findByRole('heading', { name: GJ2_OTHER_NAME })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: STRINGS.en['member.sacraments'] })).toBeInTheDocument()
    expect(await screen.findByText(STRINGS.en['register.emptyTitle'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['member.sacramentsUnread'])).not.toBeInTheDocument()
  })

  it('ES: Sacramentos / Certificado — not the English hop words', async () => {
    localStorage.setItem('ochr_locale', 'es')
    renderJourney(`/clients/${GJ2_MEMBER_ID}`)
    expect(await screen.findByRole('heading', { name: STRINGS.es['member.sacraments'] })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: STRINGS.en['member.sacraments'] })).toBeNull()
    const hop = await screen.findByRole('link', { name: STRINGS.es['register.certificate'] })
    expect(hop.getAttribute('href')).toMatch(/\/certificate\?from=member$/)
    expect(screen.queryByRole('link', { name: STRINGS.en['register.certificate'] })).toBeNull()
  })

  it('404 extract stays on the register — localized back, no paper', async () => {
    renderJourney(`/register/${GJ2_MISSING_ID}/certificate?from=member`)
    expect(await screen.findByText(STRINGS.en['cert.notFound'])).toBeInTheDocument()
    const back = screen.getByRole('link', { name: new RegExp(STRINGS.en['cert.backRegister'], 'i') })
    expect(back.getAttribute('href')).toBe('/register')
    expect(screen.queryByRole('button', { name: /print/i })).toBeNull()
    expect(screen.queryByTestId('certificate-print-not-emailed')).toBeNull()
  })

  it('EN write-form: subtitle + Certificate # + Baptism — no hard-EN leftover keys', async () => {
    renderJourney(`/clients/${GJ2_MEMBER_ID}`)
    expect(await screen.findByText(STRINGS.en['member.sacramentsSub'].replace('{name}', GJ2_LIVE_NAME))).toBeInTheDocument()
    expect(await screen.findByText(STRINGS.en['sac.baptism'])).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: STRINGS.en['member.recordSacrament'] }))
    expect(screen.getByText(STRINGS.en['member.certificateNo'])).toBeInTheDocument()
    expect(screen.getByText(STRINGS.en['member.newSacramentRecord'])).toBeInTheDocument()
    expect(screen.getByRole('option', { name: STRINGS.en['sac.baptism'] })).toBeInTheDocument()
  })

  it('ES write-form: subtitle / Certificado n.º / Bautismo — not Certificate #', async () => {
    localStorage.setItem('ochr_locale', 'es')
    renderJourney(`/clients/${GJ2_MEMBER_ID}`)
    expect(await screen.findByText(STRINGS.es['member.sacramentsSub'].replace('{name}', GJ2_LIVE_NAME))).toBeInTheDocument()
    expect(await screen.findByText(STRINGS.es['sac.baptism'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['member.sacramentsSub'].replace('{name}', GJ2_LIVE_NAME))).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: STRINGS.es['member.recordSacrament'] }))
    expect(screen.getByText(STRINGS.es['member.certificateNo'])).toBeInTheDocument()
    expect(screen.queryByText('Certificate #')).not.toBeInTheDocument()
    expect(screen.getByRole('option', { name: STRINGS.es['sac.baptism'] })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: STRINGS.en['sac.baptism'] })).toBeNull()
  })

  it('500 extract is truthful — no HTTP status interpolation', async () => {
    renderJourney(`/register/${GJ2_FAIL_ID}/certificate`)
    expect(await screen.findByText(STRINGS.en['cert.loadFailed'])).toBeInTheDocument()
    expect(screen.queryByText(/503/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Failed to load/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /print/i })).toBeNull()
  })

  it('ES 500 is Spanish and still hides the status code', async () => {
    localStorage.setItem('ochr_locale', 'es')
    renderJourney(`/register/${GJ2_FAIL_ID}/certificate`)
    expect(await screen.findByText(STRINGS.es['cert.loadFailed'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['cert.loadFailed'])).not.toBeInTheDocument()
    expect(screen.queryByText(/503/)).not.toBeInTheDocument()
    expect(screen.queryByText(/\(\s*status\s*\)/i)).not.toBeInTheDocument()
  })

  it('ES 404 is Spanish — not the English not-found sentence', async () => {
    localStorage.setItem('ochr_locale', 'es')
    renderJourney(`/register/${GJ2_MISSING_ID}/certificate?from=member`)
    expect(await screen.findByText(STRINGS.es['cert.notFound'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['cert.notFound'])).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: new RegExp(STRINGS.es['cert.backRegister'], 'i') }).getAttribute('href')).toBe('/register')
  })

  it('unknown type uses Certificate / received-this-sacrament — no invented rite title', async () => {
    renderJourney(`/register/${GJ2_UNKNOWN_ID}/certificate?from=member`)
    expect(await screen.findByRole('heading', { name: STRINGS.en['register.certificate'] })).toBeInTheDocument()
    expect(screen.getByText(new RegExp(STRINGS.en['cert.phrase.unknown'], 'i'))).toBeInTheDocument()
    expect(screen.queryByText(/certificate of baptism/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/custom_rite/i)).not.toBeInTheDocument()
  })

  it('missing parish name falls back to Our Parish / Nuestra Parroquia', async () => {
    auth.organization = { id: 1, locale: 'en', tradition: 'catholic' }
    renderJourney(`/register/${GJ2_UNKNOWN_ID}/certificate`)
    expect(await screen.findByText(STRINGS.en['cert.parishFallback'])).toBeInTheDocument()
  })

  it('ES missing parish name is Nuestra Parroquia — not Our Parish', async () => {
    localStorage.setItem('ochr_locale', 'es')
    auth.organization = { id: 1, locale: 'es', tradition: 'catholic' }
    renderJourney(`/register/${GJ2_UNKNOWN_ID}/certificate`)
    expect(await screen.findByText(STRINGS.es['cert.parishFallback'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['cert.parishFallback'])).not.toBeInTheDocument()
  })
})
