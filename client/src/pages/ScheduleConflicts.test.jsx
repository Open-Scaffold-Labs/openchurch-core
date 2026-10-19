// A Monday stored as 2026-09-28 used to render as "Sun, Sep 27" under
// "Week of Sep 20" in US browsers: new Date('2026-09-28') is UTC
// midnight, Sunday evening in Los Angeles and New York, and weekDate
// then shifted that Monday key back another day. The parent spawns
// this file under three timezones. Node reads TZ at process start.

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { LocaleProvider } from '../i18n'
import ScheduleConflicts, { fmtDate, weekDate, weekStartOf } from './ScheduleConflicts'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const ZONES = ['America/Los_Angeles', 'America/New_York', 'Pacific/Auckland']
const MONDAY = '2026-09-28'
const SUNDAY = '2026-09-27'
const CLIENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')

const ok = (body) => ({ ok: true, status: 200, json: async () => body })

function conflict(date, title) {
  return {
    date,
    members: [{ id: 1, name: 'Ada' }],
    events: [{ id: title.length, title, start_time: '10:00', end_time: '11:00' }],
  }
}

if (process.env.CONFLICT_ZONE_CHILD === '1') {
  beforeEach(() => { vi.unstubAllGlobals() })

  describe(`schedule conflicts in ${process.env.TZ}`, () => {
    it('keeps Monday 9/28 on its own civil day and week', async () => {
      expect(fmtDate(MONDAY)).toBe('Mon, Sep 28')
      expect(fmtDate(`${MONDAY}T00:00:00.000Z`)).toBe('Mon, Sep 28')
      expect(weekStartOf(MONDAY)).toBe(MONDAY)
      expect(weekStartOf(SUNDAY)).toBe('2026-09-21')
      expect(weekDate(MONDAY)).toBe('Sep 28')
      expect(weekDate('2026-09-21')).toBe('Sep 21')

      vi.stubGlobal('fetch', vi.fn(async () => ok({
        conflicts: [conflict(MONDAY, 'Monday Mass'), conflict(SUNDAY, 'Sunday Mass')],
      })))
      render(
        <MemoryRouter>
          <LocaleProvider>
            <ScheduleConflicts />
          </LocaleProvider>
        </MemoryRouter>,
      )
      expect(await screen.findByText('Mon, Sep 28')).toBeTruthy()
      expect(screen.getByText('Sun, Sep 27')).toBeTruthy()
      expect(screen.getByText('Week of Sep 28 · 1 conflict')).toBeTruthy()
      expect(screen.getByText('Week of Sep 21 · 1 conflict')).toBeTruthy()
      expect(screen.queryByText('Week of Sep 20 · 1 conflict')).toBeNull()
    })
  })
} else {
  describe('schedule conflicts across browser timezones', () => {
    it('shows Monday 9/28 under its own week in LA, NY, and Auckland', () => {
      const vitestBin = join(CLIENT_ROOT, 'node_modules/vitest/vitest.mjs')
      for (const tz of ZONES) {
        const r = spawnSync(process.execPath, [
          vitestBin, 'run', 'src/pages/ScheduleConflicts.test.jsx', '--reporter=dot',
        ], {
          cwd: CLIENT_ROOT,
          env: { ...process.env, TZ: tz, CONFLICT_ZONE_CHILD: '1' },
          encoding: 'utf8',
          timeout: 180_000,
        })
        const out = `${r.stdout || ''}\n${r.stderr || ''}`
        expect(r.status, `TZ=${tz}\n${out}`).toBe(0)
      }
    }, 180_000)
  })
}
