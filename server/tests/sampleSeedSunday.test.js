// Sample Masses are civil Sundays in the parish timezone.
//
// The signup seeder used to take the weekday from Date#getDay / setDate
// (the process zone) and store Date#toISOString().slice(0, 10) (the UTC
// day). Saturday 23:00 in America/Los_Angeles is already Sunday morning
// UTC, and "next Sunday" kept that evening hour, so the stored day was
// Monday. These three clocks are the falsifier: 23:00 Saturday, 00:30
// Sunday, and a morning, all in the org zone, must seed Sundays.
//
// Reverting nextDowStr / daysFromNow to getDay + setDate + toISOString
// makes the Saturday 23:00 case store 2026-09-28 (process zone west of
// UTC) or 2026-10-04 (process zone UTC). Neither is the parish Sunday
// 2026-09-27. That is the mutation this file is for.
//
// CI's npm test runs this file twice: once in the job's default zone
// (UTC) and once with TZ=Pacific/Auckland. Two mutations stay green
// under UTC and fail in Auckland:
//   resolveParishTimeZone(null/blank/invalid) returns the process zone
//   addCivilDays uses local setDate + toISOString instead of setUTCDate
// The fallback clock below is Saturday 18:00 UTC, which is already
// Sunday in Pacific/Auckland. The Saturday 23:00 Pacific clock crosses
// the Auckland DST step when addCivilDays uses local fields.

import 'dotenv/config'
import request from 'supertest'
import { classifyDatabaseUrl } from '../../scripts/lib/db-target-guard.mjs'

const dbTarget = classifyDatabaseUrl(process.env.DATABASE_URL)
if (dbTarget.kind !== 'local') {
  throw new Error(
    `sampleSeedSunday.test.js refuses to run (database target kind=${dbTarget.kind}). Export a loopback DATABASE_URL.`
  )
}

const { default: pool } = await import('../src/db.js')
const { migrateOnce, RUN_ID, bindServer, closeServer } = await import('./support/harness.js')
const { seedSampleData } = await import('../src/onboarding/sampleSeed.js')
const { PARISH_TIMEZONE_FALLBACK, resolveParishTimeZone } = await import('../src/utils/timezone.js')

import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const PT = 'America/Los_Angeles'
// September 2026 is PDT (UTC−7). The instants are absolute; the parish
// wall clock is what the seeder must use.
const SAT_2300 = new Date('2026-09-26T23:00:00-07:00')
const SUN_0030 = new Date('2026-09-27T00:30:00-07:00')
const WED_0900 = new Date('2026-09-23T09:00:00-07:00')

const SUNDAYS_FROM_SEP_27 = [
  '2026-09-27', '2026-10-04', '2026-10-11', '2026-10-18',
  '2026-10-25', '2026-11-01', '2026-11-08', '2026-11-15',
]
const SUNDAYS_FROM_OCT_4 = [
  '2026-10-04', '2026-10-11', '2026-10-18', '2026-10-25',
  '2026-11-01', '2026-11-08', '2026-11-15', '2026-11-22',
]

let seq = 0
let server
const orgIds = []

function assertSundaySeries(dates, expected) {
  expect(dates).toEqual(expected)
  for (const iso of dates) {
    expect(new Date(`${iso}T00:00:00Z`).getUTCDay(), iso).toBe(0)
  }
}

async function insertOrg(timezone) {
  seq += 1
  const slug = `sunseed-${RUN_ID}-${seq}`
  const params = [`Sunday Seed ${seq}`, slug]
  const tzSql = timezone === undefined ? '' : ', timezone'
  const tzVal = timezone === undefined ? '' : ', $3'
  if (timezone !== undefined) params.push(timezone)
  const { rows } = await pool.query(
    `INSERT INTO ochr_organizations (name, slug, tradition${tzSql})
     VALUES ($1, $2, 'catholic'${tzVal})
     RETURNING id`,
    params
  )
  orgIds.push(rows[0].id)
  return rows[0].id
}

async function massDates(orgId) {
  const { rows } = await pool.query(
    `SELECT to_char(date, 'YYYY-MM-DD') AS date
       FROM ochr_calendar_events
      WHERE organization_id = $1
        AND title = '[Sample] Sunday Mass'
      ORDER BY date`,
    [orgId]
  )
  return rows.map(r => r.date)
}

async function eventDate(orgId, title) {
  const { rows } = await pool.query(
    `SELECT to_char(date, 'YYYY-MM-DD') AS date
       FROM ochr_events
      WHERE organization_id = $1 AND title = $2`,
    [orgId, title]
  )
  expect(rows).toHaveLength(1)
  return rows[0].date
}

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
}, 60_000)

afterAll(async () => {
  await closeServer(server)
  if (orgIds.length) {
    await pool.query('DELETE FROM ochr_organizations WHERE id = ANY($1::int[])', [orgIds])
  }
  await pool.end()
})

describe('parish timezone resolution for sample dates', () => {
  it('uses the org zone, and UTC when the org has none', () => {
    expect(PARISH_TIMEZONE_FALLBACK).toBe('UTC')
    expect(resolveParishTimeZone('America/Los_Angeles')).toBe('America/Los_Angeles')
    expect(resolveParishTimeZone(null)).toBe('UTC')
    expect(resolveParishTimeZone(undefined)).toBe('UTC')
    expect(resolveParishTimeZone('')).toBe('UTC')
    expect(resolveParishTimeZone('   ')).toBe('UTC')
    expect(resolveParishTimeZone('Not/AZone')).toBe('UTC')
  })
})

describe('signup sample Sundays follow the org timezone', () => {
  async function seedAt(timezone, now) {
    const orgId = await insertOrg(timezone)
    const summary = await seedSampleData(pool, orgId, 'catholic', { now })
    expect(summary.schedule_entries).toBe(8)
    return orgId
  }

  it('23:00 Saturday seeds the coming parish Sunday', async () => {
    const orgId = await seedAt(PT, SAT_2300)
    assertSundaySeries(await massDates(orgId), SUNDAYS_FROM_SEP_27)
    expect(await eventDate(orgId, '[Sample] Sunday Mass')).toBe('2026-09-27')
    // daysFromNow shares the old UTC-day bug. Saturday 23:00 PT plus
    // 14 civil days is 2026-10-10, not the UTC morning after it.
    expect(await eventDate(orgId, '[Sample] Volunteer Training')).toBe('2026-10-10')
  })

  // Isolated so a mutation run can see this case on its own. Saturday
  // 23:00 is the clock that moves the stored day. 00:30 Sunday in
  // America/Los_Angeles is already Sunday in UTC, and the old
  // getDay/setDate/toISOString path still stores a Sunday.
  it('00:30 Sunday seeds the following Sunday', async () => {
    const orgId = await seedAt(PT, SUN_0030)
    assertSundaySeries(await massDates(orgId), SUNDAYS_FROM_OCT_4)
    expect(await eventDate(orgId, '[Sample] Sunday Mass')).toBe('2026-10-04')
  })

  // Isolated for the same reason. Wednesday 09:00 Pacific is still
  // Wednesday in UTC, so the old path's next Sunday is the same civil day.
  it('Wednesday 09:00 seeds the coming parish Sunday', async () => {
    const orgId = await seedAt(PT, WED_0900)
    assertSundaySeries(await massDates(orgId), SUNDAYS_FROM_SEP_27)
    expect(await eventDate(orgId, '[Sample] Sunday Mass')).toBe('2026-09-27')
  })

  it('a default or invalid org timezone falls back to UTC', async () => {
    // Saturday 18:00 UTC is Sunday 07:00 in Pacific/Auckland. A fallback
    // that reads the process zone stores 2026-10-04 under that TZ and
    // 2026-09-27 under UTC. UTC is the required fallback in both.
    const saturdayUtc = new Date('2026-09-26T18:00:00Z')
    const untouched = await seedAt(undefined, saturdayUtc)
    const invalid = await seedAt('Not/AZone', saturdayUtc)
    assertSundaySeries(await massDates(untouched), SUNDAYS_FROM_SEP_27)
    assertSundaySeries(await massDates(invalid), SUNDAYS_FROM_SEP_27)
  })
})

// Signup's own clock. new Date() with no arguments is the sample seed's
// "now" when the route does not pass one. Everything else (parsing an
// ISO string, Date.UTC) stays real.
async function withFixedNow(instant, fn) {
  const RealDate = globalThis.Date
  const fixedMs = instant.getTime()
  function FixedDate(...args) {
    if (args.length === 0) return new RealDate(fixedMs)
    return new RealDate(...args)
  }
  FixedDate.now = () => fixedMs
  FixedDate.parse = RealDate.parse
  FixedDate.UTC = RealDate.UTC
  FixedDate.prototype = RealDate.prototype
  globalThis.Date = FixedDate
  try {
    return await fn()
  } finally {
    globalThis.Date = RealDate
  }
}

let signupN = 0
async function signupAt(timezone, now) {
  signupN += 1
  const body = {
    organizationName: `Sunday Signup ${RUN_ID} ${signupN}`,
    name: 'Secretary',
    email: `sunseed-signup-${RUN_ID}-${signupN}@example.com`,
    password: 'signup-sunday-pw-1',
    tradition: 'catholic',
  }
  if (timezone !== undefined) body.timezone = timezone
  const res = await withFixedNow(now, () => request(server)
    .post('/api/auth/signup')
    .set('X-Forwarded-For', `10.226.0.${signupN}`)
    .send(body))
  expect(res.status, JSON.stringify(res.body)).toBe(201)
  const orgId = res.body.user.organization.id
  orgIds.push(orgId)
  return orgId
}

describe('signup writes the browser zone before the sample seed', () => {
  it('America/Los_Angeles at Saturday 23:00 Pacific stores that zone and seeds Sundays', async () => {
    const orgId = await signupAt(PT, SAT_2300)
    assertSundaySeries(await massDates(orgId), SUNDAYS_FROM_SEP_27)
    const { rows } = await pool.query('SELECT timezone FROM ochr_organizations WHERE id = $1', [orgId])
    expect(rows[0].timezone).toBe(PT)
  }, 60_000)

  it('an invalid zone stores UTC', async () => {
    const orgId = await signupAt('Not/AZone', SAT_2300)
    const { rows } = await pool.query('SELECT timezone FROM ochr_organizations WHERE id = $1', [orgId])
    expect(rows[0].timezone).toBe('UTC')
    assertSundaySeries(await massDates(orgId), SUNDAYS_FROM_OCT_4)
  }, 60_000)

  it('a missing zone stores UTC', async () => {
    const orgId = await signupAt(undefined, SAT_2300)
    const { rows } = await pool.query('SELECT timezone FROM ochr_organizations WHERE id = $1', [orgId])
    expect(rows[0].timezone).toBe('UTC')
    assertSundaySeries(await massDates(orgId), SUNDAYS_FROM_OCT_4)
  }, 60_000)
})
