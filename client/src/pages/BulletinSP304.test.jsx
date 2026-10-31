// SP-304: "This week's services" must show weekday solemnity feast labels
// (All Souls on Nov 2), even when the calendar row's feast_name is blank.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { LocaleProvider } from '../i18n'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import Bulletin, { feastLabelForService, formatServiceTitle } from './Bulletin'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Admin', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 't', loading: false,
  }),
}))

const ok = (b) => ({ ok: true, status: 200, json: async () => b })

describe('SP-304 feast helpers', () => {
  it('prefers the event feast_name, else the liturgical map', () => {
    expect(feastLabelForService({ date: '2026-11-02', feast_name: 'All Souls' }, {})).toBe('All Souls')
    expect(feastLabelForService(
      { date: '2026-11-02', feast_name: null, title: '[Sample] Sunday Mass' },
      { '2026-11-02': { feast_name: 'All Souls' } },
    )).toBe('All Souls')
    expect(feastLabelForService({ date: '2026-11-03', title: 'Daily Mass' }, { '2026-11-03': { feast_name: null } })).toBe('')
  })

  it('appends the feast once, and skips when the title already names it', () => {
    const lit = { '2026-11-02': { feast_name: 'All Souls' } }
    expect(formatServiceTitle({ date: '2026-11-02', title: '[Sample] Sunday Mass' }, lit))
      .toBe('[Sample] Sunday Mass · All Souls')
    expect(formatServiceTitle({ date: '2026-11-02', title: 'All Souls Mass', feast_name: 'All Souls' }, {}))
      .toBe('All Souls Mass')
  })
})

describe('SP-304 bulletin week services show All Souls', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    try { localStorage.removeItem('ochr_locale') } catch { /* jsdom */ }
  })

  it('labels the Nov 2 sample Mass with All Souls from the liturgical range', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      if (u.includes('/api/bulletins')) return ok({ bulletins: [] })
      if (u.includes('/api/organization')) return ok({ name: 'St Test', slug: 'st-test' })
      if (u.includes('/api/liturgical/range')) {
        return ok({
          '2026-11-01': { feast_name: 'All Saints', season: 'Ordinary Time', color: 'White' },
          '2026-11-02': { feast_name: 'All Souls', season: 'Ordinary Time', color: 'Purple' },
        })
      }
      if (u.includes('/api/liturgical')) {
        return ok({ feast_name: 'All Saints', season: 'Ordinary Time', color: 'White' })
      }
      if (u.includes('/api/calendar')) {
        return ok([
          { id: 55, date: '2026-11-01', start_time: '10:00', title: 'Saint test - Sunday Mass 10:00', feast_name: 'All Saints' },
          { id: 14, date: '2026-11-02', start_time: '10:00', title: '[Sample] Sunday Mass', feast_name: null },
        ])
      }
      if (u.includes('/api/service-plans')) return ok({ plans: [] })
      return ok({})
    }))

    render(
      <MemoryRouter>
        <LocaleProvider>
          <ToastProvider>
            <ConfirmProvider>
              <Bulletin />
            </ConfirmProvider>
          </ToastProvider>
        </LocaleProvider>
      </MemoryRouter>,
    )

    // Drive the editor onto All Saints Sunday so the Sat–Fri week includes Nov 2.
    const dateInput = await screen.findByLabelText(/bulletin date|fecha del boletín/i)
    dateInput.focus()
    // Bulletin date state is controlled; fire change to Nov 1.
    fireEvent.change(dateInput, { target: { value: '2026-11-01' } })

    await waitFor(() => {
      const lines = screen.getAllByTestId('bul-week-service').map(el => el.textContent)
      expect(lines.some(t => /All Souls/i.test(t) && /Sample.*Sunday Mass/i.test(t))).toBe(true)
    })
  })
})


describe('TARS #476 stale feast map after failed range', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    try { localStorage.removeItem('ochr_locale') } catch { /* jsdom */ }
  })

  it('clears the prior map when a later range is refused (UNKNOWN ≠ prior week)', async () => {
    let rangeCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      if (u.includes('/api/liturgical/range')) {
        rangeCalls += 1
        if (rangeCalls === 1) {
          return ok({
            '2026-11-01': { feast_name: 'All Saints', season: 'Ordinary Time', color: 'White' },
            '2026-11-02': { feast_name: 'All Souls', season: 'Ordinary Time', color: 'Purple' },
          })
        }
        return { ok: false, status: 500, json: async () => ({ error: 'fail' }) }
      }
      if (u.includes('/api/bulletins')) return ok({ bulletins: [] })
      if (u.includes('/api/organization')) return ok({ name: 'St Test', slug: 'st-test' })
      if (u.includes('/api/liturgical')) {
        return ok({ feast_name: 'All Saints', season: 'Ordinary Time', color: 'White' })
      }
      if (u.includes('/api/calendar')) {
        return ok([
          { id: 14, date: '2026-11-02', start_time: '10:00', title: '[Sample] Sunday Mass', feast_name: null },
        ])
      }
      if (u.includes('/api/service-plans')) return ok({ plans: [] })
      return ok({})
    }))

    render(
      <MemoryRouter>
        <LocaleProvider>
          <ToastProvider>
            <ConfirmProvider>
              <Bulletin />
            </ConfirmProvider>
          </ToastProvider>
        </LocaleProvider>
      </MemoryRouter>,
    )

    const dateInput = await screen.findByLabelText(/bulletin date|fecha del boletín/i)
    fireEvent.change(dateInput, { target: { value: '2026-11-01' } })

    await waitFor(() => {
      const lines = screen.getAllByTestId('bul-week-service').map(el => el.textContent)
      expect(lines.some(t => /All Souls/i.test(t))).toBe(true)
    })

    fireEvent.change(dateInput, { target: { value: '2026-11-08' } })

    await waitFor(() => expect(rangeCalls).toBeGreaterThanOrEqual(2))
    await waitFor(() => {
      // Failed range → UNKNOWN (null map). Stale All Souls must not remain.
      const lines = screen.queryAllByTestId('bul-week-service').map(el => el.textContent)
      expect(lines.every(t => !/All Souls/i.test(t))).toBe(true)
    })
  })
})
