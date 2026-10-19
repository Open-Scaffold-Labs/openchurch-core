// An undated gift stores the parish's civil day. At 2026-09-28T06:30:00Z
// Los Angeles is still 2026-09-27 and Auckland is 2026-09-28. Node reads
// TZ at startup, and Postgres CURRENT_DATE follows the session TimeZone,
// so each pair is a child process with both pinned. The expected days
// are literals: they do not follow either clock.

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const PROCESS_ZONES = ['UTC', 'America/Los_Angeles', 'Pacific/Auckland']
const SESSION_ZONES = ['UTC', 'America/Los_Angeles', 'Pacific/Auckland']
const probe = join(dirname(fileURLToPath(import.meta.url)), 'undatedDonationDate.probe.mjs')

describe('undated donation date is the parish civil day', () => {
  for (const tz of PROCESS_ZONES) {
    for (const session of SESSION_ZONES) {
      it(`LA 2026-09-27 and Auckland 2026-09-28 at 06:30Z under TZ=${tz} session=${session}`, () => {
        expect(process.env.DATABASE_URL, 'DATABASE_URL must be set to the local database').toBeTruthy()
        const r = spawnSync(process.execPath, [probe], {
          env: { ...process.env, TZ: tz, PG_SESSION_TZ: session },
          encoding: 'utf8',
          timeout: 120_000,
        })
        const out = `${r.stdout || ''}\n${r.stderr || ''}`
        expect(r.status, out).toBe(0)
        expect(out).toContain(`"tz":"${tz}"`)
        expect(out).toContain(`"session":"${session}"`)
        expect(out).toContain('"la":"2026-09-27"')
        expect(out).toContain('"akl":"2026-09-28"')
        expect(out).toContain('"ok":true')
      }, 120_000)
    }
  }
})
