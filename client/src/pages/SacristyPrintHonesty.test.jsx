// OC-READY-01-021 / STMT-01 residual — Sacristy and weekly print surfaces
// must not read as if OpenChurch emailed the sheet. Reality is
// window.print() / "Save as PDF" only. Removing the honesty string goes red.
// Honesty is print:hidden. The paper footer is a generation stamp, not a
// claim that the sheet was sent.

import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import SacristySheet from './SacristySheet'
import SundayPacket from './SundayPacket'
import MassIntentions from './MassIntentions'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const ok = (body) => ({ ok: true, status: 200, json: async () => body })

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    if (u.includes('/api/liturgical')) return ok({ season: 'ordinary', color: 'green' })
    if (u.includes('/api/mass-intentions/nearest-outside')) {
      return ok({ date: null, undated_waiting: false, undated_waiting_count: 0 })
    }
    if (u.includes('/api/mass-intentions/weekly')) return ok({ intentions: [] })
    if (u.includes('/api/mass-intentions')) return ok({ intentions: [] })
    if (u.includes('/api/packet')) {
      return ok({
        parish: 'St Test',
        date: '2026-09-13',
        plan: { title: 'Sunday Mass', elements: [] },
        serving: [],
        intentions: [],
        bulletin: null,
        lectionary: null,
        liturgical: null,
      })
    }
    if (u.includes('/api/clients')) return ok([])
    if (u.includes('/api/groups')) return ok({ groups: [] })
    return ok({})
  }))
}

function wrap(node, path, routePath) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <LocaleProvider>
        <ToastProvider>
          <ConfirmProvider>
            <Routes>
              <Route path={routePath} element={node} />
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
})

describe('Sacristy sheet print≠emailed honesty (OC-READY-01-021)', () => {
  it('THE SHEET SAYS PRINT/PDF ONLY — OPENCHURCH DOES NOT EMAIL', async () => {
    stubFetch()
    wrap(<SacristySheet />, '/mass-intentions/print?start=2026-09-13', '/mass-intentions/print')
    const honesty = await screen.findByTestId('sheet-print-not-emailed', {}, { timeout: 4000 })
    expect(honesty.textContent).toMatch(/does not email/i)
    expect(honesty.textContent).toMatch(/print or save as PDF/i)
    expect(honesty.textContent).not.toMatch(/sent successfully|email sent|delivered/i)
    expect(honesty.className).toMatch(/print:hidden/)
  })

  it('PAPER FOOTER IS A GENERATION STAMP — NOT A SENT CLAIM', async () => {
    stubFetch()
    wrap(<SacristySheet />, '/mass-intentions/print?start=2026-09-13', '/mass-intentions/print')
    const honesty = await screen.findByTestId('sheet-print-not-emailed', {}, { timeout: 4000 })
    expect(honesty.className).toMatch(/print:hidden/)
    const footer = await screen.findByTestId('sheet-generation-stamp', {}, { timeout: 4000 })
    expect(footer.textContent).toMatch(/^Generated /)
    expect(footer.textContent).not.toMatch(/\bPrinted\b/)
    expect(footer.textContent).not.toMatch(/\b(issued|emailed|archived|sent|delivered)\b/i)
    expect(footer.className).not.toMatch(/print:hidden/)
  })

  it('SPANISH SHEET CHROME SAYS NO LA ENVÍA POR CORREO', async () => {
    localStorage.setItem('ochr_locale', 'es')
    stubFetch()
    wrap(<SacristySheet />, '/mass-intentions/print?start=2026-09-13', '/mass-intentions/print')
    const honesty = await screen.findByTestId('sheet-print-not-emailed', {}, { timeout: 4000 })
    expect(honesty.textContent).toMatch(/no la envía por correo/i)
    expect(honesty.className).toMatch(/print:hidden/)
    localStorage.removeItem('ochr_locale')
  })
})

describe('Mass Intentions weekly-sheet hop print≠emailed honesty', () => {
  it('THE HOP SAYS PRINT/PDF ONLY — OPENCHURCH DOES NOT EMAIL', async () => {
    stubFetch()
    wrap(<MassIntentions />, '/mass-intentions', '/mass-intentions')
    const honesty = await screen.findByTestId('weekly-sheet-not-emailed', {}, { timeout: 4000 })
    expect(honesty.textContent).toMatch(/does not email/i)
    expect(honesty.textContent).toMatch(/print or PDF/i)
    expect(screen.getByRole('link', { name: /weekly sheet/i }).getAttribute('href')).toBe('/mass-intentions/print')
  })

  it('SPANISH HOP SAYS NO LA ENVÍA POR CORREO', async () => {
    localStorage.setItem('ochr_locale', 'es')
    stubFetch()
    wrap(<MassIntentions />, '/mass-intentions', '/mass-intentions')
    const honesty = await screen.findByTestId('weekly-sheet-not-emailed', {}, { timeout: 4000 })
    expect(honesty.textContent).toMatch(/no la envía por correo/i)
    localStorage.removeItem('ochr_locale')
  })
})

describe('Sunday Packet print≠emailed honesty', () => {
  it('THE PACKET SAYS PRINT/PDF ONLY — OPENCHURCH DOES NOT EMAIL', async () => {
    stubFetch()
    wrap(<SundayPacket />, '/packet?date=2026-09-13&from=schedule', '/packet')
    const honesty = await screen.findByTestId('packet-print-not-emailed', {}, { timeout: 4000 })
    expect(honesty.textContent).toMatch(/does not email/i)
    expect(honesty.textContent).toMatch(/print or save as PDF/i)
    expect(honesty.textContent).not.toMatch(/sent successfully|email sent|delivered/i)
    expect(honesty.className).toMatch(/print:hidden/)
  })

  it('PACKET PAPER STAYS A LIVE PRINT MARKER — NOT A SENT CLAIM', async () => {
    stubFetch()
    wrap(<SundayPacket />, '/packet?date=2026-09-13&from=schedule', '/packet')
    const honesty = await screen.findByTestId('packet-print-not-emailed', {}, { timeout: 4000 })
    expect(honesty.className).toMatch(/print:hidden/)
    const footer = await screen.findByText(/Printed from the live schedule/i)
    expect(footer.textContent).not.toMatch(/sent|emailed|delivered/i)
    expect(screen.getByText(/A live print of this Sunday/i)).toBeInTheDocument()
  })

  it('SPANISH PACKET CHROME SAYS NO LO ENVÍA POR CORREO', async () => {
    localStorage.setItem('ochr_locale', 'es')
    stubFetch()
    wrap(<SundayPacket />, '/packet?date=2026-09-13&from=schedule', '/packet')
    const honesty = await screen.findByTestId('packet-print-not-emailed', {}, { timeout: 4000 })
    expect(honesty.textContent).toMatch(/no lo envía por correo/i)
    expect(honesty.className).toMatch(/print:hidden/)
    localStorage.removeItem('ochr_locale')
  })
})
