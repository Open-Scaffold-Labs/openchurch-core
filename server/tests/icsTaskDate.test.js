// An all-day task due on a DATE must stay that civil day in the ICS feed.
// new Date('YYYY-MM-DD') is UTC midnight, which ical-generator writes as
// VALUE=DATE of that day. Parsing the same string at local midnight shifts
// the date east of UTC (Auckland prints the previous day).

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { generateICS } from '../src/routes/calendarSync.js'

const ZONES = ['UTC', 'America/Los_Angeles', 'Pacific/Auckland']
const HERE = fileURLToPath(import.meta.url)

function taskIcs(due) {
  return generateICS(
    { name: 'Member' },
    [{ title: 'Prepare the books', description: '', due_date: due }],
    [],
    [],
  )
}

if (process.env.ICS_ZONE_CHILD === '1') {
  describe(`ICS task date in ${process.env.TZ}`, () => {
    it('writes DTSTART as the stored civil day', () => {
      const ics = taskIcs('2026-09-27')
      expect(ics).toMatch(/DTSTART;VALUE=DATE:20260927/)
      expect(ics).not.toMatch(/20260926/)
    })
  })
} else {
  describe('ICS task dates across process timezones', () => {
    it('keeps 2026-09-27 in UTC, Los Angeles, and Auckland', () => {
      for (const tz of ZONES) {
        const r = spawnSync(process.execPath, [
          join(dirname(HERE), '../node_modules/vitest/vitest.mjs'),
          'run', 'tests/icsTaskDate.test.js', '--reporter=dot',
        ], {
          cwd: join(dirname(HERE), '..'),
          env: { ...process.env, TZ: tz, ICS_ZONE_CHILD: '1' },
          encoding: 'utf8',
          timeout: 120_000,
        })
        const out = `${r.stdout || ''}\n${r.stderr || ''}`
        expect(r.status, `TZ=${tz}\n${out}`).toBe(0)
      }
    }, 120_000)
  })
}
