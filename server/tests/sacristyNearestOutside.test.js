// Empty-week honesty — GET /api/mass-intentions/nearest-outside.
// The book page (limit=50, listing date ASC NULLS FIRST) can hide a
// dated row past the first page. This route reads week_date on the
// sacristy view so a dated out-of-window intention still discloses,
// and counts tenant-scoped open/scheduled rows with no listing date
// so an undated-only book is not silent.
//
// Mutate any one of these and the matching test goes red:
//   1. First-50 book peek substituted for the view query
//   2. organization_id filter dropped
//   3. Cancelled / in-window / null week_date included as a jump target
//   4. Undated open/scheduled waiting omitted from undated_waiting
//   5. Cancelled or fulfilled counted as undated waiting
//   6. Org B seeing org A's undated waiting

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'

let server
let tokenA
let tokenB
let orgAId

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()

  const a = await createOrg(server, {
    organizationName: `Peek Parish A ${RUN_ID}`,
    name: 'Ada Admin',
    email: `peek_a_${RUN_ID}@example.com`,
    password: 'peek-test-pw-1',
  })
  expect(a.status).toBe(201)
  tokenA = a.body.token
  orgAId = a.body.user.organization.id

  const b = await createOrg(server, {
    organizationName: `Peek Parish B ${RUN_ID}`,
    name: 'Bea Admin',
    email: `peek_b_${RUN_ID}@example.com`,
    password: 'peek-test-pw-2',
  })
  expect(b.status).toBe(201)
  tokenB = b.body.token
}, 60_000)

afterAll(async () => {
  await closeServer(server)
})

const auth = token => ({ Authorization: `Bearer ${token}` })

function nearest(start, end, token = tokenA) {
  return request(server)
    .get(`/api/mass-intentions/nearest-outside?start=${start}&end=${end}`)
    .set(auth(token))
}

describe('GET /api/mass-intentions/nearest-outside', () => {
  it('returns 400 for missing, inverted, or overlong windows', async () => {
    const missing = await nearest('', '2026-09-21')
    expect(missing.status).toBe(400)

    const inverted = await request(server)
      .get('/api/mass-intentions/nearest-outside?start=2026-09-21&end=2026-09-15')
      .set(auth(tokenA))
    expect(inverted.status).toBe(400)
    expect(inverted.body.error).toMatch(/end must be on or after start/i)

    const tooLong = await request(server)
      .get('/api/mass-intentions/nearest-outside?start=2026-09-15&end=2026-10-31')
      .set(auth(tokenA))
    expect(tooLong.status).toBe(400)
    expect(tooLong.body.error).toMatch(/31 days/i)
  })

  it('finds a dated row the first book page misses, and stays tenant-scoped', async () => {
    await pool.query(
      `INSERT INTO ochr_mass_intentions (organization_id, intention, status)
       SELECT $1, 'undated peek ' || g || ' ${RUN_ID}', 'open'
         FROM generate_series(1, 50) AS g`,
      [orgAId]
    )
    const dated = await request(server).post('/api/mass-intentions')
      .set(auth(tokenA))
      .send({ intention: `dated outside ${RUN_ID}`, mass_date: '2026-10-04', status: 'open' })
    expect(dated.status).toBe(201)

    const page = await request(server)
      .get('/api/mass-intentions?limit=50&offset=0')
      .set(auth(tokenA))
    expect(page.status).toBe(200)
    expect(page.body.intentions.some(r => r.id === dated.body.id)).toBe(false)

    const res = await nearest('2026-09-15', '2026-09-21')
    expect(res.status).toBe(200)
    expect(res.body.start).toBe('2026-09-15')
    expect(res.body.end).toBe('2026-09-21')
    expect(res.body.date).toBe('2026-10-04')
    expect(res.body.undated_waiting).toBe(true)
    expect(res.body.undated_waiting_count).toBe(50)

    const other = await nearest('2026-09-15', '2026-09-21', tokenB)
    expect(other.status).toBe(200)
    expect(other.body.date).toBeNull()
    expect(other.body.undated_waiting).toBe(false)
    expect(other.body.undated_waiting_count).toBe(0)
  })

  it('skips cancelled, in-window, and undated rows', async () => {
    const isolated = await createOrg(server, {
      organizationName: `Peek Skip ${RUN_ID}`,
      name: 'Skip Admin',
      email: `peek_skip_${RUN_ID}@example.com`,
      password: 'peek-skip-pw-1',
    })
    expect(isolated.status).toBe(201)
    const token = isolated.body.token

    const cancelled = await request(server).post('/api/mass-intentions')
      .set(auth(token))
      .send({ intention: `cancelled outside ${RUN_ID}`, mass_date: '2026-08-01', status: 'cancelled' })
    expect(cancelled.status).toBe(201)

    const inside = await request(server).post('/api/mass-intentions')
      .set(auth(token))
      .send({ intention: `inside window ${RUN_ID}`, mass_date: '2026-09-16', status: 'open' })
    expect(inside.status).toBe(201)

    const undated = await request(server).post('/api/mass-intentions')
      .set(auth(token))
      .send({ intention: `undated ${RUN_ID}`, status: 'open' })
    expect(undated.status).toBe(201)

    const empty = await nearest('2026-09-15', '2026-09-21', token)
    expect(empty.status).toBe(200)
    expect(empty.body.date).toBeNull()
    expect(empty.body.undated_waiting).toBe(true)
    expect(empty.body.undated_waiting_count).toBe(1)
  })

  it('discloses undated-only waiting and stays silent on a true-empty book', async () => {
    const isolated = await createOrg(server, {
      organizationName: `Peek Undated ${RUN_ID}`,
      name: 'Undated Admin',
      email: `peek_undated_${RUN_ID}@example.com`,
      password: 'peek-undated-pw-1',
    })
    expect(isolated.status).toBe(201)
    const token = isolated.body.token

    const empty = await nearest('2026-09-15', '2026-09-21', token)
    expect(empty.status).toBe(200)
    expect(empty.body.date).toBeNull()
    expect(empty.body.undated_waiting).toBe(false)
    expect(empty.body.undated_waiting_count).toBe(0)

    const open = await request(server).post('/api/mass-intentions')
      .set(auth(token))
      .send({ intention: `undated open ${RUN_ID}`, status: 'open' })
    expect(open.status).toBe(201)
    expect(open.body.mass_date).toBeNull()

    const scheduled = await request(server).post('/api/mass-intentions')
      .set(auth(token))
      .send({ intention: `undated scheduled ${RUN_ID}`, status: 'scheduled' })
    expect(scheduled.status).toBe(201)
    expect(scheduled.body.mass_date).toBeNull()

    const waiting = await nearest('2026-09-15', '2026-09-21', token)
    expect(waiting.status).toBe(200)
    expect(waiting.body.date).toBeNull()
    expect(waiting.body.undated_waiting).toBe(true)
    expect(waiting.body.undated_waiting_count).toBe(2)

    const other = await nearest('2026-09-15', '2026-09-21', tokenB)
    expect(other.status).toBe(200)
    expect(other.body.date).toBeNull()
    expect(other.body.undated_waiting).toBe(false)
    expect(other.body.undated_waiting_count).toBe(0)

    const weekly = await request(server)
      .get('/api/mass-intentions/weekly?start=2026-09-15&end=2026-09-21')
      .set(auth(token))
    expect(weekly.status).toBe(200)
    expect(weekly.body.intentions).toEqual([])
  })

  it('does not count cancelled or fulfilled-without-stamp as undated waiting', async () => {
    const isolated = await createOrg(server, {
      organizationName: `Peek Quiet ${RUN_ID}`,
      name: 'Quiet Admin',
      email: `peek_quiet_${RUN_ID}@example.com`,
      password: 'peek-quiet-pw-1',
    })
    expect(isolated.status).toBe(201)
    const token = isolated.body.token
    const orgId = isolated.body.user.organization.id

    const cancelled = await request(server).post('/api/mass-intentions')
      .set(auth(token))
      .send({ intention: `cancelled undated ${RUN_ID}`, status: 'cancelled' })
    expect(cancelled.status).toBe(201)
    expect(cancelled.body.mass_date).toBeNull()

    // Fulfilled-without-stamp is a historical unknown, not waiting.
    // Insert directly so we do not invent stamps or bypass the ceremony.
    await pool.query(
      `INSERT INTO ochr_mass_intentions
         (organization_id, intention, status, mass_date,
          fulfilled_mass_date, fulfilled_mass_title, fulfilled_mass_time)
       VALUES ($1, $2, 'fulfilled', NULL, NULL, NULL, NULL)`,
      [orgId, `fulfilled undated ${RUN_ID}`]
    )

    const quiet = await nearest('2026-09-15', '2026-09-21', token)
    expect(quiet.status).toBe(200)
    expect(quiet.body.date).toBeNull()
    expect(quiet.body.undated_waiting).toBe(false)
    expect(quiet.body.undated_waiting_count).toBe(0)

    const { rows: stamps } = await pool.query(
      `SELECT fulfilled_mass_date, fulfilled_mass_title, fulfilled_mass_time
         FROM ochr_mass_intentions
        WHERE organization_id = $1 AND intention = $2`,
      [orgId, `fulfilled undated ${RUN_ID}`]
    )
    expect(stamps).toHaveLength(1)
    expect(stamps[0].fulfilled_mass_date).toBeNull()
    expect(stamps[0].fulfilled_mass_title).toBeNull()
    expect(stamps[0].fulfilled_mass_time).toBeNull()
  })

  it('uses the fulfilled stamp as the listing date, not a later working date', async () => {
    const isolated = await createOrg(server, {
      organizationName: `Peek Stamp ${RUN_ID}`,
      name: 'Stamp Admin',
      email: `peek_stamp_${RUN_ID}@example.com`,
      password: 'peek-stamp-pw-1',
    })
    expect(isolated.status).toBe(201)
    const token = isolated.body.token
    const orgId = isolated.body.user.organization.id

    const mass = await request(server).post('/api/calendar')
      .set(auth(token))
      .send({
        title: `Stamp Mass ${RUN_ID}`,
        date: '2026-08-20',
        start_time: '08:00',
        end_time: '09:00',
        type: 'service',
      })
    expect(mass.status).toBe(201)

    const made = await request(server).post('/api/mass-intentions')
      .set(auth(token))
      .send({ intention: `stamp outside ${RUN_ID}` })
    expect(made.status).toBe(201)
    const offered = await request(server).post(`/api/mass-intentions/${made.body.id}/assign`)
      .set(auth(token))
      .send({ calendar_event_id: mass.body.id, expected_calendar_event_id: null })
    expect(offered.status).toBe(200)
    const fulfilled = await request(server).patch(`/api/mass-intentions/${made.body.id}`)
      .set(auth(token))
      .send({ status: 'fulfilled' })
    expect(fulfilled.status).toBe(200)
    expect(fulfilled.body.mass_date).toBe('2026-08-20')

    // A later working-date rewrite must not move the listing window.
    await pool.query(
      `UPDATE ochr_mass_intentions
          SET mass_date = '2026-09-16'
        WHERE id = $1 AND organization_id = $2`,
      [made.body.id, orgId]
    )

    const res = await nearest('2026-09-15', '2026-09-21', token)
    expect(res.status).toBe(200)
    expect(res.body.date).toBe('2026-08-20')
    expect(res.body.undated_waiting).toBe(false)
    expect(res.body.undated_waiting_count).toBe(0)
  })
})
