// Days since last contact are civil days in the parish timezone.
// UTC "today" is the previous evening in Los Angeles at 04:17Z, so a
// contact dated 2026-09-26 is 0 days in LA and 1 day in Auckland.
// The count must not move when the process TZ changes.

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { careStatusFor, QUIET_PERIOD_DAYS } from '../src/diocese/careStatus.js'
import { daysSinceCivilDay } from '../src/utils/civilDay.js'

const ZONES = ['UTC', 'America/Los_Angeles', 'Pacific/Auckland']
const LA = 'America/Los_Angeles'
const AKL = 'Pacific/Auckland'
const LA_EDGE = new Date('2026-09-27T04:17:00.000Z')
const AUCKLAND_10 = new Date('2026-09-26T21:00:00.000Z')
const HERE = fileURLToPath(import.meta.url)

function expectCareDays() {
  expect(daysSinceCivilDay('2026-09-26', LA_EDGE, LA)).toBe(0)
  expect(daysSinceCivilDay('2026-09-27', LA_EDGE, LA)).toBe(-1)
  expect(daysSinceCivilDay('2026-09-27', LA_EDGE, AKL)).toBe(0)
  expect(daysSinceCivilDay('2026-09-26', LA_EDGE, AKL)).toBe(1)
  expect(daysSinceCivilDay('2026-09-26', AUCKLAND_10, AKL)).toBe(1)
  expect(daysSinceCivilDay('2026-09-26', AUCKLAND_10, LA)).toBe(0)
  expect(daysSinceCivilDay('2026-09-26', LA_EDGE, '')).toBe(1)
  expect(daysSinceCivilDay('2026-09-26', LA_EDGE, 'Not/AZone')).toBe(1)
  expect(daysSinceCivilDay(null, LA_EDGE, LA)).toBeNull()
  expect(daysSinceCivilDay('2026-09-27', new Date('2026-09-27T07:00:00.000Z'), LA)).toBe(0)
  expect(daysSinceCivilDay('2026-09-27', new Date('2026-09-27T06:59:59.000Z'), LA)).toBe(-1)
}

// 100 civil days before the UTC date 2026-09-27. Date-only, so the
// process timezone cannot move the contact day.
function utcDaysBefore(iso, days) {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d) - days * 86400000)
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(dt.getUTCDate()).padStart(2, '0')
  return `${dt.getUTCFullYear()}-${mm}-${dd}`
}

// The only quiet threshold is 100 org-local days: ready, then
// awaiting_update. At 04:17Z a contact 100 UTC days back is still
// 99 days in Los Angeles, so that cue must not flip yet.
function expectQuietLine() {
  expect(QUIET_PERIOD_DAYS).toBe(100)
  const contact = utcDaysBefore('2026-09-27', QUIET_PERIOD_DAYS)
  expect(contact).toBe('2026-06-19')
  const laDays = daysSinceCivilDay(contact, LA_EDGE, LA)
  const utcDays = daysSinceCivilDay(contact, LA_EDGE, 'UTC')
  const aklDays = daysSinceCivilDay(contact, LA_EDGE, AKL)
  const fallbackDays = daysSinceCivilDay(contact, LA_EDGE, '')
  expect(careStatusFor({ daysSinceLastContact: laDays }).key).toBe('ready')
  expect(laDays).toBe(99)
  expect(utcDays).toBe(100)
  expect(aklDays).toBe(100)
  expect(fallbackDays).toBe(100)
  expect(careStatusFor({ daysSinceLastContact: 99 }).key).toBe('ready')
  expect(careStatusFor({ daysSinceLastContact: 100 }).key).toBe('awaiting_update')
  expect(careStatusFor({ daysSinceLastContact: utcDays }).key).toBe('awaiting_update')
  expect(careStatusFor({ daysSinceLastContact: aklDays }).key).toBe('awaiting_update')
  expect(careStatusFor({ daysSinceLastContact: fallbackDays }).key).toBe('awaiting_update')
}

if (process.env.CARE_DAYS_ZONE_CHILD === '1') {
  describe(`care days since contact in ${process.env.TZ}`, () => {
    it('counts civil days in the parish timezone', () => {
      expectCareDays()
    })
    it('does not flip the 100-day cue on a 99-day Los Angeles count', () => {
      expectQuietLine()
    })
  })
} else {
  describe('care days since contact across process timezones', () => {
    it('agrees in UTC, Los Angeles, and Auckland', () => {
      for (const tz of ZONES) {
        const r = spawnSync(process.execPath, [
          join(dirname(HERE), '../node_modules/vitest/vitest.mjs'),
          'run', 'tests/careDaysSince.test.js', '--reporter=dot',
        ], {
          cwd: join(dirname(HERE), '..'),
          env: { ...process.env, TZ: tz, CARE_DAYS_ZONE_CHILD: '1' },
          encoding: 'utf8',
          timeout: 120_000,
        })
        const out = `${r.stdout || ''}\n${r.stderr || ''}`
        expect(r.status, `TZ=${tz}\n${out}`).toBe(0)
      }
    }, 120_000)
  })
}
