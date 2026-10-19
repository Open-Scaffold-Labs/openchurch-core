// Golden Journey 1 — Mass Intention → Sacristy List → print
// (OC-EXPERIENCE-OS-001 Part C).
//
// One hop: /mass-intentions → /mass-intentions/print (no start) →
// vigil week → window.print(). No Share API. EN+ES sheet chrome.
//
// Verify:
//   cd client && npm test -- src/pages/GoldenJourney1.test.jsx
// Both journeys:
//   cd client && npm run test:golden
//
// Mutate any one of these and the matching test goes red:
//   1. Weekly-sheet hop gains a start query or leaves /mass-intentions/print
//   2. Missing start defaults to today+6 or a Sunday-started week instead of the vigil week
//   3. Print no longer calls window.print()
//   4. Sheet dumps an out-of-window book row onto the printed week
//   5. EN/ES printHonesty / Print label leave the sheet chrome

import { ToastProvider } from '../components/ToastProvider'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import MassIntentions from './MassIntentions'
import SacristySheet from './SacristySheet'
import {
  GJ1_AUTH_USER,
  GJ1_DISPLAY_INTENTION,
  GJ1_NOW,
  GJ1_OUTSIDE,
  GJ1_WEEK_END,
  GJ1_WEEK_START,
  queryEnd,
  queryStart,
  stubGoldenJourney1Fetch,
} from './goldenJourney1.fixture.js'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: GJ1_AUTH_USER,
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

function renderJourney() {
  return render(
    <MemoryRouter initialEntries={['/mass-intentions']}>
      <LocaleProvider>
        <Routes>
          <Route path="/mass-intentions" element={<ToastProvider><MassIntentions /></ToastProvider>} />
          <Route path="/mass-intentions/print" element={<SacristySheet />} />
        </Routes>
      </LocaleProvider>
    </MemoryRouter>,
  )
}

function weeklyCalls() {
  return vi.mocked(fetch).mock.calls
    .map(c => String(c[0]))
    .filter(u => u.includes('/api/mass-intentions/weekly'))
}

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.removeItem('ochr_locale')
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(GJ1_NOW)
  stubGoldenJourney1Fetch(vi)
})

afterEach(() => {
  localStorage.removeItem('ochr_locale')
  vi.useRealTimers()
})

describe('Golden Journey 1 — book → sacristy sheet → print', () => {
  it('EN: hop without start, vigil week, printHonesty, window.print()', async () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => {})
    renderJourney()

    expect(await screen.findByRole('heading', { name: /^mass intentions$/i })).toBeInTheDocument()
    expect(await screen.findByText(GJ1_DISPLAY_INTENTION)).toBeInTheDocument()
    expect(screen.getByText('OUT-OF-WINDOW SAMPLE')).toBeInTheDocument()
    expect(screen.getByText('Sample requester')).toBeInTheDocument()
    expect(screen.getByText('Outside requester')).toBeInTheDocument()
    expect(screen.getByText('$10.00')).toBeInTheDocument()

    const hop = screen.getByRole('link', { name: /weekly sheet/i })
    expect(hop.getAttribute('href')).toBe('/mass-intentions/print')
    expect(hop.getAttribute('href')).not.toMatch(/start=/)
    expect(screen.getByTestId('weekly-sheet-not-emailed').textContent).toMatch(/does not email/i)
    expect(screen.getByTestId('weekly-sheet-not-emailed').textContent).toMatch(/print or PDF/i)
    expect(screen.queryByRole('button', { name: /share/i })).toBeNull()

    fireEvent.click(hop)

    expect(await screen.findByText('Mass Intentions for the Week')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /^intentions$/i })).toHaveAttribute('href', '/mass-intentions')
    expect(screen.getByText(GJ1_DISPLAY_INTENTION)).toBeInTheDocument()
    expect(screen.getByText(/requested by Sample requester/i)).toBeInTheDocument()
    expect(screen.getByText('$10.00')).toBeInTheDocument()
    expect(screen.queryByText('OUT-OF-WINDOW SAMPLE')).not.toBeInTheDocument()
    expect(screen.queryByText('Outside requester')).not.toBeInTheDocument()

    await waitFor(() => {
      const weekly = weeklyCalls()
      expect(weekly.some(u => queryStart(u) === GJ1_WEEK_START && queryEnd(u) === GJ1_WEEK_END)).toBe(true)
      expect(weekly.some(u => queryStart(u) === '2026-09-16')).toBe(false)
    })

    const honesty = screen.getByTestId('sheet-print-not-emailed')
    expect(honesty.textContent).toMatch(/print or save as PDF only/i)
    expect(honesty.textContent).toMatch(/does not email/i)
    expect(honesty.className).toMatch(/print:hidden/)
    expect(screen.queryByRole('button', { name: /share/i })).toBeNull()
    expect(typeof navigator.share).not.toBe('function')

    expect(screen.getByRole('button', { name: STRINGS.en['sheet.prevWeek'] })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: STRINGS.en['sheet.nextWeek'] })).toBeInTheDocument()

    const printBtn = screen.getByRole('button', { name: /^print$/i })
    fireEvent.click(printBtn)
    expect(print).toHaveBeenCalledTimes(1)
    print.mockRestore()
  })

  it('ES: same hop, vigil week, Imprimir → window.print(), no la envía', async () => {
    localStorage.setItem('ochr_locale', 'es')
    const print = vi.spyOn(window, 'print').mockImplementation(() => {})
    renderJourney()

    expect(await screen.findByRole('heading', { name: /^intenciones de misa$/i })).toBeInTheDocument()
    expect(await screen.findByText(GJ1_DISPLAY_INTENTION)).toBeInTheDocument()

    const hop = screen.getByRole('link', { name: /hoja semanal/i })
    expect(hop.getAttribute('href')).toBe('/mass-intentions/print')
    expect(screen.getByTestId('weekly-sheet-not-emailed').textContent).toMatch(/no la envía por correo/i)

    fireEvent.click(hop)

    expect(await screen.findByText('Intenciones de Misa para la Semana')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /^intenciones$/i })).toHaveAttribute('href', '/mass-intentions')
    expect(screen.getByText(GJ1_DISPLAY_INTENTION)).toBeInTheDocument()
    expect(screen.getByText(/solicitada por Sample requester/i)).toBeInTheDocument()
    expect(screen.queryByText(GJ1_OUTSIDE.formatted_intention)).not.toBeInTheDocument()

    await waitFor(() => {
      const weekly = weeklyCalls()
      expect(weekly.some(u => queryStart(u) === GJ1_WEEK_START && queryEnd(u) === GJ1_WEEK_END)).toBe(true)
    })

    const honesty = screen.getByTestId('sheet-print-not-emailed')
    expect(honesty.textContent).toMatch(/no la envía por correo/i)
    expect(honesty.className).toMatch(/print:hidden/)

    expect(screen.getByRole('button', { name: STRINGS.es['sheet.prevWeek'] })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: STRINGS.es['sheet.nextWeek'] })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: STRINGS.en['sheet.prevWeek'] })).toBeNull()
    expect(screen.queryByRole('button', { name: STRINGS.en['sheet.nextWeek'] })).toBeNull()

    const printBtn = screen.getByRole('button', { name: /^imprimir$/i })
    fireEvent.click(printBtn)
    expect(print).toHaveBeenCalledTimes(1)
    print.mockRestore()
  })
})
