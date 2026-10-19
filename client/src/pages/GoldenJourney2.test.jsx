// Golden Journey 2 — Find a member → linked sacramental record →
// certificate print (OC-GOLDEN-JOURNEY-2 Part B).
//
// One hop: /clients → slide-over → /clients/:id →
// /register/:id/certificate?from=member → window.print().
// No server PDF, email, or Share API. EN+ES localized chrome.
// Snapshot name survives a live roster rename. Void refuses.
//
// Verify:
//   cd client && npm test -- src/pages/GoldenJourney2.test.jsx
// Both journeys:
//   cd client && npm run test:golden
//
// Mutate any one of these and the matching test goes red:
//   1. Profile Certificate drops ?from=member
//   2. Certificate prints the live roster name after a rename
//   3. Print no longer calls window.print()
//   4. printHonesty / Print label leave the certificate chrome
//   5. A voided entry produces a printable certificate
//   6. Profile Remove treats DELETE 405 as erasure

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
  GJ2_CERT_NO,
  GJ2_GODPARENTS,
  GJ2_LIVE_NAME,
  GJ2_MEMBER_ID,
  GJ2_MINISTER,
  GJ2_NOW,
  GJ2_OTHER_NAME,
  GJ2_PLACE,
  GJ2_RECORD_ID,
  GJ2_SNAPSHOT_NAME,
  GJ2_VOIDED_ID,
  stubGoldenJourney2Fetch,
} from './goldenJourney2.fixture.js'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: GJ2_AUTH_USER,
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

function renderJourney(path = '/clients') {
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
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(GJ2_NOW)
  stubGoldenJourney2Fetch(vi)
})

afterEach(() => {
  localStorage.removeItem('ochr_locale')
  vi.useRealTimers()
})

function certLine(locale, n) {
  return STRINGS[locale]['register.certLine'].replaceAll('{n}', n)
}

async function hopMembersToCertificate({ openFull, membersHeading, locale = 'en' }) {
  renderJourney('/clients')
  expect(await screen.findByRole('heading', { name: membersHeading })).toBeInTheDocument()
  expect(screen.getByText(GJ2_LIVE_NAME)).toBeInTheDocument()
  expect(screen.getByText(GJ2_OTHER_NAME)).toBeInTheDocument()

  fireEvent.click(screen.getByText(GJ2_LIVE_NAME))
  const full = await screen.findByRole('link', { name: openFull })
  expect(full.getAttribute('href')).toBe(`/clients/${GJ2_MEMBER_ID}`)
  fireEvent.click(full)

  expect(await screen.findByRole('heading', { name: GJ2_LIVE_NAME })).toBeInTheDocument()
  expect(await screen.findByText(certLine(locale, GJ2_CERT_NO))).toBeInTheDocument()
  expect(screen.getByRole('button', {
    name: STRINGS[locale]['register.editRecord'].replaceAll('{sacrament}', STRINGS[locale]['sac.baptism']),
  })).toBeInTheDocument()
  expect(screen.getByRole('button', {
    name: STRINGS[locale]['register.removeRecord'].replaceAll('{sacrament}', STRINGS[locale]['sac.baptism']),
  })).toBeInTheDocument()
  expect(screen.getByText(STRINGS[locale]['sac.baptism'])).toBeInTheDocument()
  expect(screen.getByText(new RegExp(`${GJ2_MINISTER} — ${GJ2_PLACE}`))).toBeInTheDocument()
  expect(screen.queryByText(GJ2_OTHER_NAME)).not.toBeInTheDocument()

  const hop = screen.getByRole('link', { name: STRINGS[locale]['register.certificate'] })
  expect(hop.getAttribute('href')).toBe(`/register/${GJ2_RECORD_ID}/certificate?from=member`)
  fireEvent.click(hop)
}

function expectPrintHonesty(honesty, copy) {
  expect(honesty.textContent).toMatch(copy)
  expect(honesty.className).toMatch(/print:hidden/)
  expect(screen.queryByRole('button', { name: /share/i })).toBeNull()
  expect(typeof navigator.share).not.toBe('function')
}

describe('Golden Journey 2 — member → linked register → certificate → print', () => {
  it('EN: list → profile hop → snapshot facts, printHonesty, window.print()', async () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => {})
    await hopMembersToCertificate({
      openFull: /open full profile/i,
      membersHeading: /^members$/i,
      locale: 'en',
    })

    expect(await screen.findByText('Certificate of Baptism')).toBeInTheDocument()
    expect(screen.getByText(GJ2_SNAPSHOT_NAME)).toBeInTheDocument()
    expect(screen.queryByText(GJ2_LIVE_NAME)).not.toBeInTheDocument()
    const paper = document.querySelector('article')
    expect(paper.textContent).toMatch(GJ2_PLACE)
    expect(paper.textContent).toMatch(GJ2_MINISTER)
    expect(paper.textContent).toMatch(GJ2_CERT_NO)
    expect(paper.textContent).toMatch(GJ2_GODPARENTS.join(' · '))
    expect(paper.textContent).toMatch(/was baptized/i)
    expect(paper.textContent).toMatch(/this is to certify that/i)
    expect(paper.textContent).toMatch(/June 10, 2018/)
    expect(paper.className).not.toMatch(/print:hidden/)

    const back = screen.getByRole('link', { name: new RegExp(`back to ${GJ2_SNAPSHOT_NAME}`, 'i') })
    expect(back.getAttribute('href')).toBe(`/clients/${GJ2_MEMBER_ID}`)

    const honesty = screen.getByTestId('certificate-print-not-emailed')
    expectPrintHonesty(honesty, /print or save as PDF only/i)
    expect(honesty.textContent).toMatch(/does not email/i)

    const printBtn = screen.getByRole('button', { name: /print \/ save as pdf/i })
    fireEvent.click(printBtn)
    expect(print).toHaveBeenCalledTimes(1)
    print.mockRestore()
  })

  it('ES: same hop, Certificado / Imprimir, no lo envía', async () => {
    localStorage.setItem('ochr_locale', 'es')
    const print = vi.spyOn(window, 'print').mockImplementation(() => {})
    await hopMembersToCertificate({
      openFull: /abrir perfil completo/i,
      membersHeading: /^miembros$/i,
      locale: 'es',
    })

    expect(await screen.findByText('Certificado de Bautismo')).toBeInTheDocument()
    expect(screen.getByText(GJ2_SNAPSHOT_NAME)).toBeInTheDocument()
    expect(screen.queryByText(GJ2_LIVE_NAME)).not.toBeInTheDocument()
    expect(screen.getByText(/recibió el sacramento del Bautismo/i)).toBeInTheDocument()

    const back = screen.getByRole('link', { name: new RegExp(`volver a ${GJ2_SNAPSHOT_NAME}`, 'i') })
    expect(back.getAttribute('href')).toBe(`/clients/${GJ2_MEMBER_ID}`)

    const honesty = screen.getByTestId('certificate-print-not-emailed')
    expectPrintHonesty(honesty, /no lo envía por correo/i)

    const printBtn = screen.getByRole('button', { name: /imprimir \/ guardar como pdf/i })
    fireEvent.click(printBtn)
    expect(print).toHaveBeenCalledTimes(1)
    print.mockRestore()
  })

  it('REG.1: profile Remove surfaces DELETE 405 — entry stays', async () => {
    renderJourney(`/clients/${GJ2_MEMBER_ID}`)
    expect(await screen.findByRole('heading', { name: GJ2_LIVE_NAME })).toBeInTheDocument()
    expect(await screen.findByText(certLine('en', GJ2_CERT_NO))).toBeInTheDocument()
    expect(screen.getByRole('button', {
      name: STRINGS.en['register.editRecord'].replaceAll('{sacrament}', STRINGS.en['sac.baptism']),
    })).toBeInTheDocument()
    expect(screen.getByRole('button', {
      name: STRINGS.en['register.removeRecord'].replaceAll('{sacrament}', STRINGS.en['sac.baptism']),
    })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /remove baptism record/i }))
    expect(await screen.findByText(/never deleted\. Void the entry instead/i)).toBeInTheDocument()
    expect(screen.queryByText(/Failed \(405\)/)).not.toBeInTheDocument()
    expect(screen.getByText(certLine('en', GJ2_CERT_NO))).toBeInTheDocument()
  })

  it('REG.1: voided extract refuses — no paper, no print', async () => {
    renderJourney(`/register/${GJ2_VOIDED_ID}/certificate?from=member`)
    expect(await screen.findByText(STRINGS.en['record.voidedTitle'])).toBeInTheDocument()
    expect(screen.getByText(STRINGS.en['record.voidedBody'])).toBeInTheDocument()
    expect(screen.queryByText(/this is to certify that/i)).not.toBeInTheDocument()
    expect(screen.queryByText('Certificate of Baptism')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /print/i })).toBeNull()
    expect(screen.queryByTestId('certificate-print-not-emailed')).toBeNull()
    const back = screen.getByRole('link', { name: new RegExp(`back to ${GJ2_SNAPSHOT_NAME}`, 'i') })
    expect(back.getAttribute('href')).toBe(`/clients/${GJ2_MEMBER_ID}`)
  })

  it('REG.1 ES: void refuse is Spanish — not the English sentence', async () => {
    localStorage.setItem('ochr_locale', 'es')
    renderJourney(`/register/${GJ2_VOIDED_ID}/certificate?from=member`)
    expect(await screen.findByText(STRINGS.es['record.voidedTitle'])).toBeInTheDocument()
    expect(screen.getByText(STRINGS.es['record.voidedBody'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['record.voidedTitle'])).not.toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['record.voidedBody'])).not.toBeInTheDocument()
    expect(screen.queryByText('Certificate of Baptism')).not.toBeInTheDocument()
    expect(screen.queryByText('Certificado de Bautismo')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /imprimir/i })).toBeNull()
  })
})
