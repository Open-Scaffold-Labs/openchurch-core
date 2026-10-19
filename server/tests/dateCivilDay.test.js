// A Postgres DATE must leave the API as the stored civil day, in every
// process timezone. node-pg's default parser builds a Date at local
// midnight; JSON then emits an ISO timestamp whose calendar day moves
// when the process is east of UTC, and whose UTC midnight reads as the
// previous evening in a US browser.
//
// This file spawns one probe per TZ because Node reads TZ at startup.
// Removing pg.types.setTypeParser(1082) in server/src/db.js turns it red.

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const ZONES = ['UTC', 'America/Los_Angeles', 'Pacific/Auckland']
const probe = join(dirname(fileURLToPath(import.meta.url)), 'dateCivilDay.probe.mjs')

describe('DATE columns are the stored civil day', () => {
  for (const tz of ZONES) {
    it(`returns 2026-09-27 under TZ=${tz}`, () => {
      expect(process.env.DATABASE_URL, 'DATABASE_URL must be set to the local database').toBeTruthy()
      const r = spawnSync(process.execPath, [probe], {
        env: { ...process.env, TZ: tz },
        encoding: 'utf8',
        timeout: 120_000,
      })
      const out = `${r.stdout || ''}\n${r.stderr || ''}`
      expect(r.status, out).toBe(0)
      expect(out).toContain(`"tz":"${tz}"`)
      expect(out).toContain('"ok":true')
    }, 120_000)
  }
})
