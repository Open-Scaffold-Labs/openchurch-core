// Maintenance 2026-10-29: the Assistant's daily question limit says it
// "resets at midnight". The count used date_trunc('day', NOW()), which is
// midnight on the database session clock, not the parish's. It now counts
// from midnight in the parish's own timezone (Org details).
//
// WHAT WOULD MAKE THIS FAIL
//   - todayCount starts the day on the database clock instead of the
//     parish timezone, so a message sent between the two midnights is
//     counted (or dropped) on the wrong day.
import { describe, it, expect, beforeAll } from 'vitest'
import 'dotenv/config'

import pool from '../src/db.js'
import { todayCount } from '../src/routes/assistant.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'

// Fixed-offset zones (no daylight time), far from UTC and from each other.
const ZONES = [
  { tz: 'Pacific/Kiritimati', offsetMin: 14 * 60 },
  { tz: 'Pacific/Pago_Pago', offsetMin: -11 * 60 },
]

// Parish-local midnight today as a UTC instant, computed in JS, not SQL.
function localMidnightUtcMs(nowMs, offsetMin) {
  const local = new Date(nowMs + offsetMin * 60000)
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - offsetMin * 60000
}

const orgs = []

beforeAll(async () => {
  await migrateOnce()
  const server = await bindServer()
  try {
    for (const [i, z] of ZONES.entries()) {
      const r = await createOrg(server, {
        organizationName: `Assistant Day Parish ${i} ${RUN_ID}`,
        name: 'Ada Admin',
        email: `assistant_day_${i}_${RUN_ID}@example.com`,
        password: 'assistant-day-pw-1',
      }, `10.251.29.${i + 1}`)
      expect(r.status).toBe(201)
      const { rows: [u] } = await pool.query('SELECT organization_id FROM ochr_users WHERE email = $1', [`assistant_day_${i}_${RUN_ID}@example.com`])
      await pool.query('UPDATE ochr_organizations SET timezone = $1 WHERE id = $2', [z.tz, u.organization_id])
      orgs.push({ ...z, id: u.organization_id })
    }
  } finally {
    await closeServer(server)
  }
})

describe('Assistant daily limit counts the parish day (maint 2026-10-29)', () => {
  for (const [i, z] of ZONES.entries()) {
    it(`counts from midnight in ${z.tz}`, async () => {
      const org = orgs[i]
      const nowMs = Date.now()
      const start = localMidnightUtcMs(nowMs, z.offsetMin)
      const { rows: [db] } = await pool.query("SELECT EXTRACT(EPOCH FROM date_trunc('day', NOW()))*1000 AS ms")
      const dbStart = Number(db.ms)
      const stamps = [
        start - 1000,                      // parish yesterday: never counts
        nowMs - 1000,                      // just now: always counts
        Math.round((start + dbStart) / 2), // between the two midnights
      ].filter(ms => ms <= nowMs)
      for (const ms of stamps) {
        await pool.query(
          `INSERT INTO ochr_assistant_messages (organization_id, page_route, question, created_at)
           VALUES ($1, '/test', NULL, to_timestamp($2 / 1000.0))`, [org.id, ms])
      }
      const expected = stamps.filter(ms => ms >= start).length
      expect(start).not.toBe(dbStart)
      expect(await todayCount(org.id)).toBe(expected)
    })
  }
})
