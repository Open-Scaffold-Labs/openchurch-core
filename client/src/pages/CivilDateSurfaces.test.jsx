// Events, Tasks, and Schedule must show the stored civil day in any
// browser timezone. A Sunday stored as 2026-09-27 used to render as
// Sat 9/26 in US browsers because formatLocalDate / new Date() treated
// the UTC-midnight ISO of a DATE as an instant.
//
// The parent test spawns this file under three TZs. Node reads TZ at
// process start, so a single vitest process cannot cover all three.

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { LocaleProvider } from '../i18n'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import { formatLocalDate, parseCivilDay, parseStoredDate } from '../utils/dates'
import Events from './Events'
import Schedule from './Schedule'
import InvoicePrint from './InvoicePrint'
import { dueLabelFor, splitEventsByDay } from './Dashboard'
import { LinkedEvents } from './Tasks'

const ZONES = ['America/Los_Angeles', 'America/New_York', 'Pacific/Auckland']
const DAY = '2026-09-27'
const ISO = '2026-09-27T00:00:00.000Z'
const SHOWN = '9/27/2026'
const CLIENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const ok = (body) => ({ ok: true, status: 200, json: async () => body })

function Shell({ children }) {
  return (
    <MemoryRouter>
      <LocaleProvider>
        <ToastProvider>
          <ConfirmProvider>{children}</ConfirmProvider>
        </ToastProvider>
      </LocaleProvider>
    </MemoryRouter>
  )
}

function eventRow(date) {
  return {
    id: 41, title: 'Sunday Parish Event', service_division: 'Worship',
    date, time: '10:00', location: 'Nave', liturgical_season: null,
    liturgical_color: null, feast_name: null, assigned_members: [],
  }
}

const mass = (date) => ({
  id: 77, title: 'Sunday Mass ARG', date,
  start_time: '10:00', end_time: '11:00', type: 'service', assigned_to: [],
})

if (process.env.CIVIL_DATE_ZONE_CHILD === '1') {
  beforeEach(() => { vi.unstubAllGlobals() })

  describe(`civil day rendered in ${process.env.TZ}`, () => {
    it('keeps a real timestamp on its local instant', () => {
      // 23:30Z is still the 27th in the US and already the 28th in Auckland.
      // Stripping every ISO string to its prefix would erase that.
      const shown = formatLocalDate('2026-09-27T23:30:00.000Z')
      if (process.env.TZ === 'Pacific/Auckland') expect(shown).toBe('Sep 28, 2026')
      else expect(shown).toBe('Sep 27, 2026')
      expect(parseCivilDay('2026-09-27T23:30:00.000Z')).toBeNull()
    })

    it('keeps exact-midnight UTC as an instant unless it is a stored DATE', () => {
      // created_at backfilled at midnight Z is the previous evening in LA
      // and NY. A DATE column uses parseStoredDate and stays the 27th.
      const shown = formatLocalDate('2026-09-27T00:00:00.000Z')
      if (process.env.TZ === 'Pacific/Auckland') expect(shown).toBe('Sep 27, 2026')
      else expect(shown).toBe('Sep 26, 2026')
      expect(parseCivilDay(ISO)).toBeNull()
      expect(parseCivilDay('2026-02-29')).toBeNull()
      const stored = parseStoredDate(ISO)
      expect(stored.getFullYear()).toBe(2026)
      expect(stored.getMonth()).toBe(8)
      expect(stored.getDate()).toBe(27)
    })

    const localAfternoon = new Date(2026, 8, 27, 15, 0, 0)

    it('Dashboard due label is the stored civil day', () => {
      for (const date of [DAY, ISO]) {
        expect(dueLabelFor(date, localAfternoon).text).toBe('Due today')
      }
    })

    it('Dashboard upcoming/past split keeps the stored civil day upcoming', () => {
      for (const date of [DAY, ISO]) {
        const { upcoming, past } = splitEventsByDay([{ id: 1, date }], localAfternoon)
        expect(upcoming.map(e => e.id)).toEqual([1])
        expect(past).toEqual([])
      }
    })

    for (const date of [DAY, ISO]) {
      it(`Events shows ${SHOWN} for ${date}`, async () => {
        vi.stubGlobal('fetch', vi.fn(async (url) => {
          const u = String(url)
          if (u.includes('/api/events')) return ok([eventRow(date)])
          if (u.includes('/api/clients')) return ok([])
          return ok([])
        }))
        render(<Shell><Events /></Shell>)
        expect(await screen.findByText(SHOWN)).toBeTruthy()
        expect(screen.queryByText('9/26/2026')).toBeNull()
      })

      it(`Tasks shows ${SHOWN} for ${date}`, async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ok([
          { id: 9, title: 'Sunday Mass ARG', date, time: '10:00', service_division: 'Worship', location: '' },
        ])))
        render(
          <LocaleProvider>
            <LinkedEvents taskId="task-1" assignedMemberId={4} />
          </LocaleProvider>,
        )
        expect(await screen.findByText(new RegExp(SHOWN.replaceAll('/', '\\/')))).toBeTruthy()
        expect(screen.queryByText(/9\/26\/2026/)).toBeNull()
      })

      it(`Schedule opens ${date} on the stored Sunday`, async () => {
        const row = mass(date)
        vi.stubGlobal('fetch', vi.fn(async (url) => {
          const u = String(url)
          if (u.includes('/api/calendar/conflicts')) return ok({ conflicts: [] })
          if (/\/api\/calendar\/\d+/.test(u)) return ok(row)
          if (u.includes('/api/calendar')) return ok([row])
          if (u.includes('/api/liturgical/range')) return ok({})
          if (u.includes('/api/liturgical')) return ok({ season: 'Ordinary Time', color: 'Green' })
          if (u.includes('/api/mass-intentions')) return ok({ intentions: [] })
          if (u.includes('/api/clients')) return ok([])
          if (u.includes('/api/groups')) return ok({ groups: [] })
          if (u.includes('/api/invoices')) return ok([])
          if (u.includes('/api/availability')) return ok({ unavailability: [] })
          return ok({})
        }))
        render(
          <MemoryRouter initialEntries={['/schedule?event=77']}>
            <LocaleProvider>
              <ToastProvider>
                <ConfirmProvider>
                  <Routes>
                    <Route path="/schedule" element={<Schedule />} />
                  </Routes>
                </ConfirmProvider>
              </ToastProvider>
            </LocaleProvider>
          </MemoryRouter>,
        )
        expect(await screen.findByDisplayValue(DAY)).toBeTruthy()
        expect((await screen.findAllByText('Sunday Mass ARG')).length).toBeGreaterThan(0)
        await waitFor(() => {
          const sun = screen.getAllByRole('button').find(b => b.textContent.includes('Sun') && b.textContent.includes('27'))
          expect(sun, 'Sunday the 27th must be the open day').toBeTruthy()
          expect(sun.className).toMatch(/bg-church-900/)
        })
      })

      it(`InvoicePrint shows September 27, 2026 for event_date ${date}`, async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ok({
          id: 3, title: 'Funeral offering', invoice_no: 'OFF-3',
          issued_at: '2026-09-27T23:30:00.000Z',
          created_at: '2026-09-27T23:30:00.000Z',
          payer_name: 'The Family',
          event_title: 'Sunday Mass ARG',
          event_date: date,
          total: '100.00', amount_paid: '0', waived_amount: '0', subtotal: '100.00',
          status: 'issued',
          lines: [{ id: 1, description: 'Offering', qty: 1, amount: '100.00' }],
          payments: [],
        })))
        render(
          <MemoryRouter initialEntries={['/offerings/3/print']}>
            <LocaleProvider>
              <ToastProvider>
                <ConfirmProvider>
                  <Routes>
                    <Route path="/offerings/:id/print" element={<InvoicePrint />} />
                  </Routes>
                </ConfirmProvider>
              </ToastProvider>
            </LocaleProvider>
          </MemoryRouter>,
        )
        expect(await screen.findByText(/Sunday Mass ARG, September 27, 2026/)).toBeTruthy()
        expect(screen.queryByText(/September 26, 2026/)).toBeNull()
      })
    }
  })
} else {
  describe('civil day across browser timezones', () => {
    it('renders Events, Tasks, Schedule, InvoicePrint, and Dashboard in LA, NY, and Auckland', () => {
      const vitestBin = join(CLIENT_ROOT, 'node_modules/vitest/vitest.mjs')
      for (const tz of ZONES) {
        const r = spawnSync(process.execPath, [
          vitestBin, 'run', 'src/pages/CivilDateSurfaces.test.jsx', '--reporter=dot',
        ], {
          cwd: CLIENT_ROOT,
          env: { ...process.env, TZ: tz, CIVIL_DATE_ZONE_CHILD: '1' },
          encoding: 'utf8',
          timeout: 180_000,
        })
        const out = `${r.stdout || ''}\n${r.stderr || ''}`
        expect(r.status, `TZ=${tz}\n${out}`).toBe(0)
      }
    }, 180_000)
  })
}
