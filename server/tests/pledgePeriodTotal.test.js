// A weekly pledge's period_total follows the organization's civil today,
// not UTC and not the process timezone. Node reads TZ at startup, so each
// process zone is a child. The probe crosses those with an LA org and an
// Auckland org.
//
// At 2026-09-27T04:17:00Z an LA parish is still on 2026-09-26, so a pledge
// starting 2026-09-27 has not begun ($0). An Auckland parish is on
// 2026-09-27, one inclusive day ($1). A missing or invalid zone uses UTC.

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const ZONES = ['UTC', 'America/Los_Angeles', 'Pacific/Auckland']
const probe = join(dirname(fileURLToPath(import.meta.url)), 'pledgePeriodTotal.probe.mjs')

describe('pledge period totals do not follow the process timezone', () => {
  for (const tz of ZONES) {
    it(`civil-day totals under TZ=${tz}`, () => {
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
