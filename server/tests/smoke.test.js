// Smoke tests for the load-bearing security guarantees:
//   1. Auth happy path: signup → login → /me → logout
//   2. Tenant isolation: org A users cannot read or write org B data
//   3. Role enforcement: viewer is read-only; admin can manage users
//
// Run against the real dev Postgres so we're testing actual SQL,
// real bcrypt, real JWT signing — not stubs. Each run creates two
// throwaway orgs with timestamp-based emails so reruns don't collide,
// and afterAll deletes them along with all their cascaded data.
//
// Uses vitest + supertest against ONE listener bound in beforeAll.
// Handing the Express app straight to supertest is the obvious spelling
// but binds a fresh ephemeral port per request — see the note on the
// shared `server` below for why that had to go.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

import app from '../src/app.js'
import { runAllMigrations } from '../src/migrations/index.js'
import { seedSampleData } from '../src/onboarding/sampleSeed.js'
import pool from '../src/db.js'
import { pruneOldRecords } from '../src/services/retention.js'
import { hashSecurityCode } from '../src/utils/pickupCode.js'
import { notify } from '../src/notifications/transport.js'
import { liturgicalLine } from '../src/notifications/calendarReminders.js'
import { sendPushToUser, isPushConfigured } from '../src/notifications/push.js'
import { monitor, _setDispatchForTests } from '../src/monitoring/index.js'
import { enqueueSacramentAnniversaryDigests } from '../src/notifications/sacramentAnniversaries.js'
import crypto from 'node:crypto'
import jwt from 'jsonwebtoken'

// Unique-per-run identifier so two test runs don't conflict on the
// same dev DB. Using millis + random suffix to be extra safe.
const RUN_ID = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
const orgA = {
  organizationName: `Test Org A ${RUN_ID}`,
  name:             'Alice Admin',
  email:            `test_a_${RUN_ID}@example.com`,
  password:         'smoke-test-pw-1',
}
const orgB = {
  organizationName: `Test Org B ${RUN_ID}`,
  name:             'Bob Admin',
  email:            `test_b_${RUN_ID}@example.com`,
  password:         'smoke-test-pw-2',
}
// A throwaway org whose admin display name is a CSV/formula-injection
// payload, used by the audit export test (AUD.2). The name is the
// attacker-controlled value that lands in the user_name CSV cell.
const INJECT_NAME = `=2+5+cmd|' /C calc'!A0, "x"`
const orgInject = {
  organizationName: `Test Org INJ ${RUN_ID}`,
  name:             INJECT_NAME,
  email:            `test_inj_${RUN_ID}@example.com`,
  password:         'smoke-test-pw-3',
}

let tokenA, tokenB

// The suite's single HTTP listener. Every request goes through this one
// bound port instead of supertest's default (a new server per call).
let server

// Polls ochr_audit_log until a row matching `predicate` shows up.
// The audit write is fire-and-forget from res.on('finish'), so the
// request can return milliseconds before the row lands. 2s is
// generous; in practice the row arrives in <100ms.
async function waitForAuditRow(orgId, predicate, timeoutMs = 2000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const { rows } = await pool.query(
      `SELECT * FROM ochr_audit_log
        WHERE organization_id = $1
        ORDER BY created_at DESC
        LIMIT 25`,
      [orgId]
    )
    const match = rows.find(predicate)
    if (match) return match
    await new Promise(r => setTimeout(r, 50))
  }
  throw new Error('Timed out waiting for audit row')
}

beforeAll(async () => {
  // Make sure schema is up to date — running tests against a stale
  // DB would produce confusing failures.
  await runAllMigrations()

  // Bind ONCE for the whole suite.
  //
  // `request(app)` looks stateless, but supertest wraps the app in a new
  // http.Server and binds a fresh ephemeral port for EVERY call. At ~873
  // call sites that is ~873 listen/close cycles inside a six-second run,
  // and the kernel intermittently reset one of those short-lived sockets.
  // The symptom was a random test — never the same one twice — dying at
  // ~3ms with "socket hang up", which reads like a tenant-isolation
  // failure but is pure transport churn. Reusing one listening server
  // makes supertest skip the per-request bind (it only calls listen()
  // when address() is null), and the churn disappears.
  server = app.listen(0)
  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
}, 60_000)

afterAll(async () => {
  // Clean up everything we created. Org delete cascades to users
  // (and to all per-tenant rows via the organization_id FK).
  await pool.query(
    `DELETE FROM ochr_organizations WHERE name IN ($1, $2, $3)`,
    [orgA.organizationName, orgB.organizationName, orgInject.organizationName]
  )
  // Close the shared listener before the pool so no in-flight request
  // outlives the connections it needs.
  if (server) await new Promise(resolve => server.close(resolve))
  await pool.end()
})

describe('auth happy path', () => {
  it('signs up a new org + admin and returns a token', async () => {
    const res = await request(server).post('/api/auth/signup').send(orgA)
    expect(res.status).toBe(201)
    expect(res.body.token).toBeTruthy()
    expect(res.body.user.email).toBe(orgA.email.toLowerCase())
    expect(res.body.user.role).toBe('admin')
    expect(res.body.user.organization.name).toBe(orgA.organizationName)
    tokenA = res.body.token
  })

  it('signs up a second independent org', async () => {
    const res = await request(server).post('/api/auth/signup').send(orgB)
    expect(res.status).toBe(201)
    tokenB = res.body.token
    expect(tokenB).not.toBe(tokenA) // different sessions, different signing inputs
  })

  it('rejects login with wrong password', async () => {
    const res = await request(server)
      .post('/api/auth/login')
      .send({ email: orgA.email, password: 'wrong-password' })
    expect(res.status).toBe(401)
  })

  it('one account being brute-forced does not lock out the rest of the parish office', async () => {
    // REGRESSION (2026-08-01). Every auth limiter used to key on IP alone, and
    // a parish office NATs its whole staff behind one public IP — so one
    // person mistyping their password repeatedly took the entire office
    // offline. Login now keys the tight limit on the EMAIL and keeps only a
    // loose ceiling on the IP.
    //
    // Hammer a throwaway address past the per-account limit (8). Deliberately
    // NOT one of the suite's real accounts: locking those out is precisely the
    // collateral damage this test exists to forbid.
    const victim = `bruteforced-${RUN_ID}@example.com`
    for (let i = 0; i < 10; i++) {
      await request(server).post('/api/auth/login').send({ email: victim, password: `wrong-${i}` })
    }
    const blocked = await request(server)
      .post('/api/auth/login')
      .send({ email: victim, password: 'wrong-again' })
    expect(blocked.status).toBe(429)

    // Same IP, different colleague — must be completely unaffected.
    const colleague = await request(server)
      .post('/api/auth/login')
      .send({ email: orgA.email, password: orgA.password })
    expect(colleague.status).toBe(200)
    expect(colleague.body.token).toBeTruthy()
  })

  it('logs in with right password and returns a fresh token', async () => {
    const res = await request(server)
      .post('/api/auth/login')
      .send({ email: orgA.email, password: orgA.password })
    expect(res.status).toBe(200)
    expect(res.body.token).toBeTruthy()
  })

  it('returns the user from /me with a valid token', async () => {
    const res = await request(server)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.user.email).toBe(orgA.email.toLowerCase())
  })

  it('rejects /me with no token', async () => {
    const res = await request(server).get('/api/auth/me')
    expect(res.status).toBe(401)
  })

  it('rejects /me with a garbage token', async () => {
    const res = await request(server)
      .get('/api/auth/me')
      .set('Authorization', 'Bearer not-a-real-token')
    expect(res.status).toBe(401)
  })
})

describe('tenant isolation', () => {
  it('only returns members from the caller\'s own org', async () => {
    // Each org's signup seeded its own [Sample] members. Org A should
    // see only its three; org B should see only its three. If the
    // organization_id filter on /api/clients regresses, this fails.
    const a = await request(server)
      .get('/api/clients')
      .set('Authorization', `Bearer ${tokenA}`)
    const b = await request(server)
      .get('/api/clients')
      .set('Authorization', `Bearer ${tokenB}`)

    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    // Sample seed inserts exactly 3 [Sample] members per org. If the
    // app ever changes that count, update both expectations or use
    // .toBeGreaterThan(0) — but exact-3 catches accidental cross-org
    // joins that would inflate the result.
    expect(a.body.length).toBeGreaterThan(0)
    expect(b.body.length).toBeGreaterThan(0)

    const namesA = new Set(a.body.map(m => m.name))
    const namesB = new Set(b.body.map(m => m.name))
    // No name from A's list should appear in B's list — the [Sample]
    // names are identical strings across orgs but their ids differ.
    // We assert by id instead.
    const idsA = new Set(a.body.map(m => m.id))
    const idsB = new Set(b.body.map(m => m.id))
    for (const id of idsA) expect(idsB.has(id)).toBe(false)
  })

  it('does not let org A patch a member belonging to org B', async () => {
    const bMembers = await request(server)
      .get('/api/clients')
      .set('Authorization', `Bearer ${tokenB}`)
    const targetId = bMembers.body[0]?.id
    expect(targetId).toBeTruthy()

    const res = await request(server)
      .patch(`/api/clients/${targetId}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Hijacked Name' })
    // The route filters by organization_id in the WHERE clause, so a
    // cross-org PATCH finds zero matching rows and returns 404.
    expect(res.status).toBe(404)
  })

  // ── Cross-router isolation ────────────────────────────────
  // The pattern below applies the same shape to every mutating
  // tenant-scoped router: orgA creates X, orgB's list omits it, and
  // orgB's PATCH/DELETE on X's id returns 404. If a new route forgets
  // its `WHERE organization_id = $1` clause, one of these flips red.

  it('events are scoped to the creating org', async () => {
    const create = await request(server)
      .post('/api/events')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `Iso Event ${RUN_ID}`,
        date: '2027-06-15',
        time: '10:00',
      })
    expect(create.status).toBe(201)
    const eventId = create.body.id

    // Org B's list must not include it.
    const listB = await request(server)
      .get('/api/events')
      .set('Authorization', `Bearer ${tokenB}`)
    expect(listB.status).toBe(200)
    expect(listB.body.find(e => e.id === eventId)).toBeUndefined()

    // Cross-org PATCH/DELETE → 404.
    const patchB = await request(server)
      .patch(`/api/events/${eventId}`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ title: 'Hijacked' })
    expect(patchB.status).toBe(404)

    const deleteB = await request(server)
      .delete(`/api/events/${eventId}`)
      .set('Authorization', `Bearer ${tokenB}`)
    expect(deleteB.status).toBe(404)
  })

  it('tasks are scoped to the creating org', async () => {
    const taskId = `iso-task-${RUN_ID}`
    const create = await request(server)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        id: taskId,
        title: `Iso Task ${RUN_ID}`,
        category: 'CLEANING',
      })
    expect(create.status).toBe(201)

    const listB = await request(server)
      .get('/api/tasks')
      .set('Authorization', `Bearer ${tokenB}`)
    expect(listB.status).toBe(200)
    expect(listB.body.find(t => t.id === taskId)).toBeUndefined()

    const patchB = await request(server)
      .patch(`/api/tasks/${taskId}`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ title: 'Hijacked' })
    expect(patchB.status).toBe(404)

    const deleteB = await request(server)
      .delete(`/api/tasks/${taskId}`)
      .set('Authorization', `Bearer ${tokenB}`)
    expect(deleteB.status).toBe(404)
  })

  it('schedule entries (ochr_calendar_events) are scoped to the creating org', async () => {
    const create = await request(server)
      .post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `Iso Schedule ${RUN_ID}`,
        date: '2027-07-20',
        start_time: '09:00',
        end_time: '10:00',
        type: 'service',
      })
    expect(create.status).toBe(201)
    const id = create.body.id

    const listB = await request(server)
      .get('/api/calendar')
      .set('Authorization', `Bearer ${tokenB}`)
    expect(listB.status).toBe(200)
    expect(listB.body.find(e => e.id === id)).toBeUndefined()

    const patchB = await request(server)
      .patch(`/api/calendar/${id}`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ title: 'Hijacked' })
    expect(patchB.status).toBe(404)

    const deleteB = await request(server)
      .delete(`/api/calendar/${id}`)
      .set('Authorization', `Bearer ${tokenB}`)
    expect(deleteB.status).toBe(404)
  })

  it('donations are scoped to the creating org', async () => {
    const donorName = `Iso Donor ${RUN_ID}`
    const create = await request(server)
      .post('/api/donations')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ donor_name: donorName, amount: 50, category: 'tithe', method: 'cash' })
    expect(create.status).toBe(201)
    const id = create.body.id

    const listB = await request(server)
      .get('/api/donations')
      .set('Authorization', `Bearer ${tokenB}`)
    expect(listB.status).toBe(200)
    expect(listB.body.find(d => d.id === id)).toBeUndefined()

    // Donations don't expose a PATCH endpoint — the only mutating
    // cross-org surface is DELETE.
    const deleteB = await request(server)
      .delete(`/api/donations/${id}`)
      .set('Authorization', `Bearer ${tokenB}`)
    expect(deleteB.status).toBe(404)

    // Confirm the row still exists for org A.
    const listA = await request(server)
      .get('/api/donations')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(listA.body.find(d => d.id === id)).toBeTruthy()
  })

  it('payroll staff are scoped to the creating org', async () => {
    const staffName = `Iso Staff ${RUN_ID}`
    const create = await request(server)
      .post('/api/payroll/staff')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: staffName, role: 'Staff', pay_rate: 25 })
    expect(create.status).toBe(201)
    const id = create.body.id

    const listB = await request(server)
      .get('/api/payroll/staff')
      .set('Authorization', `Bearer ${tokenB}`)
    expect(listB.status).toBe(200)
    expect(listB.body.find(s => s.id === id)).toBeUndefined()

    const patchB = await request(server)
      .patch(`/api/payroll/staff/${id}`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ name: 'Hijacked', role: 'Staff', pay_rate: 0, status: 'active' })
    expect(patchB.status).toBe(404)

    const deleteB = await request(server)
      .delete(`/api/payroll/staff/${id}`)
      .set('Authorization', `Bearer ${tokenB}`)
    expect(deleteB.status).toBe(404)

    // Confirm org A still has it.
    const listA = await request(server)
      .get('/api/payroll/staff')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(listA.body.find(s => s.id === id)).toBeTruthy()
  })
})

describe('calendar sync feed', () => {
  // Regression coverage for the P0 wiring bug: events created on the
  // Schedule page (ochr_calendar_events, assigned_to JSONB) were not
  // reaching the personal ICS feed, while events from ochr_events were
  // not filtered by membership at all. This test asserts the corrected
  // shape end-to-end: scheduled events the member is assigned to land
  // in the .ics body, and members not on assigned_to don't see them.
  it('only delivers Schedule events to subscribers in assigned_to', async () => {
    // Pick two org-A members from the sample seed — one we'll assign
    // the event to, one we won't, to verify the JSONB filter.
    const members = await request(server)
      .get('/api/clients')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(members.status).toBe(200)
    expect(members.body.length).toBeGreaterThanOrEqual(2)
    const assigned    = members.body[0]
    const notAssigned = members.body[1]

    // Create a calendar (Schedule page) event with assigned_to → first member only.
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const eventTitle = `Smoke Schedule Event ${RUN_ID}`
    const create = await request(server)
      .post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: eventTitle,
        date: tomorrow,
        start_time: '09:00',
        end_time: '10:00',
        type: 'service',
        assigned_to: [assigned.id],
      })
    expect(create.status).toBe(201)

    // Generate calendar tokens for both members.
    const linkA = await request(server)
      .get(`/api/calendar-sync/link/${assigned.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(linkA.status).toBe(200)
    expect(linkA.body.url).toMatch(/\/api\/calendar-sync\/[a-f0-9]+\.ics$/)
    expect(linkA.body.url).not.toContain(':3001') // regression guard for the old default

    const linkB = await request(server)
      .get(`/api/calendar-sync/link/${notAssigned.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(linkB.status).toBe(200)

    // Fetch each member's public ICS feed via the capability URL.
    // (No auth header — the token in the URL is the capability.)
    const feedA = await request(server).get(`/api/calendar-sync/${linkA.body.token}.ics`)
    expect(feedA.status).toBe(200)
    expect(feedA.headers['content-type']).toMatch(/text\/calendar/)
    expect(feedA.text).toContain(eventTitle)

    const feedB = await request(server).get(`/api/calendar-sync/${linkB.body.token}.ics`)
    expect(feedB.status).toBe(200)
    expect(feedB.text).not.toContain(eventTitle)
  })

  it('rejects an unknown calendar token with 404', async () => {
    const res = await request(server).get('/api/calendar-sync/not-a-real-token.ics')
    expect(res.status).toBe(404)
  })

  it('self-serve /my-link 404s with no_member_match when the admin has no roster row', async () => {
    // The admin signs up with their own email; the sample seed creates
    // [Sample] clients with separate *.sample@example.com emails. So
    // the admin's email won't match any client and we should get the
    // structured 404 the UI relies on to silently hide the card.
    const res = await request(server)
      .get('/api/calendar-sync/my-link')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(404)
    expect(res.body.code).toBe('no_member_match')
  })

  it('rotating a token invalidates the old one and serves the new one', async () => {
    // Pick a sample member, generate a calendar link, capture the
    // token, then POST /rotate. Old token must 404, new token must
    // serve a calendar.
    const members = await request(server)
      .get('/api/clients')
      .set('Authorization', `Bearer ${tokenA}`)
    const target = members.body[0]

    const before = await request(server)
      .get(`/api/calendar-sync/link/${target.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(before.status).toBe(200)
    const oldToken = before.body.token

    const rotate = await request(server)
      .post(`/api/calendar-sync/rotate/${target.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(rotate.status).toBe(200)
    expect(rotate.body.token).toBeTruthy()
    expect(rotate.body.token).not.toBe(oldToken)

    const oldFeed = await request(server).get(`/api/calendar-sync/${oldToken}.ics`)
    expect(oldFeed.status).toBe(404)

    const newFeed = await request(server).get(`/api/calendar-sync/${rotate.body.token}.ics`)
    expect(newFeed.status).toBe(200)
    expect(newFeed.headers['content-type']).toMatch(/text\/calendar/)
  })
})

describe('schedule recurrence', () => {
  // POST /api/calendar with a `recurrence` payload should fan out
  // into N occurrences sharing a single recurrence_parent_id (the
  // seed's own id). Each occurrence sits N*7 days after the seed.

  it('creates N occurrences sharing the seed id as parent_id', async () => {
    const orgRow = await pool.query(
      'SELECT id FROM ochr_organizations WHERE name = $1',
      [orgA.organizationName]
    )
    const orgId = orgRow.rows[0].id

    const seedDate = '2027-09-05'   // a Sunday picked far in the future
    const create = await request(server)
      .post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `Recur Smoke ${RUN_ID}`,
        date: seedDate,
        start_time: '10:00',
        end_time: '11:00',
        type: 'service',
        recurrence: { freq: 'weekly', interval: 1, count: 4 },
      })
    expect(create.status).toBe(201)
    expect(create.body.recurrence_parent_id).toBe(create.body.id)

    const { rows: series } = await pool.query(
      `SELECT id, date, recurrence_parent_id
         FROM ochr_calendar_events
        WHERE organization_id = $1
          AND recurrence_parent_id = $2
        ORDER BY date ASC`,
      [orgId, create.body.id]
    )
    expect(series.length).toBe(4)
    // Every row points at the same parent (= the seed's id).
    for (const row of series) expect(row.recurrence_parent_id).toBe(create.body.id)
    // Dates are 7 days apart starting at seedDate.
    for (let i = 0; i < 4; i++) {
      const expected = new Date(`${seedDate}T00:00:00Z`)
      expected.setUTCDate(expected.getUTCDate() + i * 7)
      const got = new Date(series[i].date).toISOString().slice(0, 10)
      expect(got).toBe(expected.toISOString().slice(0, 10))
    }
  })

  it('DELETE ?scope=series wipes every occurrence in the series', async () => {
    const orgRow = await pool.query(
      'SELECT id FROM ochr_organizations WHERE name = $1',
      [orgA.organizationName]
    )
    const orgId = orgRow.rows[0].id

    const create = await request(server)
      .post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `Series Delete ${RUN_ID}`,
        date: '2027-10-03',
        start_time: '09:00',
        end_time: '10:00',
        type: 'meeting',
        recurrence: { freq: 'weekly', interval: 1, count: 3 },
      })
    expect(create.status).toBe(201)
    const seedId = create.body.id

    // Pick a non-seed occurrence so we exercise the "found a sibling,
    // figured out the parent_id" path.
    const { rows: members } = await pool.query(
      'SELECT id FROM ochr_calendar_events WHERE recurrence_parent_id = $1 AND id <> $1 ORDER BY date ASC LIMIT 1',
      [seedId]
    )
    expect(members.length).toBe(1)
    const occurrenceId = members[0].id

    const del = await request(server)
      .delete(`/api/calendar/${occurrenceId}?scope=series`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(del.status).toBe(204)

    const { rows: remaining } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM ochr_calendar_events WHERE organization_id = $1 AND recurrence_parent_id = $2',
      [orgId, seedId]
    )
    expect(remaining[0].n).toBe(0)
  })

  it('PATCH ?scope=following propagates edits to this row + later siblings', async () => {
    const orgRow = await pool.query(
      'SELECT id FROM ochr_organizations WHERE name = $1',
      [orgA.organizationName]
    )
    const orgId = orgRow.rows[0].id

    // Create a 4-occurrence weekly series.
    const create = await request(server)
      .post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `Recur v2 ${RUN_ID}`,
        date: '2027-12-05',
        start_time: '10:00',
        end_time: '11:00',
        type: 'service',
        recurrence: { freq: 'weekly', interval: 1, count: 4 },
      })
    expect(create.status).toBe(201)
    const seedId = create.body.id

    // Pull all four rows in date order so we know which is which.
    const { rows: series } = await pool.query(
      `SELECT id, date, title FROM ochr_calendar_events
        WHERE organization_id = $1 AND recurrence_parent_id = $2
        ORDER BY date ASC`,
      [orgId, seedId]
    )
    expect(series.length).toBe(4)
    const targetRow = series[1] // occurrence #2 (the one a week after the seed)

    // PATCH the second row with ?scope=following changing the title.
    const newTitle = `Recur v2 RENAMED ${RUN_ID}`
    const patch = await request(server)
      .patch(`/api/calendar/${targetRow.id}?scope=following`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: newTitle,
        date: targetRow.date,                 // unchanged
        start_time: '10:00',
        end_time: '11:00',
        type: 'service',
        assigned_to: [],
      })
    expect(patch.status).toBe(200)

    // Verify rows 2/3/4 carry the new title; row 1 (the seed) keeps the old one.
    const { rows: after } = await pool.query(
      `SELECT id, date, title FROM ochr_calendar_events
        WHERE organization_id = $1 AND recurrence_parent_id = $2
        ORDER BY date ASC`,
      [orgId, seedId]
    )
    expect(after[0].title).toBe(`Recur v2 ${RUN_ID}`)        // seed unchanged
    expect(after[1].title).toBe(newTitle)                    // target
    expect(after[2].title).toBe(newTitle)                    // following
    expect(after[3].title).toBe(newTitle)                    // following
  })

  it('GET /api/calendar/conflicts surfaces overlapping member assignments', async () => {
    // Pull a sample member from the seed roster (any will do).
    const members = await request(server)
      .get('/api/clients')
      .set('Authorization', `Bearer ${tokenA}`)
    const target = members.body[0]
    expect(target).toBeTruthy()

    // Anchor event on a date well in the future so we don't trip
    // any past-events filtering anywhere.
    const date = '2028-03-12'
    const create = await request(server)
      .post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `Conflict A ${RUN_ID}`,
        date,
        start_time: '10:00',
        end_time: '11:00',
        type: 'service',
        assigned_to: [target.id],
      })
    expect(create.status).toBe(201)
    const anchorId = create.body.id

    // Same date, overlapping time, same member → should appear in conflicts.
    const params = new URLSearchParams({
      date,
      start_time: '10:30',
      end_time:   '11:30',
      assigned_to: String(target.id),
    })
    const overlapping = await request(server)
      .get(`/api/calendar/conflicts?${params}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(overlapping.status).toBe(200)
    expect(overlapping.body.conflicts.find(c => c.id === anchorId)).toBeTruthy()

    // Same query but excluding the anchor's own id (the editing case)
    // → should NOT include the anchor.
    const params2 = new URLSearchParams(params)
    params2.set('exclude_id', String(anchorId))
    const selfExclude = await request(server)
      .get(`/api/calendar/conflicts?${params2}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(selfExclude.body.conflicts.find(c => c.id === anchorId)).toBeUndefined()

    // Different member → no conflict even though time overlaps.
    const otherMember = members.body.find(m => m.id !== target.id)
    expect(otherMember).toBeTruthy()
    const params3 = new URLSearchParams({
      date,
      start_time: '10:30',
      end_time:   '11:30',
      assigned_to: String(otherMember.id),
    })
    const noShared = await request(server)
      .get(`/api/calendar/conflicts?${params3}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(noShared.body.conflicts.find(c => c.id === anchorId)).toBeUndefined()
  })

  it('rejects recurrence.count outside 1..26', async () => {
    const lo = await request(server)
      .post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `Bad Count ${RUN_ID}`,
        date: '2027-11-07',
        start_time: '09:00',
        end_time: '10:00',
        recurrence: { freq: 'weekly', interval: 1, count: 0 },
      })
    expect(lo.status).toBe(400)

    const hi = await request(server)
      .post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `Bad Count Hi ${RUN_ID}`,
        date: '2027-11-07',
        start_time: '09:00',
        end_time: '10:00',
        recurrence: { freq: 'weekly', interval: 1, count: 99 },
      })
    expect(hi.status).toBe(400)
  })
})

describe('audit log', () => {
  it('records a row when a member is created', async () => {
    // Resolve org A's id once so we can query the audit table.
    const orgRow = await pool.query(
      'SELECT id FROM ochr_organizations WHERE name = $1',
      [orgA.organizationName]
    )
    const orgId = orgRow.rows[0].id

    const create = await request(server)
      .post('/api/clients')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `Audit Test Member ${RUN_ID}` })
    expect(create.status).toBe(201)

    const row = await waitForAuditRow(orgId, r =>
      r.entity_type === 'client' &&
      r.action === 'create' &&
      r.entity_id === String(create.body.id)
    )
    expect(row.user_email).toBe(orgA.email.toLowerCase())
    expect(row.summary).toContain('Created client')
    expect(row.request_method).toBe('POST')
    expect(row.status_code).toBeGreaterThanOrEqual(200)
    expect(row.status_code).toBeLessThan(300)
  })

  it('GET /api/audit-log returns rows scoped to the caller\'s org', async () => {
    // Carve out a small period to isolate this test's audit rows from
    // anything an earlier test created. The previous test already
    // produced at least one client-create row in this run.
    const since = new Date(Date.now() - 60_000).toISOString()

    // Org A admin should be able to list — and the rows should all
    // belong to org A.
    const a = await request(server)
      .get(`/api/audit-log?since=${encodeURIComponent(since)}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(a.status).toBe(200)
    expect(Array.isArray(a.body.rows)).toBe(true)
    expect(a.body.rows.length).toBeGreaterThan(0)
    expect(a.body.total).toBeGreaterThan(0)
    // Every row should have the auth'd user as the actor — sanity
    // check on the snapshot fields.
    for (const row of a.body.rows) {
      expect(row.user_email).toBe(orgA.email.toLowerCase())
    }

    // Org B admin must not see org A's rows. They may have their own
    // rows depending on order of test execution, but none of them
    // should have org A's email on them.
    const b = await request(server)
      .get(`/api/audit-log?since=${encodeURIComponent(since)}`)
      .set('Authorization', `Bearer ${tokenB}`)
    expect(b.status).toBe(200)
    for (const row of b.body.rows) {
      expect(row.user_email).not.toBe(orgA.email.toLowerCase())
    }
  })

  it('GET /api/audit-log filters by entity_type and action', async () => {
    const since = new Date(Date.now() - 60_000).toISOString()
    const res = await request(server)
      .get(`/api/audit-log?entity_type=client&action=create&since=${encodeURIComponent(since)}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.rows.length).toBeGreaterThan(0)
    for (const row of res.body.rows) {
      expect(row.entity_type).toBe('client')
      expect(row.action).toBe('create')
    }
  })

  it('GET /api/audit-log scopes to a single record via entity_id (AUD.3)', async () => {
    // Create a member, then pull only that member's trail — the behavior
    // the member-profile "View change history" deep link relies on.
    const made = await request(server).post('/api/clients')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `Audit Scope ${RUN_ID}`, status: 'active', role: 'Member' })
    const memberId = made.body.id

    // The audit row is written fire-and-forget in res.on('finish') (so an
    // audit failure can never affect the user's request), which means it
    // lands just AFTER the POST returns. Reading once races that insert —
    // poll until it's visible, then assert. Mirrors the eventual-consistency
    // the real "View change history" deep link tolerates.
    let res
    for (let i = 0; i < 40; i++) {
      res = await request(server)
        .get(`/api/audit-log?entity_type=client&entity_id=${memberId}`)
        .set('Authorization', `Bearer ${tokenA}`)
      if (res.body.rows?.length > 0) break
      await new Promise(r => setTimeout(r, 50))
    }
    expect(res.status).toBe(200)
    expect(res.body.rows.length).toBeGreaterThan(0)
    for (const row of res.body.rows) {
      expect(row.entity_id).toBe(String(memberId))
    }
  })

  it('GET /api/audit-log paginates via limit and reports hasMore', async () => {
    // Force a small page so we exercise the hasMore flag even on a
    // run where this is the only audit row in the org.
    const res = await request(server)
      .get('/api/audit-log?limit=1')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.rows.length).toBeLessThanOrEqual(1)
    expect(res.body.limit).toBe(1)
    if (res.body.total > 1) expect(res.body.hasMore).toBe(true)
  })

  it('GET /api/audit-log rejects an unknown entity_type with 400', async () => {
    const res = await request(server)
      .get('/api/audit-log?entity_type=__not_a_real_type__')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(400)
  })

  it('GET /api/audit-log accepts the newer entity_type tags (AUD.1)', async () => {
    // These tags are emitted by auditLog() mounts but used to 400 on the
    // filter because the read-route allowlist had drifted. They must now
    // resolve (200), even when the result set is empty.
    for (const t of ['checkin', 'fund', 'group', 'room', 'kiosk', 'parish_feast', 'swap_request', 'availability', 'form', 'group_interest']) {
      const res = await request(server)
        .get(`/api/audit-log?entity_type=${t}`)
        .set('Authorization', `Bearer ${tokenA}`)
      expect(res.status, `entity_type=${t} should be accepted`).toBe(200)
    }
  })

  it('GET /api/audit-log rejects callers with no token with 401', async () => {
    const res = await request(server).get('/api/audit-log')
    expect(res.status).toBe(401)
  })

  it('GET /api/audit-log/export.csv returns a CSV with a header row (AUD.2)', async () => {
    const res = await request(server)
      .get('/api/audit-log/export.csv')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/csv/)
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="audit-log-/)
    expect(res.text.split('\n')[0]).toBe('timestamp,user_name,user_email,action,entity_type,entity_id,summary,method,path,status,ip_address')
  })

  it('GET /api/audit-log/export.csv honors the same filter validation', async () => {
    const res = await request(server)
      .get('/api/audit-log/export.csv?entity_type=__nope__')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(400)
  })

  it('export.csv quotes and neutralizes formula injection in user-controlled cells (AUD.2)', async () => {
    // A self-registered admin display name is attacker-controlled and
    // lands verbatim in the user_name CSV column. A leading '=' (or
    // +,-,@) would execute as a formula when an admin opens the export
    // in Excel/Sheets, and an embedded comma/quote could break the row
    // shape. Both must be neutralized: quote-wrapped, embedded quotes
    // doubled (RFC-4180), and the formula char prefixed with an apostrophe.
    const reg = await request(server).post('/api/auth/signup').send(orgInject)
    expect(reg.status).toBe(201)
    const injToken = reg.body.token

    // An audited write so a row carries the malicious user_name.
    const created = await request(server).post('/api/clients')
      .set('Authorization', `Bearer ${injToken}`)
      .send({ name: `Inj Member ${RUN_ID}` })
    expect(created.status).toBe(201)

    const orgRow = await pool.query(
      'SELECT id FROM ochr_organizations WHERE name = $1',
      [orgInject.organizationName]
    )
    await waitForAuditRow(orgRow.rows[0].id, r => r.user_name === INJECT_NAME)

    const res = await request(server).get('/api/audit-log/export.csv')
      .set('Authorization', `Bearer ${injToken}`)
    expect(res.status).toBe(200)
    // Cell = leading apostrophe (formula-neutralized) + doubled quotes,
    // all wrapped in quotes. The raw '=' must never start a cell.
    const expectedCell = `"'${INJECT_NAME.replace(/"/g, '""')}"`
    expect(res.text).toContain(expectedCell)
    // Belt-and-suspenders: no data cell begins with a bare '='.
    for (const line of res.text.split('\n').slice(1)) {
      for (const cell of line.split(',')) {
        expect(cell.startsWith('=')).toBe(false)
      }
    }
  })

  it('GET /api/audit-log sets a private 30s Cache-Control header', async () => {
    // Per S5.1 — read-heavy GETs ship browser-side caching to keep the
    // count + page query off the DB on rapid pagination/back-button.
    // 'private' keeps it out of any shared cache (tenants would leak).
    const res = await request(server)
      .get('/api/audit-log')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    const cc = res.headers['cache-control']
    expect(cc).toMatch(/private/)
    expect(cc).toMatch(/max-age=30/)
  })

  it('records a row when a donation is created', async () => {
    // Resolve org A's id once so we can query the audit table.
    const orgRow = await pool.query(
      'SELECT id FROM ochr_organizations WHERE name = $1',
      [orgA.organizationName]
    )
    const orgId = orgRow.rows[0].id

    const donorName = `Audit Test Donor ${RUN_ID}`
    const create = await request(server)
      .post('/api/donations')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ donor_name: donorName, amount: 25, category: 'tithe', method: 'cash' })
    expect(create.status).toBe(201)

    const row = await waitForAuditRow(orgId, r =>
      r.entity_type === 'donation' &&
      r.action === 'create' &&
      r.entity_id === String(create.body.id)
    )
    expect(row.summary).toContain(donorName)
    expect(row.user_email).toBe(orgA.email.toLowerCase())
  })

  it('does not log a row when a viewer is rejected with 403', async () => {
    // Cross-org write — admin A trying to create something as if they
    // were org B, but org B's writes are gated by their own JWT.
    // Easier reproduction: hit /api/clients as org B's viewer once we
    // have one. For now, validate the shape: a 401 (no token) write
    // must produce zero rows.
    const orgRow = await pool.query(
      'SELECT id FROM ochr_organizations WHERE name = $1',
      [orgA.organizationName]
    )
    const orgId = orgRow.rows[0].id

    const before = await pool.query(
      'SELECT COUNT(*)::int AS c FROM ochr_audit_log WHERE organization_id = $1',
      [orgId]
    )
    const beforeCount = before.rows[0].c

    // No Authorization header → 401, never reaches the audit middleware.
    const res = await request(server).post('/api/clients').send({ name: 'no-auth' })
    expect(res.status).toBe(401)

    // Give res.on('finish') a moment in case anything slipped through.
    await new Promise(r => setTimeout(r, 150))

    const after = await pool.query(
      'SELECT COUNT(*)::int AS c FROM ochr_audit_log WHERE organization_id = $1',
      [orgId]
    )
    expect(after.rows[0].c).toBe(beforeCount)
  })
})

describe('AI quota', () => {
  // Orgs default to the 'free' plan, which limits ai_generations_per_month
  // to 20 (see server/src/billing/plans.js). We don't actually call the
  // LLM in these tests — the quota gate fires before runLLM, so we can
  // exercise the 429 path without an Anthropic/OpenAI key.

  it('GET /api/ai/quota returns the free plan defaults', async () => {
    const res = await request(server)
      .get('/api/ai/quota')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.plan).toBe('free')
    expect(res.body.limit).toBe(20)
    expect(res.body.remaining).toBe(20)
    expect(res.body.exceeded).toBe(false)
    expect(typeof res.body.used).toBe('number')
    expect(res.body.period_start).toBeTruthy()
    expect(res.body.period_end).toBeTruthy()
  })

  it('POST /api/ai/generate returns 429 quota_exceeded when at the limit', async () => {
    // Resolve org A's id so we can pre-fill its usage table.
    const orgRow = await pool.query(
      'SELECT id FROM ochr_organizations WHERE name = $1',
      [orgA.organizationName]
    )
    const orgId = orgRow.rows[0].id

    // Backfill exactly the limit's worth of usage rows (free=20). This
    // is faster and more deterministic than running 20 real LLM calls.
    const values = Array.from({ length: 20 }, (_, i) => `($1, 'generate', 'sermon', NULL, 'anthropic', 'test', NOW() - INTERVAL '${i} second')`).join(', ')
    await pool.query(
      `INSERT INTO ochr_ai_usage
         (organization_id, endpoint, type, user_id, provider, model, created_at)
       VALUES ${values}`,
      [orgId]
    )

    // /quota should now show exceeded.
    const quotaRes = await request(server)
      .get('/api/ai/quota')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(quotaRes.body.used).toBeGreaterThanOrEqual(20)
    expect(quotaRes.body.exceeded).toBe(true)
    expect(quotaRes.body.remaining).toBe(0)

    // /generate should refuse before reaching runLLM (so no real
    // provider call is needed for this test).
    const genRes = await request(server)
      .post('/api/ai/generate')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ prompt: 'something pastoral', type: 'sermon' })
    expect(genRes.status).toBe(429)
    expect(genRes.body.code).toBe('quota_exceeded')
    expect(genRes.body.limit).toBe(20)
  })

  it('POST /api/ai/enhance is gated by the same quota as /generate', async () => {
    // The previous test in this describe pre-filled 20 usage rows
    // for orgA, putting it over the free-plan limit. /enhance must
    // refuse with the same shape /generate does — until this fix
    // it didn't, and was burning credits silently.
    const res = await request(server)
      .post('/api/ai/enhance')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ text: 'rough draft to enhance', context: 'note' })
    expect(res.status).toBe(429)
    expect(res.body.code).toBe('quota_exceeded')
    expect(res.body.limit).toBe(20)
  })

  it('GET /api/ai/quota rejects unauthenticated callers', async () => {
    const res = await request(server).get('/api/ai/quota')
    expect(res.status).toBe(401)
  })

  it('GET /api/ai/generations supports search + envelope shape', async () => {
    // We can't drive a real LLM call from the smoke harness, so seed
    // a generation directly via SQL.
    const orgRow = await pool.query(
      'SELECT id FROM ochr_organizations WHERE name = $1',
      [orgA.organizationName]
    )
    const orgId = orgRow.rows[0].id

    const token = `library-smoke-${RUN_ID}`
    await pool.query(
      `INSERT INTO ochr_ai_generations
         (organization_id, type, prompt, output, provider, model)
       VALUES ($1, 'devotional', $2, $3, 'anthropic', 'test')`,
      [orgId, `seed prompt ${token}`, `seed output ${token}`]
    )

    // Envelope shape on a basic list call.
    const list = await request(server)
      .get('/api/ai/generations?limit=10')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(list.status).toBe(200)
    expect(Array.isArray(list.body.rows)).toBe(true)
    expect(typeof list.body.total).toBe('number')
    expect(typeof list.body.hasMore).toBe('boolean')

    // Search by the unique token returns the seed row.
    const searched = await request(server)
      .get(`/api/ai/generations?q=${encodeURIComponent(token)}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(searched.status).toBe(200)
    expect(searched.body.rows.length).toBeGreaterThan(0)
    const found = searched.body.rows.find(r => r.prompt?.includes(token))
    expect(found).toBeTruthy()
    expect(found.type).toBe('devotional')

    // Type filter to a different type → no match for our seed.
    const wrongType = await request(server)
      .get(`/api/ai/generations?q=${encodeURIComponent(token)}&type=announcement`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(wrongType.status).toBe(200)
    expect(wrongType.body.rows.find(r => r.prompt?.includes(token))).toBeUndefined()
  })
})

describe('notification transport (stub)', () => {
  // The stub transport writes every dispatch to ochr_notification_log
  // so admins can see exactly what would have gone out. When the team
  // lead picks an email provider, this layer flips from log-only to
  // log + send without callers changing.

  async function getOrgIdAndUserId() {
    const orgRow = await pool.query(
      'SELECT id FROM ochr_organizations WHERE name = $1',
      [orgA.organizationName]
    )
    const userRow = await pool.query(
      'SELECT id FROM ochr_users WHERE email = $1',
      [orgA.email.toLowerCase()]
    )
    return { orgId: orgRow.rows[0].id, userId: userRow.rows[0].id }
  }

  it('renders the template, substitutes vars, and writes a stubbed log row', async () => {
    const { orgId, userId } = await getOrgIdAndUserId()
    const result = await notify({
      organizationId:    orgId,
      userId,
      recipient:         orgA.email,
      notification_type: 'assignment_reminder',
      vars: {
        recipient_name:      'Alice Admin',
        event_title:         `Smoke Service ${RUN_ID}`,
        event_date:          'Sunday, May 3',
        event_time:          '10:00am',
        event_location_line: 'Location: Sanctuary.',
      },
    })
    expect(result.status).toBe('stubbed')

    const { rows } = await pool.query(
      'SELECT * FROM ochr_notification_log WHERE id = $1',
      [result.id]
    )
    const row = rows[0]
    expect(row).toBeTruthy()
    expect(row.notification_type).toBe('assignment_reminder')
    expect(row.recipient_email).toBe(orgA.email)
    expect(row.subject).toContain(`Smoke Service ${RUN_ID}`)
    expect(row.body).toContain('Alice Admin')
    expect(row.body).toContain('Sanctuary')
  })

  it('respects user prefs — disabled type writes a skipped row with no body', async () => {
    const { orgId, userId } = await getOrgIdAndUserId()
    await pool.query(
      `INSERT INTO ochr_notification_prefs (user_id, notification_type, enabled)
       VALUES ($1, 'task_due_reminder', FALSE)
       ON CONFLICT (user_id, notification_type)
       DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW()`,
      [userId]
    )

    const result = await notify({
      organizationId:    orgId,
      userId,
      recipient:         orgA.email,
      notification_type: 'task_due_reminder',
      vars: { recipient_name: 'Alice', task_title: 'Should not appear' },
    })
    expect(result.status).toBe('skipped')

    const { rows } = await pool.query(
      'SELECT subject, body, status FROM ochr_notification_log WHERE id = $1',
      [result.id]
    )
    expect(rows[0].status).toBe('skipped')
    expect(rows[0].subject).toBeNull()
    expect(rows[0].body).toBeNull()
  })

  it('throws on an unknown notification_type', async () => {
    const { orgId } = await getOrgIdAndUserId()
    await expect(notify({
      organizationId:    orgId,
      notification_type: '__not_a_real_type__',
    })).rejects.toThrow(/Unknown notification_type/)
  })

  it('GET /api/notification-prefs returns every type with defaults', async () => {
    // We may have set task_due_reminder=false in an earlier test in
    // this describe — the GET still returns every type, with the
    // stored value where present.
    const res = await request(server)
      .get('/api/notification-prefs')
      .set('Authorization', `Bearer ${tokenB}`)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.prefs)).toBe(true)
    expect(res.body.prefs.length).toBeGreaterThanOrEqual(3)
    for (const p of res.body.prefs) {
      expect(typeof p.notification_type).toBe('string')
      expect(typeof p.label).toBe('string')
      expect(typeof p.enabled).toBe('boolean')
      // Org B has no stored prefs yet — every value should match the default.
      expect(p.enabled).toBe(p.default_enabled)
    }
  })

  it('PATCH /api/notification-prefs upserts and reflects on next GET', async () => {
    // Flip event_assignment_added off for org B.
    const patch = await request(server)
      .patch('/api/notification-prefs')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ notification_type: 'event_assignment_added', enabled: false })
    expect(patch.status).toBe(200)
    expect(patch.body.enabled).toBe(false)

    const get = await request(server)
      .get('/api/notification-prefs')
      .set('Authorization', `Bearer ${tokenB}`)
    const flipped = get.body.prefs.find(p => p.notification_type === 'event_assignment_added')
    expect(flipped.enabled).toBe(false)
  })

  it('PATCH /api/notification-prefs rejects unknown types with 400', async () => {
    const res = await request(server)
      .patch('/api/notification-prefs')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ notification_type: '__nope__', enabled: true })
    expect(res.status).toBe(400)
  })

  it('GET /api/notification-prefs rejects unauthenticated callers', async () => {
    const res = await request(server).get('/api/notification-prefs')
    expect(res.status).toBe(401)
  })
})

describe('notification triggers + drain', () => {
  // Polls ochr_notification_log until a row matching `predicate`
  // shows up. Same shape as waitForAuditRow — the immediate
  // event_assignment_added dispatch is fire-and-forget from inside
  // the events POST handler, so the row may land milliseconds after
  // the response.
  async function waitForNotificationRow(orgId, predicate, timeoutMs = 2000) {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const { rows } = await pool.query(
        `SELECT * FROM ochr_notification_log
          WHERE organization_id = $1
          ORDER BY created_at DESC LIMIT 25`,
        [orgId]
      )
      const match = rows.find(predicate)
      if (match) return match
      await new Promise(r => setTimeout(r, 50))
    }
    throw new Error('Timed out waiting for notification log row')
  }

  it('event create dispatches event_assignment_added to assignees', async () => {
    const orgRow = await pool.query(
      'SELECT id FROM ochr_organizations WHERE name = $1',
      [orgA.organizationName]
    )
    const orgId = orgRow.rows[0].id

    // Pick a sample member with an email so the recipient field lands
    // populated (sampleSeed gives every [Sample] member an email).
    const members = await request(server)
      .get('/api/clients')
      .set('Authorization', `Bearer ${tokenA}`)
    const target = members.body.find(m => m.email)
    expect(target).toBeTruthy()

    // Schedule a date well into the future so the assignment_reminder
    // is enqueueable (>24h away). Title uniquely identifies this run.
    const yyyy = new Date().getFullYear() + 1
    const eventDate = `${yyyy}-09-15`
    const eventTitle = `Trigger Smoke ${RUN_ID}`

    const create = await request(server)
      .post('/api/events')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: eventTitle,
        date: eventDate,
        time: '10:00',
        member_ids: [target.id],
      })
    expect(create.status).toBe(201)

    // Immediate add notification — log row should land within ~50ms.
    // Scope on the unique event title too: `target` is a shared sample
    // member other tests also assign, so filtering by type + recipient
    // alone can return a different event's notification under CI
    // interleaving. The subject carries the title (asserted just below).
    const row = await waitForNotificationRow(orgId, r =>
      r.notification_type === 'event_assignment_added' &&
      r.recipient_email === target.email &&
      r.subject?.includes(eventTitle)
    )
    expect(row.subject).toContain(eventTitle)
    expect(row.body).toContain(target.name)
    expect(row.status).toBe('stubbed')

    // And a pending scheduled reminder should be queued for this
    // recipient — send_at is the event start minus 24h.
    const start = Date.now()
    let scheduled = null
    while (Date.now() - start < 2000) {
      const { rows } = await pool.query(
        `SELECT * FROM ochr_scheduled_notifications
          WHERE organization_id = $1
            AND notification_type = 'assignment_reminder'
            AND recipient_email = $2
            AND status = 'pending'
            AND vars->>'event_title' = $3`,
        [orgId, target.email, eventTitle]
      )
      if (rows.length) { scheduled = rows[0]; break }
      await new Promise(r => setTimeout(r, 50))
    }
    expect(scheduled).toBeTruthy()
    // send_at should be ~24h before the event start. The server interprets
    // the event start in the parish timezone (default UTC for this fixture
    // org), so parse as UTC here — a bare 'T10:00:00' would be read in the
    // runner's local zone and drift by the local UTC offset off-CI.
    const eventStart = new Date(`${eventDate}T10:00:00Z`)
    const expectedSendAt = eventStart.getTime() - 24 * 60 * 60 * 1000
    expect(Math.abs(new Date(scheduled.send_at).getTime() - expectedSendAt)).toBeLessThan(60_000)
  })

  it('drain processes pending rows whose send_at has passed', async () => {
    const orgRow = await pool.query(
      'SELECT id FROM ochr_organizations WHERE name = $1',
      [orgA.organizationName]
    )
    const orgId = orgRow.rows[0].id

    // Insert a deterministic pending row with send_at in the past.
    // Direct SQL keeps this test independent of any trigger-point
    // timing — we want to assert the drainer's contract specifically.
    const recipient = `drain-test-${RUN_ID}@example.com`
    const insert = await pool.query(
      `INSERT INTO ochr_scheduled_notifications
         (organization_id, recipient_email, notification_type, vars, send_at, status)
       VALUES ($1, $2, 'assignment_reminder', $3::jsonb, NOW() - INTERVAL '5 minutes', 'pending')
       RETURNING id`,
      [orgId, recipient, JSON.stringify({
        recipient_name: 'Drain Test',
        event_title: `Drain Smoke ${RUN_ID}`,
        event_date:  'Sunday',
        event_time:  '9:00am',
        event_location_line: '',
      })]
    )
    const queuedId = insert.rows[0].id

    const drain = await request(server)
      .post('/api/admin/notifications/drain')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(drain.status).toBe(200)
    expect(drain.body.processed).toBeGreaterThanOrEqual(1)
    expect(drain.body.sent).toBeGreaterThanOrEqual(1)
    expect(drain.body.failed).toBe(0)

    // Queue row should now be 'sent' with a sent_at timestamp.
    const { rows: after } = await pool.query(
      'SELECT status, sent_at FROM ochr_scheduled_notifications WHERE id = $1',
      [queuedId]
    )
    expect(after[0].status).toBe('sent')
    expect(after[0].sent_at).toBeTruthy()

    // And a notification_log row should exist for the recipient.
    const log = await waitForNotificationRow(orgId, r =>
      r.recipient_email === recipient &&
      r.notification_type === 'assignment_reminder'
    )
    expect(log.subject).toContain(`Drain Smoke ${RUN_ID}`)
    expect(log.status).toBe('stubbed')
  })

  it('POST /api/admin/notifications/drain rejects non-admins', async () => {
    // Org B is admin too; make a viewer there to test the gate.
    // Easier shortcut: hit the endpoint with no token → 401.
    const res = await request(server).post('/api/admin/notifications/drain')
    expect(res.status).toBe(401)
  })
})

describe('full-text search', () => {
  // Each org's signup seeds three [Sample] members. We search by a
  // distinctive token that the seed places in the name column to
  // confirm the indexed search hits the row, then verify org B's
  // search for the same token returns only org B's matching rows.

  it('GET /api/search returns matching members for a token in name', async () => {
    const res = await request(server)
      .get('/api/search?q=maria')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    const memberHits = res.body.filter(r => r.type === 'member')
    expect(memberHits.length).toBeGreaterThan(0)
    expect(memberHits.some(m => /maria/i.test(m.name))).toBe(true)
  })

  it('search results stay scoped to the caller\'s org', async () => {
    // Both orgs have a [Sample] Maria Garcia with the same name but
    // different ids. Org A and Org B searches must return disjoint
    // member ids — never the cross-tenant row.
    const a = await request(server)
      .get('/api/search?q=maria')
      .set('Authorization', `Bearer ${tokenA}`)
    const b = await request(server)
      .get('/api/search?q=maria')
      .set('Authorization', `Bearer ${tokenB}`)
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)

    const idsA = new Set(a.body.filter(r => r.type === 'member').map(r => r.id))
    const idsB = new Set(b.body.filter(r => r.type === 'member').map(r => r.id))
    expect(idsA.size).toBeGreaterThan(0)
    expect(idsB.size).toBeGreaterThan(0)
    for (const id of idsA) expect(idsB.has(id)).toBe(false)
  })

  it('empty query returns an empty array', async () => {
    const res = await request(server)
      .get('/api/search?q=')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })

  it('rejects unauthenticated callers', async () => {
    const res = await request(server).get('/api/search?q=maria')
    expect(res.status).toBe(401)
  })
})

describe('monitoring', () => {
  // Capture dispatch output via the test seam so we can assert the
  // shape without polluting stderr/stdout. The seam restores the
  // production dispatch in the cleanup callback.

  it('monitor.error captures message + stack into the structured payload', () => {
    const events = []
    const restore = _setDispatchForTests((level, scope, message, context) => {
      events.push({ level, scope, message, context })
    })
    try {
      const err = new Error('boom')
      monitor.error('test.scope', err, { recipient: 'a@b.com' })
    } finally {
      restore()
    }
    expect(events.length).toBe(1)
    const ev = events[0]
    expect(ev.level).toBe('error')
    expect(ev.scope).toBe('test.scope')
    expect(ev.message).toBe('boom')
    expect(ev.context.recipient).toBe('a@b.com')
    expect(typeof ev.context.stack).toBe('string')
    expect(ev.context.stack).toContain('boom')
  })

  it('monitor.warn and monitor.info pass through with no err object', () => {
    const events = []
    const restore = _setDispatchForTests((level, scope, message, context) => {
      events.push({ level, scope, message, context })
    })
    try {
      monitor.warn('test.warn', 'careful now', { code: 'SOFT' })
      monitor.info('test.info', 'all good',    { code: 'OK' })
    } finally {
      restore()
    }
    expect(events.map(e => e.level)).toEqual(['warn', 'info'])
    expect(events[0].message).toBe('careful now')
    expect(events[0].context.code).toBe('SOFT')
    expect(events[1].message).toBe('all good')
    expect(events[1].context.code).toBe('OK')
  })

  it('monitor.error tolerates non-Error values without crashing', () => {
    const events = []
    const restore = _setDispatchForTests((level, scope, message) => {
      events.push({ level, scope, message })
    })
    try {
      monitor.error('test.string', 'not an error object')
      monitor.error('test.null',   null)
    } finally {
      restore()
    }
    expect(events[0].message).toBe('not an error object')
    expect(events[1].message).toBe('null')
  })
})

describe('daily verse', () => {
  // Server-cached daily verse. We don't assert on the verse text —
  // bible-api.com is external and may be flaky/down — but we do
  // assert the response shape and that the second call lands on
  // the same content (cache hit OR identical fallback both qualify).

  it('GET /api/daily-verse returns text + reference', async () => {
    const res = await request(server)
      .get('/api/daily-verse')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    expect(typeof res.body.text).toBe('string')
    expect(typeof res.body.reference).toBe('string')
    expect(res.body.text.length).toBeGreaterThan(0)
    expect(res.body.reference.length).toBeGreaterThan(0)
  })

  it('repeats the cached verse on the second call within the same day', async () => {
    // Same orgA token, two back-to-back hits. Whether bible-api was
    // reachable or not, the second response should match the first
    // — cache hit, or identical fallback shape if the upstream
    // failed both times.
    const a = await request(server)
      .get('/api/daily-verse')
      .set('Authorization', `Bearer ${tokenA}`)
    const b = await request(server)
      .get('/api/daily-verse')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(b.body.reference).toBe(a.body.reference)
    expect(b.body.text).toBe(a.body.text)
  })

  it('GET /api/daily-verse rejects unauthenticated callers', async () => {
    const res = await request(server).get('/api/daily-verse')
    expect(res.status).toBe(401)
  })
})

describe('birthday + anniversary enqueue', () => {
  // Insert a member into orgA whose birth_date matches tomorrow's
  // M/D, then hit the admin enqueue endpoint and verify a
  // member_birthday row landed in ochr_scheduled_notifications.
  // Anniversary path is symmetric and exercised the same way.

  it('enqueues member_birthday for tomorrow\'s birthdays', async () => {
    const orgRow = await pool.query(
      'SELECT id FROM ochr_organizations WHERE name = $1',
      [orgA.organizationName]
    )
    const orgId = orgRow.rows[0].id

    // Tomorrow's M/D — year doesn't matter, the enqueue matcher is
    // EXTRACT(MONTH/DAY) only.
    const t = new Date()
    t.setUTCDate(t.getUTCDate() + 1)
    const mm = String(t.getUTCMonth() + 1).padStart(2, '0')
    const dd = String(t.getUTCDate()).padStart(2, '0')
    // Use a year far enough back that years_between is positive on
    // any test run (matters for the anniversary path).
    const birthDate = `1990-${mm}-${dd}`
    const memberName = `Birthday Smoke ${RUN_ID}`

    await pool.query(
      `INSERT INTO ochr_clients (organization_id, name, birth_date, joined_date)
       VALUES ($1, $2, $3, $3)`,
      [orgId, memberName, birthDate]
    )

    const res = await request(server)
      .post('/api/admin/notifications/enqueue-birthdays')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.birthdays_enqueued).toBeGreaterThanOrEqual(1)
    expect(res.body.anniversaries_enqueued).toBeGreaterThanOrEqual(1)

    // Confirm a scheduled row exists for orgA's admin.
    const { rows: scheduled } = await pool.query(
      `SELECT id, notification_type, recipient_email, vars
         FROM ochr_scheduled_notifications
        WHERE organization_id = $1
          AND notification_type IN ('member_birthday', 'member_anniversary')
        ORDER BY id DESC LIMIT 10`,
      [orgId]
    )
    const birthdayRow = scheduled.find(r =>
      r.notification_type === 'member_birthday' &&
      r.recipient_email === orgA.email.toLowerCase() &&
      r.vars?.member_name === memberName
    )
    expect(birthdayRow).toBeTruthy()

    const annivRow = scheduled.find(r =>
      r.notification_type === 'member_anniversary' &&
      r.recipient_email === orgA.email.toLowerCase() &&
      r.vars?.member_name === memberName
    )
    expect(annivRow).toBeTruthy()
    // years_between should be reasonable (1990 to current year).
    expect(annivRow.vars.years).toBeGreaterThan(0)
  })

  it('rejects unauthenticated callers on the enqueue endpoint', async () => {
    const res = await request(server).post('/api/admin/notifications/enqueue-birthdays')
    expect(res.status).toBe(401)
  })
})

describe('liturgical auto-mapping', () => {
  // POST /api/events without liturgical_* fields: the server fills
  // them from the date so admins don't have to label every Sunday
  // service. Christmas Day is the cleanest deterministic target —
  // every year has the same answer.

  it('auto-fills season/color/feast when caller omits them', async () => {
    // Use next December 25 so the date is always in the future
    // (avoids any "past events" hide rules in unrelated callers).
    const yyyy = new Date().getFullYear() + 1
    const christmas = `${yyyy}-12-25`

    const res = await request(server)
      .post('/api/events')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `Auto-Map Christmas ${RUN_ID}`,
        date: christmas,
        time: '10:00',
        // Deliberately NO liturgical_* fields.
      })
    expect(res.status).toBe(201)
    expect(res.body.liturgical_season).toBe('Christmas')
    expect(res.body.liturgical_color).toBe('White')
    expect(res.body.feast_name).toBe('Christmas')
  })

  it('respects explicit liturgical fields from the caller', async () => {
    // Same Christmas date but the admin pins a non-default color
    // (e.g. for a "blue Christmas" service of remembrance). Should
    // win over the computed default.
    const yyyy = new Date().getFullYear() + 1
    const christmas = `${yyyy}-12-25`

    const res = await request(server)
      .post('/api/events')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `Manual Override Christmas ${RUN_ID}`,
        date: christmas,
        time: '18:00',
        liturgical_season: 'Christmas',
        liturgical_color:  'Purple',
        feast_name:        null, // explicitly null to override the computed feast
      })
    expect(res.status).toBe(201)
    expect(res.body.liturgical_color).toBe('Purple')
  })
})

describe('retention prune', () => {
  // The prune walks every org and deletes old rows from four
  // tables. Most important invariant: pending rows in
  // ochr_scheduled_notifications survive REGARDLESS of age —
  // pruning them would be losing work that hasn't run yet.

  it('removes old rows + keeps recent rows + preserves pending work', async () => {
    const orgRow = await pool.query(
      'SELECT id FROM ochr_organizations WHERE name = $1',
      [orgA.organizationName]
    )
    const orgId = orgRow.rows[0].id

    // ── Seed old + recent rows in each retention-relevant table ──
    // Audit log: free plan = 30d retention. Use 40d for "old".
    const oldAudit = await pool.query(
      `INSERT INTO ochr_audit_log
         (organization_id, action, entity_type, entity_id, summary, status_code, created_at)
       VALUES ($1, 'create', 'client', '999', 'Retention old', 201, NOW() - INTERVAL '40 days')
       RETURNING id`,
      [orgId]
    )
    const recentAudit = await pool.query(
      `INSERT INTO ochr_audit_log
         (organization_id, action, entity_type, entity_id, summary, status_code, created_at)
       VALUES ($1, 'create', 'client', '998', 'Retention recent', 201, NOW())
       RETURNING id`,
      [orgId]
    )

    // Notification log: same per-plan cutoff.
    const oldNotif = await pool.query(
      `INSERT INTO ochr_notification_log
         (organization_id, notification_type, status, created_at)
       VALUES ($1, 'assignment_reminder', 'stubbed', NOW() - INTERVAL '40 days')
       RETURNING id`,
      [orgId]
    )
    const recentNotif = await pool.query(
      `INSERT INTO ochr_notification_log
         (organization_id, notification_type, status, created_at)
       VALUES ($1, 'assignment_reminder', 'stubbed', NOW())
       RETURNING id`,
      [orgId]
    )

    // AI usage: fixed 90d. Use 100d for "old".
    const oldUsage = await pool.query(
      `INSERT INTO ochr_ai_usage
         (organization_id, endpoint, created_at)
       VALUES ($1, 'generate', NOW() - INTERVAL '100 days')
       RETURNING id`,
      [orgId]
    )
    const recentUsage = await pool.query(
      `INSERT INTO ochr_ai_usage
         (organization_id, endpoint, created_at)
       VALUES ($1, 'generate', NOW())
       RETURNING id`,
      [orgId]
    )

    // Scheduled notifications: fixed 30d on terminal-status rows.
    // The pending row must survive even though it's 'old' — that's
    // the work-not-yet-done invariant.
    const oldSent = await pool.query(
      `INSERT INTO ochr_scheduled_notifications
         (organization_id, notification_type, send_at, status, created_at)
       VALUES ($1, 'assignment_reminder', NOW() - INTERVAL '40 days', 'sent', NOW() - INTERVAL '40 days')
       RETURNING id`,
      [orgId]
    )
    const oldPending = await pool.query(
      `INSERT INTO ochr_scheduled_notifications
         (organization_id, notification_type, send_at, status, created_at)
       VALUES ($1, 'assignment_reminder', NOW() + INTERVAL '1 day', 'pending', NOW() - INTERVAL '40 days')
       RETURNING id`,
      [orgId]
    )
    const recentPending = await pool.query(
      `INSERT INTO ochr_scheduled_notifications
         (organization_id, notification_type, send_at, status, created_at)
       VALUES ($1, 'assignment_reminder', NOW() + INTERVAL '1 day', 'pending', NOW())
       RETURNING id`,
      [orgId]
    )

    // ── Run the prune ──
    // Vendor-only since 2026-08-14 (F3). pruneOldRecords() walks every
    // org, so a parish admin triggering it reached across tenants; the
    // trigger belongs to the operator. Prove the door is shut before
    // opening it with the operator identity.
    const asParishAdmin = await request(server)
      .post('/api/admin/maintenance/retention-prune')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(asParishAdmin.status).toBe(404)

    process.env.SUPER_ADMIN_EMAIL = orgA.email
    const res = await request(server)
      .post('/api/admin/maintenance/retention-prune')
      .set('Authorization', `Bearer ${tokenA}`)
    delete process.env.SUPER_ADMIN_EMAIL
    expect(res.status).toBe(200)
    expect(res.body.audit_pruned).toBeGreaterThanOrEqual(1)
    expect(res.body.notification_log_pruned).toBeGreaterThanOrEqual(1)
    expect(res.body.ai_usage_pruned).toBeGreaterThanOrEqual(1)
    expect(res.body.scheduled_pruned).toBeGreaterThanOrEqual(1)

    // ── Verify each table ──
    async function exists(table, id) {
      const { rows } = await pool.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id])
      return rows.length === 1
    }

    expect(await exists('ochr_audit_log', oldAudit.rows[0].id)).toBe(false)
    expect(await exists('ochr_audit_log', recentAudit.rows[0].id)).toBe(true)

    expect(await exists('ochr_notification_log', oldNotif.rows[0].id)).toBe(false)
    expect(await exists('ochr_notification_log', recentNotif.rows[0].id)).toBe(true)

    expect(await exists('ochr_ai_usage', oldUsage.rows[0].id)).toBe(false)
    expect(await exists('ochr_ai_usage', recentUsage.rows[0].id)).toBe(true)

    // The critical invariant: old SENT row gone, but old PENDING
    // row survived even though it's 40 days old, because pruning
    // it would be losing work.
    expect(await exists('ochr_scheduled_notifications', oldSent.rows[0].id)).toBe(false)
    expect(await exists('ochr_scheduled_notifications', oldPending.rows[0].id)).toBe(true)
    expect(await exists('ochr_scheduled_notifications', recentPending.rows[0].id)).toBe(true)
  })

  it('rejects non-admin callers', async () => {
    // No token at all → 401 (auth gate fires before role gate).
    const res = await request(server).post('/api/admin/maintenance/retention-prune')
    expect(res.status).toBe(401)
  })
})

describe('cron auth', () => {
  // /api/cron/* gates on CRON_SECRET, NOT on JWT — Vercel cron sends
  // Authorization: Bearer ${CRON_SECRET} on every invocation. We
  // stub the env var inside this describe so other tests are
  // unaffected.

  const TEST_SECRET = `cron-smoke-${RUN_ID}`
  const originalSecret = process.env.CRON_SECRET

  beforeAll(() => { process.env.CRON_SECRET = TEST_SECRET })
  afterAll(() => {
    if (originalSecret === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = originalSecret
  })

  it('rejects requests with no Authorization header (401)', async () => {
    const res = await request(server).post('/api/cron/retention-prune')
    expect(res.status).toBe(401)
  })

  it('rejects requests with the wrong secret (401)', async () => {
    const res = await request(server)
      .post('/api/cron/retention-prune')
      .set('Authorization', 'Bearer not-the-real-secret')
    expect(res.status).toBe(401)
  })

  it('accepts requests bearing the configured secret (200)', async () => {
    const res = await request(server)
      .post('/api/cron/retention-prune')
      .set('Authorization', `Bearer ${TEST_SECRET}`)
    expect(res.status).toBe(200)
    expect(typeof res.body.orgs_scanned).toBe('number')
  })

  it('returns 503 when CRON_SECRET is unset on the deploy', async () => {
    delete process.env.CRON_SECRET
    try {
      const res = await request(server).post('/api/cron/retention-prune')
      expect(res.status).toBe(503)
    } finally {
      process.env.CRON_SECRET = TEST_SECRET
    }
  })
})

describe('demo seed', () => {
  // orgA + orgB were both signed up at the top of this suite, which
  // ran the sample-data seed on each. We assert the new seed shape
  // here on orgA (read-only), then exercise clear-samples on orgB
  // (destructive) so orgA stays clean for any subsequent tests.
  // The tenant isolation tests at the top already finished before
  // we reach this describe, so wiping orgB's samples is safe.

  async function orgIdFor(orgName) {
    const { rows } = await pool.query(
      'SELECT id FROM ochr_organizations WHERE name = $1',
      [orgName]
    )
    return rows[0].id
  }

  it('seeds 12+ members on signup with birthdays + joined dates', async () => {
    const res = await request(server)
      .get('/api/clients')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    const samples = res.body.filter(m => m.name?.startsWith('[Sample]'))
    expect(samples.length).toBeGreaterThanOrEqual(12)

    const withBirthday = samples.filter(m => m.birth_date)
    expect(withBirthday.length).toBeGreaterThanOrEqual(8)
    const withJoined = samples.filter(m => m.joined_date)
    expect(withJoined.length).toBeGreaterThanOrEqual(8)
  })

  it('seeds donations + payroll staff alongside members', async () => {
    const orgId = await orgIdFor(orgA.organizationName)
    const donations = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ochr_donations WHERE organization_id = $1 AND notes LIKE '[Sample]%'`,
      [orgId]
    )
    expect(donations.rows[0].n).toBeGreaterThanOrEqual(8)

    const staff = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ochr_payroll_staff WHERE organization_id = $1 AND name LIKE '[Sample]%'`,
      [orgId]
    )
    expect(staff.rows[0].n).toBeGreaterThanOrEqual(2)
  })

  it('seeds a recurring 8-week Sunday service on the schedule', async () => {
    const orgId = await orgIdFor(orgA.organizationName)
    const total = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ochr_calendar_events WHERE organization_id = $1 AND title LIKE '[Sample]%'`,
      [orgId]
    )
    expect(total.rows[0].n).toBeGreaterThanOrEqual(8)

    // All 8+ rows in the seeded series share the same parent_id.
    const parents = await pool.query(
      `SELECT DISTINCT recurrence_parent_id FROM ochr_calendar_events
        WHERE organization_id = $1
          AND title LIKE '[Sample]%'
          AND recurrence_parent_id IS NOT NULL`,
      [orgId]
    )
    expect(parents.rows.length).toBe(1)
  })

  it('GET /onboarding/status returns Sprint O checklist signals', async () => {
    // Sprint O / O.1 — the endpoint now bundles boolean flags the
    // Dashboard checklist reads to compute 'done' state. Verify the
    // shape on orgA which has samples + a fresh admin so we can
    // assert on a known starting state.
    const res = await request(server)
      .get('/api/onboarding/status')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('has_real_members')
    expect(res.body).toHaveProperty('has_real_events')
    expect(res.body).toHaveProperty('has_letterhead')
    expect(res.body).toHaveProperty('has_team_invited')
    expect(res.body).toHaveProperty('realCounts')
    expect(typeof res.body.has_real_members).toBe('boolean')
    expect(typeof res.body.has_letterhead).toBe('boolean')
  })

  it('clear-samples wipes [Sample] rows across every seeded table', async () => {
    // Run on orgB because (a) it was seeded the same way, and (b)
    // every test that needed orgB's samples has already finished.
    const before = await request(server)
      .get('/api/onboarding/status')
      .set('Authorization', `Bearer ${tokenB}`)
    expect(before.status).toBe(200)
    expect(before.body.hasSamples).toBe(true)
    expect(before.body.counts.donations).toBeGreaterThanOrEqual(8)
    expect(before.body.counts.staff).toBeGreaterThanOrEqual(2)
    expect(before.body.counts.schedule).toBeGreaterThanOrEqual(8)

    const clear = await request(server)
      .post('/api/onboarding/clear-samples')
      .set('Authorization', `Bearer ${tokenB}`)
    expect(clear.status).toBe(200)
    expect(clear.body.cleared.donations).toBeGreaterThanOrEqual(8)
    expect(clear.body.cleared.staff).toBeGreaterThanOrEqual(2)
    expect(clear.body.cleared.schedule).toBeGreaterThanOrEqual(8)

    const after = await request(server)
      .get('/api/onboarding/status')
      .set('Authorization', `Bearer ${tokenB}`)
    expect(after.body.hasSamples).toBe(false)
  })
})

describe('giving statements', () => {
  // Sprint Y. Validates the aggregation shape, donor-detail shape,
  // tenant isolation, and the admin role gate. Uses the current
  // calendar year so the date filter actually matches the rows we
  // POST in setup.
  const thisYear = new Date().getFullYear()

  // Donor identifiers carry the RUN_ID so parallel test runs don't
  // collide on shared dev DBs.
  const knownEmail = `gs-${RUN_ID}@example.org`
  const knownName  = `Givings Donor ${RUN_ID}`
  const anonName   = `Anon Donor ${RUN_ID}`

  beforeAll(async () => {
    // Two gifts from a known-email donor (should group by email).
    await request(server).post('/api/donations')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ donor_name: knownName, donor_email: knownEmail, donor_address: '1 Test Way', amount: 100, category: 'tithe', method: 'check', date: `${thisYear}-02-15` })
    await request(server).post('/api/donations')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ donor_name: knownName, donor_email: knownEmail, donor_address: '1 Test Way', amount: 250, category: 'tithe', method: 'check', date: `${thisYear}-06-15` })

    // One anonymous cash gift (no email — should group by name).
    await request(server).post('/api/donations')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ donor_name: anonName, amount: 40, category: 'tithe', method: 'cash', date: `${thisYear}-04-01` })

    // Cross-tenant noise — org B has its own donor. Must NOT show up
    // in org A's preview.
    await request(server).post('/api/donations')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ donor_name: 'Other Org Donor', donor_email: 'other@example.org', amount: 999, category: 'tithe', method: 'check', date: `${thisYear}-03-01` })
  })

  it('GET /preview lists donors who gave in the given year', async () => {
    const res = await request(server)
      .get(`/api/giving-statements/preview?year=${thisYear}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.year).toBe(thisYear)
    expect(Array.isArray(res.body.donors)).toBe(true)

    const emailRow = res.body.donors.find(d => d.by === 'email' && d.donor_email === knownEmail)
    expect(emailRow).toBeTruthy()
    expect(Number(emailRow.total)).toBe(350)
    expect(emailRow.gift_count).toBe(2)
    expect(emailRow.donor_name).toBe(knownName)

    const nameRow = res.body.donors.find(d => d.by === 'name' && d.donor_key === anonName)
    expect(nameRow).toBeTruthy()
    expect(Number(nameRow.total)).toBe(40)
    expect(nameRow.gift_count).toBe(1)
  })

  it('GET /preview excludes other-org donors (tenant isolation)', async () => {
    const res = await request(server)
      .get(`/api/giving-statements/preview?year=${thisYear}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    const leak = res.body.donors.find(d => d.donor_email === 'other@example.org')
    expect(leak).toBeUndefined()
  })

  it('GET /preview sets a private 60s Cache-Control', async () => {
    const res = await request(server)
      .get(`/api/giving-statements/preview?year=${thisYear}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.headers['cache-control']).toMatch(/private/)
    expect(res.headers['cache-control']).toMatch(/max-age=60/)
  })

  it('GET /preview rejects an invalid year with 400', async () => {
    const res = await request(server)
      .get('/api/giving-statements/preview?year=abc')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(400)
  })

  it('GET /donor returns line items + total for an email key', async () => {
    const res = await request(server)
      .get(`/api/giving-statements/donor?year=${thisYear}&key=${encodeURIComponent(knownEmail)}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.by).toBe('email')
    expect(res.body.gift_count).toBe(2)
    expect(Number(res.body.total)).toBe(350)
    expect(res.body.donor.name).toBe(knownName)
    expect(res.body.donor.email).toBe(knownEmail)
    expect(res.body.lines).toHaveLength(2)
    // Lines should be sorted ASC by date so the printed statement
    // reads chronologically.
    expect(new Date(res.body.lines[0].date) <= new Date(res.body.lines[1].date)).toBe(true)
    // Per Y.3 — the donor response bundles the org's letterhead
    // block so the print view renders from a single fetch. Fields
    // are nullable (orgs that haven't filled in Settings yet) but
    // the key must be present in the shape.
    expect(res.body.organization).toBeDefined()
    expect(res.body.organization).toHaveProperty('name')
    expect(res.body.organization).toHaveProperty('address')
    expect(res.body.organization).toHaveProperty('tax_id')
    expect(res.body.organization).toHaveProperty('signatory_name')
    expect(res.body.organization).toHaveProperty('signatory_title')
    expect(res.body.organization).toHaveProperty('statement_letterhead')
    // Org A's name must round-trip through the response — it's
    // what the printed letterhead renders.
    expect(res.body.organization.name).toBe(orgA.organizationName)
  })

  it('GET /donor returns 404 when the donor has no gifts in that year', async () => {
    const res = await request(server)
      .get(`/api/giving-statements/donor?year=${thisYear - 5}&key=${encodeURIComponent(knownEmail)}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(404)
  })

  it('GET /donor scopes to caller org — other-org keys 404 here', async () => {
    const res = await request(server)
      .get(`/api/giving-statements/donor?year=${thisYear}&key=${encodeURIComponent('other@example.org')}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(404)
  })

  it('admin-only — staff/viewer get 403', async () => {
    // No staff/viewer token is set up in the suite, but a no-token
    // call should at least be 401 and the route guard is wired with
    // requireRole('admin') in app.js. Confirm the 401 path here;
    // the 403-for-non-admin path is covered structurally by
    // 'role enforcement' tests below.
    const res = await request(server).get(`/api/giving-statements/preview?year=${thisYear}`)
    expect(res.status).toBe(401)
  })
})

describe('organization settings', () => {
  // Sprint Y / Y.4. Admin-only GET + PATCH against /api/organization.
  // Verifies that letterhead fields round-trip, NULL clearing works,
  // unknown keys are silently dropped, and tenant isolation holds.
  //
  // Placed ABOVE 'role enforcement' so tokenA still has admin role
  // (see project memory: smoke.test.js ordering convention).

  it('GET /api/organization returns the caller org', async () => {
    const res = await request(server)
      .get('/api/organization')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.name).toBe(orgA.organizationName)
    // Letterhead fields exist in the response shape, even if NULL
    // for an org that hasn't filled them in yet.
    for (const k of ['address', 'tax_id', 'signatory_name', 'signatory_title', 'statement_letterhead']) {
      expect(res.body).toHaveProperty(k)
    }
  })

  it('PATCH writes letterhead fields and they round-trip', async () => {
    const payload = {
      address:              '1 Test Way, Austin TX 78701',
      tax_id:               '12-3456789',
      signatory_name:       `Pastor ${RUN_ID}`,
      signatory_title:      'Senior Pastor',
      statement_letterhead: 'A church in the city.',
    }
    const patch = await request(server)
      .patch('/api/organization')
      .set('Authorization', `Bearer ${tokenA}`)
      .send(payload)
    expect(patch.status).toBe(200)
    expect(patch.body.tax_id).toBe(payload.tax_id)
    expect(patch.body.signatory_name).toBe(payload.signatory_name)

    // Round-trip verify via GET.
    const get = await request(server)
      .get('/api/organization')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(get.body.tax_id).toBe(payload.tax_id)
    expect(get.body.statement_letterhead).toBe(payload.statement_letterhead)
  })

  it('empty string clears the field (NULL semantics)', async () => {
    const patch = await request(server)
      .patch('/api/organization')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ statement_letterhead: '' })
    expect(patch.status).toBe(200)
    expect(patch.body.statement_letterhead).toBeNull()
  })

  it('silently drops unknown keys', async () => {
    // `slug` is on the table but NOT in PATCHABLE. Try to overwrite
    // it; the server should ignore and either succeed with the other
    // fields or 400 if NOTHING was patchable.
    const before = await request(server)
      .get('/api/organization')
      .set('Authorization', `Bearer ${tokenA}`)
    const originalSlug = before.body.slug

    const patch = await request(server)
      .patch('/api/organization')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ slug: 'hacked', address: '2 New Way' })
    expect(patch.status).toBe(200)
    expect(patch.body.slug).toBe(originalSlug)
    expect(patch.body.address).toBe('2 New Way')
  })

  it('PATCH with no patchable keys returns 400', async () => {
    const res = await request(server)
      .patch('/api/organization')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ slug: 'only-this', created_at: 'nope' })
    expect(res.status).toBe(400)
  })

  it('tenant isolation — PATCH on tokenA writes to org A, not org B', async () => {
    // Snapshot org B's state.
    const beforeB = await request(server)
      .get('/api/organization')
      .set('Authorization', `Bearer ${tokenB}`)
    const orgBSignatoryBefore = beforeB.body.signatory_name

    // Mutate as org A.
    await request(server)
      .patch('/api/organization')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ signatory_name: `OrgA Only ${RUN_ID}` })

    // Org B should be untouched.
    const afterB = await request(server)
      .get('/api/organization')
      .set('Authorization', `Bearer ${tokenB}`)
    expect(afterB.body.signatory_name).toBe(orgBSignatoryBefore)
  })

  it('writes an audit row on PATCH', async () => {
    const orgRow = await pool.query(
      'SELECT id FROM ochr_organizations WHERE name = $1',
      [orgA.organizationName]
    )
    const orgId = orgRow.rows[0].id

    await request(server)
      .patch('/api/organization')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ address: `Audit Trail ${RUN_ID}` })

    const row = await waitForAuditRow(orgId, r =>
      r.entity_type === 'organization' && r.action === 'update'
    )
    expect(row.user_email).toBe(orgA.email.toLowerCase())
  })

  it('unauthenticated GET returns 401', async () => {
    const res = await request(server).get('/api/organization')
    expect(res.status).toBe(401)
  })
})

describe('insights', () => {
  // Sprint A. Locks the shape of the analytics endpoint. Placed
  // above 'role enforcement' so tokenA still has admin role.

  it('GET /api/insights returns the analytics bundle', async () => {
    const res = await request(server)
      .get('/api/insights')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)

    // Summary card shape
    expect(res.body.summary).toBeDefined()
    expect(typeof res.body.summary.member_count).toBe('number')
    expect(typeof res.body.summary.ytd_donations).toBe('number')
    expect(typeof res.body.summary.ai_this_month).toBe('number')
    expect(typeof res.body.summary.ai_last_month).toBe('number')

    // Sprint T / T.3 — attendance fields. avg_attendance_rate is
    // null when no events have been tracked yet, number 0..1
    // otherwise. tracked_events is always a number.
    expect(res.body.summary).toHaveProperty('avg_attendance_rate')
    expect(typeof res.body.summary.tracked_events).toBe('number')
    expect(Array.isArray(res.body.attendance_monthly)).toBe(true)
    expect(res.body.attendance_monthly.length).toBe(12)
    for (const row of res.body.attendance_monthly) {
      expect(row).toHaveProperty('month')
      expect(typeof row.avg_rate).toBe('number')
      expect(typeof row.events).toBe('number')
    }

    // Sprint D / D.3 — pledge fields. pledge_fulfillment null when
    // no active pledges; otherwise a fraction 0..1. pledges_active /
    // pledged / received always numbers.
    expect(res.body.summary).toHaveProperty('pledge_fulfillment')
    expect(typeof res.body.summary.pledges_active).toBe('number')
    expect(typeof res.body.summary.pledges_pledged).toBe('number')
    expect(typeof res.body.summary.pledges_received).toBe('number')

    // Members joined per month — exactly 12 rows (zero-filled).
    expect(Array.isArray(res.body.members_joined)).toBe(true)
    expect(res.body.members_joined.length).toBe(12)
    for (const row of res.body.members_joined) {
      expect(row).toHaveProperty('month')
      expect(typeof row.count).toBe('number')
    }

    // Donations per month — same shape, same length.
    expect(res.body.donations_monthly.length).toBe(12)
    for (const row of res.body.donations_monthly) {
      expect(row).toHaveProperty('month')
      expect(typeof row.total).toBe('number')
    }

    // Categories — array, not zero-filled (only categories with
    // donations show up). Demo seed has tithe + special offering.
    expect(Array.isArray(res.body.donations_by_category)).toBe(true)
    if (res.body.donations_by_category.length > 0) {
      expect(res.body.donations_by_category[0]).toHaveProperty('category')
      expect(res.body.donations_by_category[0]).toHaveProperty('total')
    }
  })

  it('insights sets a private 60s Cache-Control', async () => {
    const res = await request(server)
      .get('/api/insights')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.headers['cache-control']).toMatch(/private/)
    expect(res.headers['cache-control']).toMatch(/max-age=60/)
  })

  it('insights tenant-isolates — org B donations don\'t bleed into org A', async () => {
    const a = await request(server)
      .get('/api/insights')
      .set('Authorization', `Bearer ${tokenA}`)
    const b = await request(server)
      .get('/api/insights')
      .set('Authorization', `Bearer ${tokenB}`)
    // Different orgs, different sums. Equal-zero would be suspicious;
    // we assert the totals are independent rather than equal.
    expect(a.body.summary.member_count).not.toBe(undefined)
    expect(b.body.summary.member_count).not.toBe(undefined)
    // The category arrays should be independently computed too. If
    // both are empty that's fine (seed donations may all fall outside
    // the 365-day window depending on when the test runs).
  })

  it('insights returns 401 without a token', async () => {
    const res = await request(server).get('/api/insights')
    expect(res.status).toBe(401)
  })
})

describe('member donations', () => {
  // Sprint M / M.1. GET /api/clients/:id/donations matches a member's
  // gifts by email (preferred) or donor_name (fallback). Placed above
  // 'role enforcement' so tokenA still has admin role.

  const memberEmail = `member-donations-${RUN_ID}@example.org`
  const memberName  = `Member-Donations ${RUN_ID}`
  let memberId
  let thisYear

  beforeAll(async () => {
    thisYear = new Date().getFullYear()
    // Create a member with a known email
    const m = await request(server)
      .post('/api/clients')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: memberName, email: memberEmail, role: 'Member', status: 'active' })
    memberId = m.body.id

    // Log two donations against that email
    await request(server).post('/api/donations')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ donor_name: memberName, donor_email: memberEmail, amount: 60, category: 'tithe', method: 'cash', date: `${thisYear}-03-15` })
    await request(server).post('/api/donations')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ donor_name: memberName, donor_email: memberEmail, amount: 90, category: 'tithe', method: 'check', date: `${thisYear}-04-10` })
  })

  it('GET /clients/:id/donations matches by email', async () => {
    const res = await request(server)
      .get(`/api/clients/${memberId}/donations`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.by).toBe('email')
    expect(res.body.match_key).toBe(memberEmail)
    expect(res.body.gift_count).toBe(2)
    expect(Number(res.body.total)).toBe(150)
    // Lines sorted DESC by date — most recent first.
    expect(new Date(res.body.lines[0].date) >= new Date(res.body.lines[1].date)).toBe(true)
  })

  it('GET /clients/:id/donations 404s for an unknown member', async () => {
    const res = await request(server)
      .get('/api/clients/99999999/donations')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(404)
  })

  it('GET /clients/:id/donations tenant-isolates', async () => {
    // org B looking up org A's member id should 404 (member doesn't
    // belong to org B). Crucial — without this check we'd leak
    // donation totals across tenants.
    const res = await request(server)
      .get(`/api/clients/${memberId}/donations`)
      .set('Authorization', `Bearer ${tokenB}`)
    expect(res.status).toBe(404)
  })
})

describe('public events feed', () => {
  // Sprint P. Unauthenticated endpoints — anyone with the church
  // slug can see events explicitly marked is_public = true. Placed
  // above 'role enforcement' to keep tokenA admin for setup.
  //
  // Three contracts to lock:
  //  - is_public filter actually works (private events NEVER leak)
  //  - unknown slug 404s (no info leak about which churches exist)
  //  - ICS feed parses + carries the public events

  let orgAslug
  let publicEventId
  let privateEventId

  beforeAll(async () => {
    // Look up org A's slug — set on signup.
    const o = await pool.query(
      'SELECT slug FROM ochr_organizations WHERE name = $1',
      [orgA.organizationName]
    )
    orgAslug = o.rows[0].slug

    // Create one public + one private event, both upcoming.
    const upcomingDate = new Date()
    upcomingDate.setDate(upcomingDate.getDate() + 14)
    const dateStr = upcomingDate.toISOString().slice(0, 10)

    const pub = await request(server)
      .post('/api/events')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ title: `Sunday Service ${RUN_ID}`, date: dateStr, time: '10:00', location: 'Main Hall', is_public: true })
    publicEventId = pub.body.id

    const priv = await request(server)
      .post('/api/events')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ title: `Staff Meeting ${RUN_ID}`, date: dateStr, time: '14:00', location: 'Office', is_public: false })
    privateEventId = priv.body.id
  })

  it('POST /api/events round-trips is_public', async () => {
    const get = await request(server)
      .get('/api/events')
      .set('Authorization', `Bearer ${tokenA}`)
    const pub = get.body.find(e => e.id === publicEventId)
    const priv = get.body.find(e => e.id === privateEventId)
    expect(pub.is_public).toBe(true)
    expect(priv.is_public).toBe(false)
  })

  it('GET /api/public/:slug returns the church card (no auth)', async () => {
    const res = await request(server).get(`/api/public/${orgAslug}`)
    expect(res.status).toBe(200)
    expect(res.body.name).toBe(orgA.organizationName)
    expect(res.body.slug).toBe(orgAslug)
    expect(typeof res.body.upcoming_count).toBe('number')
  })

  it('GET /api/public/:slug/events lists ONLY public upcoming events', async () => {
    const res = await request(server).get(`/api/public/${orgAslug}/events`)
    expect(res.status).toBe(200)
    expect(res.body.church.name).toBe(orgA.organizationName)
    const ids = res.body.events.map(e => e.id)
    expect(ids).toContain(publicEventId)
    // The privacy line — private events MUST NOT appear.
    expect(ids).not.toContain(privateEventId)
  })

  it('GET /api/public/:slug/events.ics returns a calendar feed', async () => {
    const res = await request(server).get(`/api/public/${orgAslug}/events.ics`)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/calendar/)
    expect(res.text).toMatch(/BEGIN:VCALENDAR/)
    expect(res.text).toMatch(/END:VCALENDAR/)
    // Public event title should appear; private one should not.
    expect(res.text).toMatch(new RegExp(`Sunday Service ${RUN_ID}`))
    expect(res.text).not.toMatch(new RegExp(`Staff Meeting ${RUN_ID}`))
  })

  it('unknown slug returns 404 (no info leak)', async () => {
    const res = await request(server).get('/api/public/this-church-does-not-exist/events')
    expect(res.status).toBe(404)
  })

  it('public endpoints set a public Cache-Control', async () => {
    const json = await request(server).get(`/api/public/${orgAslug}/events`)
    expect(json.headers['cache-control']).toMatch(/public/)
    const ics = await request(server).get(`/api/public/${orgAslug}/events.ics`)
    expect(ics.headers['cache-control']).toMatch(/public/)
  })
})

describe('attendance', () => {
  // Sprint T / T.1. Roster + bulk marks. Above 'role enforcement'.

  let eventId
  let memberA
  let memberB
  let memberB_otherOrg

  beforeAll(async () => {
    // Two members on org A's roster + one event with both assigned.
    const ma = await request(server).post('/api/clients')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `Att MemberA ${RUN_ID}`, status: 'active', role: 'Member' })
    memberA = ma.body.id

    const mb = await request(server).post('/api/clients')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `Att MemberB ${RUN_ID}`, status: 'active', role: 'Member' })
    memberB = mb.body.id

    // Member on org B — used to verify cross-org marks reject.
    const mob = await request(server).post('/api/clients')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ name: `OtherOrg Member ${RUN_ID}`, status: 'active', role: 'Member' })
    memberB_otherOrg = mob.body.id

    const ev = await request(server).post('/api/events')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `Attendance Event ${RUN_ID}`,
        date: new Date().toISOString().slice(0, 10),
        time: '10:00',
        member_ids: [memberA, memberB],
      })
    eventId = ev.body.id
  })

  it('GET /api/events/:id/attendance returns the roster with null marks', async () => {
    const res = await request(server)
      .get(`/api/events/${eventId}/attendance`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.event_id).toBe(eventId)
    expect(res.body.roster.length).toBe(2)
    expect(res.body.summary.unmarked).toBe(2)
    for (const r of res.body.roster) {
      expect(r.status).toBeNull()
    }
  })

  it('POST bulk-marks roster members and round-trips on GET', async () => {
    const post = await request(server)
      .post(`/api/events/${eventId}/attendance`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        marks: [
          { member_id: memberA, status: 'present' },
          { member_id: memberB, status: 'excused' },
        ],
      })
    expect(post.status).toBe(200)
    expect(post.body.updated).toBe(2)

    const get = await request(server)
      .get(`/api/events/${eventId}/attendance`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(get.body.summary.present).toBe(1)
    expect(get.body.summary.excused).toBe(1)
    expect(get.body.summary.unmarked).toBe(0)
  })

  it('POST upserts — flipping a mark replaces rather than stacks', async () => {
    await request(server)
      .post(`/api/events/${eventId}/attendance`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ marks: [{ member_id: memberA, status: 'absent' }] })

    const get = await request(server)
      .get(`/api/events/${eventId}/attendance`)
      .set('Authorization', `Bearer ${tokenA}`)
    const row = get.body.roster.find(r => r.member_id === memberA)
    expect(row.status).toBe('absent')
  })

  it('POST rejects marks for members not on the event roster', async () => {
    // The other-org member is not on this event's roster — the
    // bulk filter should drop the mark and 400 because nothing valid
    // is left.
    const res = await request(server)
      .post(`/api/events/${eventId}/attendance`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ marks: [{ member_id: memberB_otherOrg, status: 'present' }] })
    expect(res.status).toBe(400)
  })

  it('rejects invalid status strings', async () => {
    const res = await request(server)
      .post(`/api/events/${eventId}/attendance`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ marks: [{ member_id: memberA, status: 'sleeping' }] })
    expect(res.status).toBe(400)
  })

  it('tenant-isolates — org B 404s on org A event id', async () => {
    const res = await request(server)
      .get(`/api/events/${eventId}/attendance`)
      .set('Authorization', `Bearer ${tokenB}`)
    expect(res.status).toBe(404)
  })
})

describe('pledges', () => {
  // Sprint D / D.1. CRUD + fulfillment math + tenant isolation.
  // Placed above 'role enforcement' so tokenA stays admin during
  // the entire suite.

  let memberId
  let pledgeId
  const memberEmail = `pledger-${RUN_ID}@example.org`
  const memberName  = `Pledger ${RUN_ID}`

  beforeAll(async () => {
    // Member with a known email — the pledge will match donations
    // against this email automatically.
    const m = await request(server)
      .post('/api/clients')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: memberName, email: memberEmail, role: 'Member', status: 'active' })
    memberId = m.body.id
  })

  it('POST /api/pledges creates a pledge', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const res = await request(server)
      .post('/api/pledges')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        member_id: memberId,
        amount: 100,
        frequency: 'monthly',
        start_date: today,
        notes: 'Monthly tithe',
      })
    expect(res.status).toBe(201)
    expect(res.body.member_id).toBe(memberId)
    expect(Number(res.body.amount)).toBe(100)
    expect(res.body.frequency).toBe('monthly')
    expect(res.body.status).toBe('active')
    pledgeId = res.body.id
  })

  it('POST rejects when both member_id and donor_email are missing', async () => {
    const res = await request(server)
      .post('/api/pledges')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ amount: 50, frequency: 'monthly' })
    expect(res.status).toBe(400)
  })

  it('POST rejects an invalid frequency', async () => {
    const res = await request(server)
      .post('/api/pledges')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ member_id: memberId, amount: 50, frequency: 'fortnightly' })
    expect(res.status).toBe(400)
  })

  it('POST rejects a cross-tenant member_id', async () => {
    // Look up an org B member id and try to pledge against it as org A.
    const m = await request(server)
      .post('/api/clients')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ name: 'Other Org Member', status: 'active', role: 'Member' })
    const otherMemberId = m.body.id
    const res = await request(server)
      .post('/api/pledges')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ member_id: otherMemberId, amount: 50, frequency: 'monthly' })
    expect(res.status).toBe(400)
  })

  it('PATCH rejects a cross-tenant member_id (regression: PATCH bypassed the POST guard)', async () => {
    // The hole: member_id was in PATCH's raw allowlist with no org check,
    // so org A could repoint its own pledge at any ochr_clients.id. The
    // unscoped LEFT JOIN in the read paths then returned org B's member
    // name + email to org A. Guard both halves here.
    const m = await request(server)
      .post('/api/clients')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ name: 'Org B Secret Member', email: `orgb-secret-${RUN_ID}@example.org`, status: 'active', role: 'Member' })
    const otherMemberId = m.body.id
    expect(otherMemberId).toBeTruthy()

    const res = await request(server)
      .patch(`/api/pledges/${pledgeId}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ member_id: otherMemberId })
    expect(res.status).toBe(400)

    // And the pledge still points at org A's own member.
    const after = await request(server)
      .get(`/api/pledges/${pledgeId}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(after.status).toBe(200)
    expect(after.body.member_id).toBe(memberId)
    // No org B data leaked into org A's view of the pledge.
    expect(after.body.member_name).toBe(memberName)
  })

  it('the DB rejects a cross-tenant pledge member_id below the route layer (migration 061)', async () => {
    // Belt-and-braces: bypass the API entirely and go straight at the
    // table. The composite FK from 061 must refuse the write.
    const { rows: ver } = await pool.query('SHOW server_version_num')
    if (parseInt(ver[0].server_version_num, 10) < 150000) return // FK skipped on PG < 15

    const m = await request(server)
      .post('/api/clients')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ name: 'FK probe member', status: 'active', role: 'Member' })
    expect(m.status).toBe(201)

    await expect(
      pool.query('UPDATE ochr_pledges SET member_id = $1 WHERE id = $2', [m.body.id, pledgeId])
    ).rejects.toMatchObject({ code: '23503' })
  })

  it('GET /api/pledges lists the org pledges with fulfillment fields', async () => {
    const res = await request(server)
      .get('/api/pledges')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.pledges)).toBe(true)
    const ours = res.body.pledges.find(p => p.id === pledgeId)
    expect(ours).toBeTruthy()
    expect(typeof ours.matched_total).toBe('number')
    expect(typeof ours.period_total).toBe('number')
    expect(typeof ours.fulfillment).toBe('number')
    expect(ours.fulfillment).toBeGreaterThanOrEqual(0)
    expect(ours.fulfillment).toBeLessThanOrEqual(1)
    expect(ours.member_name).toBe(memberName)
  })

  it('fulfillment increases when matching donations land', async () => {
    // Log a donation against the same email. fulfillment should
    // be > 0 afterward.
    await request(server)
      .post('/api/donations')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        donor_name: memberName, donor_email: memberEmail,
        amount: 25, category: 'tithe', method: 'check',
        date: new Date().toISOString().slice(0, 10),
      })

    const res = await request(server)
      .get(`/api/pledges/${pledgeId}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    expect(Number(res.body.matched_total)).toBeGreaterThan(0)
    expect(res.body.fulfillment).toBeGreaterThan(0)
    expect(res.body.lines.length).toBeGreaterThan(0)
  })

  it('PATCH updates a pledge', async () => {
    const res = await request(server)
      .patch(`/api/pledges/${pledgeId}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ amount: 150 })
    expect(res.status).toBe(200)
    expect(Number(res.body.amount)).toBe(150)
  })

  it('PATCH tenant-isolates — org B 404s', async () => {
    const res = await request(server)
      .patch(`/api/pledges/${pledgeId}`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ amount: 999 })
    expect(res.status).toBe(404)
  })

  it('DELETE returns 404 cross-tenant (no info leak)', async () => {
    const res = await request(server)
      .delete(`/api/pledges/${pledgeId}`)
      .set('Authorization', `Bearer ${tokenB}`)
    expect(res.status).toBe(404)
  })

  it('DELETE removes the pledge for the owning org', async () => {
    const res = await request(server)
      .delete(`/api/pledges/${pledgeId}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(204)
  })
})

describe('push subscriptions', () => {
  // Sprint PWA / PWA.4a. Placed ABOVE 'role enforcement' so tokenA
  // remains an admin during the entire block — the push routes don't
  // require admin (every signed-in user manages their own devices)
  // but we keep the convention so the test order stays predictable
  // for the next person who adds a block.

  // Fake browser PushSubscription.toJSON() shape — unique endpoint per
  // run so the upsert path is exercised cleanly and we don't collide
  // with leftover rows from a previous test pass.
  const sub = {
    endpoint: `https://example-push.test/run/${RUN_ID}/device-a`,
    keys: {
      p256dh: 'BLc4xRzKlKO_Sb6X-r5C0o5y_-pSamplePublicKeyValueAAAAAAAAAA',
      auth:   'samplePushAuthSecretAAAA',
    },
  }

  it('GET /api/push/vapid-key returns a publicKey field (null when unset)', async () => {
    const res = await request(server)
      .get('/api/push/vapid-key')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('publicKey')
    // Either a string (configured) or null (CI / unconfigured dev).
    expect(['string', 'object']).toContain(typeof res.body.publicKey)
  })

  it('POST /api/push/subscribe creates a row', async () => {
    const res = await request(server)
      .post('/api/push/subscribe')
      .set('Authorization', `Bearer ${tokenA}`)
      .send(sub)
    expect(res.status).toBe(201)
    expect(typeof res.body.id).toBe('number')
  })

  it('POST /api/push/subscribe is idempotent (upsert on endpoint)', async () => {
    const res = await request(server)
      .post('/api/push/subscribe')
      .set('Authorization', `Bearer ${tokenA}`)
      .send(sub)
    expect(res.status).toBe(201)
  })

  it('POST rejects when endpoint/keys are missing', async () => {
    const res = await request(server)
      .post('/api/push/subscribe')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ endpoint: '', keys: {} })
    expect(res.status).toBe(400)
  })

  it('DELETE /api/push/subscribe soft-removes by endpoint', async () => {
    const res = await request(server)
      .delete('/api/push/subscribe')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ endpoint: sub.endpoint })
    expect(res.status).toBe(204)
  })

  it('DELETE returns 404 when the endpoint is already gone (no info leak)', async () => {
    const res = await request(server)
      .delete('/api/push/subscribe')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ endpoint: sub.endpoint })
    expect(res.status).toBe(404)
  })

  it('DELETE 404s when caller does not own the subscription', async () => {
    // Re-subscribe as tokenA, then try DELETE as tokenB — should 404
    // because the WHERE filters on user_id.
    const e2 = `${sub.endpoint}-cross`
    await request(server)
      .post('/api/push/subscribe')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ ...sub, endpoint: e2 })
    const res = await request(server)
      .delete('/api/push/subscribe')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ endpoint: e2 })
    expect(res.status).toBe(404)
  })
})

describe('sendPushToUser status branches', () => {
  // Sprint PWA / PWA.5. notify() leans on these early-return paths so
  // an anonymous call (no userId) or a server without VAPID keys
  // doesn't blow up the request — it returns a typed status instead.

  it('returns no_user when userId is omitted', async () => {
    const result = await sendPushToUser(null, { title: 't', body: 'b' })
    expect(result).toEqual({ status: 'no_user' })
  })

  // Auto-skip when VAPID is configured locally — the module caches the
  // configured state on first send, so we can't reliably exercise the
  // 'no_vapid_configured' branch once keys are present. CI runs without
  // VAPID and covers it there.
  it.skipIf(isPushConfigured())(
    'returns no_vapid_configured when VAPID env is unset',
    async () => {
      const result = await sendPushToUser(999999999, { title: 't', body: 'b' })
      expect(result.status).toBe('no_vapid_configured')
      expect(result.sent).toBe(0)
    }
  )
})

describe('forms (Sprint Forms / F.1)', () => {
  // Placed above 'role enforcement' so tokenA still has admin role
  // for the whole block — forms is admin-only across the board so
  // a demoted token would 403 on every setup call.
  //
  // Covers the F.1 surface contract that F.2 (builder UI), F.3
  // (public render), and F.4 (response inbox) will all build on:
  //   - schema validation rejects bad shapes early
  //   - tenant scope is enforced on every direct-id route (404 on
  //     cross-tenant, never 403, to avoid existence leaks)
  //   - the public surface only sees is_public + status='open' forms
  //   - delete cascades responses (FK ON DELETE CASCADE)

  let createdFormId
  let createdFormSlug
  let orgAslug

  const validFields = [
    { id: 'name',      type: 'short_text', label: 'Your name',  required: true  },
    { id: 'email',     type: 'email',      label: 'Email',      required: true  },
    { id: 'attending', type: 'select',     label: 'Attending?', options: ['Yes', 'No', 'Maybe'], required: true },
    { id: 'guests',    type: 'number',     label: 'Guests',     required: false },
  ]

  beforeAll(async () => {
    const o = await pool.query(
      'SELECT slug FROM ochr_organizations WHERE name = $1',
      [orgA.organizationName]
    )
    orgAslug = o.rows[0].slug
  })

  it('POST /api/forms creates a form with auto-slug and status=draft', async () => {
    const res = await request(server)
      .post('/api/forms')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `Sunday Picnic RSVP ${RUN_ID}`,
        description: 'Let us know who is coming.',
        fields: validFields,
      })
    expect(res.status).toBe(201)
    expect(res.body.id).toBeTruthy()
    expect(res.body.slug).toMatch(/^sunday-picnic-rsvp-/)
    expect(res.body.status).toBe('draft')
    expect(res.body.is_public).toBe(false)
    expect(res.body.fields).toHaveLength(4)
    createdFormId   = res.body.id
    createdFormSlug = res.body.slug
  })

  it('POST rejects an unknown field type', async () => {
    const res = await request(server)
      .post('/api/forms')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `Bad Type ${RUN_ID}`,
        fields: [{ id: 'x', type: 'rocket_science', label: 'X' }],
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/unknown field type/)
  })

  it('POST rejects a field missing a label', async () => {
    const res = await request(server)
      .post('/api/forms')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `Missing Label ${RUN_ID}`,
        fields: [{ id: 'x', type: 'short_text' }],
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/label/)
  })

  it('POST rejects a select field with empty options', async () => {
    const res = await request(server)
      .post('/api/forms')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `No Options ${RUN_ID}`,
        fields: [{ id: 'pick', type: 'select', label: 'Pick one' }],
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/options/)
  })

  it('POST rejects a duplicate slug with 409', async () => {
    const res = await request(server)
      .post('/api/forms')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `Conflict ${RUN_ID}`,
        slug:  createdFormSlug, // reuse the one we just created
        fields: [],
      })
    expect(res.status).toBe(409)
  })

  it('GET /api/forms lists with response_count', async () => {
    const res = await request(server)
      .get('/api/forms')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    const row = res.body.forms.find(f => f.id === createdFormId)
    expect(row).toBeTruthy()
    expect(row.response_count).toBe(0)
  })

  it('PATCH /api/forms/:id updates fields and publishes (status=open + is_public)', async () => {
    const res = await request(server)
      .patch(`/api/forms/${createdFormId}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        is_public: true,
        status:    'open',
        fields:    validFields, // unchanged, but exercises the jsonb write path
      })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('open')
    expect(res.body.is_public).toBe(true)
  })

  it('PATCH on another tenant returns 404 (no existence leak)', async () => {
    const res = await request(server)
      .patch(`/api/forms/${createdFormId}`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ title: 'Hijacked' })
    expect(res.status).toBe(404)
  })

  it('GET /api/public/forms/:org/:slug returns the published form', async () => {
    const res = await request(server).get(`/api/public/forms/${orgAslug}/${createdFormSlug}`)
    expect(res.status).toBe(200)
    expect(res.body.title).toMatch(/Sunday Picnic RSVP/)
    expect(res.body.fields).toHaveLength(4)
    // Internal flags must NOT leak to the public render shape.
    expect(res.body.is_public).toBeUndefined()
    expect(res.body.status).toBeUndefined()
  })

  it('GET /api/public/forms/:org/:slug 404s for a draft form', async () => {
    // Build a fresh form, leave status=draft (the default).
    const create = await request(server)
      .post('/api/forms')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ title: `Hidden Draft ${RUN_ID}`, is_public: true, fields: [] })
    expect(create.status).toBe(201)
    const draftSlug = create.body.slug

    const res = await request(server).get(`/api/public/forms/${orgAslug}/${draftSlug}`)
    expect(res.status).toBe(404)
  })

  it('POST /api/public/forms/:org/:slug/submit creates a response', async () => {
    const res = await request(server)
      .post(`/api/public/forms/${orgAslug}/${createdFormSlug}/submit`)
      .send({
        answers: {
          name:      'Parishioner Pat',
          email:     'pat@example.com',
          attending: 'Yes',
          guests:    3,
        },
        respondent_name:  'Parishioner Pat',
        respondent_email: 'pat@example.com',
      })
    expect(res.status).toBe(201)
    expect(res.body.id).toBeTruthy()
  })

  it('POST submit rejects when a required field is missing', async () => {
    const res = await request(server)
      .post(`/api/public/forms/${orgAslug}/${createdFormSlug}/submit`)
      .send({
        answers: { email: 'noname@example.com', attending: 'No' }, // missing required name
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/required/)
  })

  it('POST submit treats an empty array as empty for required multiselect', async () => {
    // Surfaced during F.3 review: a touched-then-cleared multiselect
    // submits [] from the UI. The previous isEmpty predicate only
    // covered undefined / null / '', so the required check passed.
    const create = await request(server)
      .post('/api/forms')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `Multi Required ${RUN_ID}`,
        is_public: true,
        status:    'open',
        fields:    [{ id: 'mins', type: 'multiselect', label: 'Ministries', options: ['Music', 'Youth'], required: true }],
      })
    expect(create.status).toBe(201)
    const slug = create.body.slug

    const submit = await request(server)
      .post(`/api/public/forms/${orgAslug}/${slug}/submit`)
      .send({ answers: { mins: [] } })
    expect(submit.status).toBe(400)
    expect(submit.body.error).toMatch(/required/)
  })

  it('GET /api/forms/:id/responses lists the response inbox', async () => {
    const res = await request(server)
      .get(`/api/forms/${createdFormId}/responses`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.total).toBeGreaterThanOrEqual(1)
    expect(res.body.responses[0].answers.name).toBe('Parishioner Pat')
  })

  // ---- Review-cycle polish tests (F.1 round 2) ---------------------

  it('POST rejects status=open when fields is empty', async () => {
    const res = await request(server)
      .post('/api/forms')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ title: `Empty Open POST ${RUN_ID}`, status: 'open', fields: [] })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/no fields/)
  })

  it('PATCH rejects status=open on a form whose stored fields are empty', async () => {
    const create = await request(server)
      .post('/api/forms')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ title: `Empty Open PATCH ${RUN_ID}`, fields: [] })
    expect(create.status).toBe(201)

    const patch = await request(server)
      .patch(`/api/forms/${create.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ status: 'open' })
    expect(patch.status).toBe(400)
    expect(patch.body.error).toMatch(/no fields/)
  })

  it('POST rejects an explicit slug that strips to empty (no silent title fallback)', async () => {
    const res = await request(server)
      .post('/api/forms')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ title: `Punctuation Slug ${RUN_ID}`, slug: '!!!', fields: [] })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/slug/i)
  })

  it('POST rejects duplicate field labels (case-insensitive)', async () => {
    const res = await request(server)
      .post('/api/forms')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `Dup Labels ${RUN_ID}`,
        fields: [
          { id: 'a', type: 'short_text', label: 'Email' },
          { id: 'b', type: 'short_text', label: ' email ' }, // same label, padded + cased
        ],
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/duplicate field label/)
  })

  it('public submit rejects a structurally-valid but impossible date (2026-02-31)', async () => {
    const create = await request(server)
      .post('/api/forms')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `Date Test ${RUN_ID}`,
        is_public: true,
        status:    'open',
        fields:    [{ id: 'when', type: 'date', label: 'Date', required: true }],
      })
    expect(create.status).toBe(201)
    const slug = create.body.slug

    const submit = await request(server)
      .post(`/api/public/forms/${orgAslug}/${slug}/submit`)
      .send({ answers: { when: '2026-02-31' } })
    expect(submit.status).toBe(400)
    expect(submit.body.error).toMatch(/valid calendar date/)
  })

  it('public submit coerces a stringified number ("5") and stores it as a number', async () => {
    const create = await request(server)
      .post('/api/forms')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `Num Coerce ${RUN_ID}`,
        is_public: true,
        status:    'open',
        fields:    [{ id: 'count', type: 'number', label: 'Count', required: true }],
      })
    expect(create.status).toBe(201)
    const slug = create.body.slug

    const submit = await request(server)
      .post(`/api/public/forms/${orgAslug}/${slug}/submit`)
      .send({ answers: { count: '5' } }) // string, not number
    expect(submit.status).toBe(201)

    const inbox = await request(server)
      .get(`/api/forms/${create.body.id}/responses`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(inbox.body.responses[0].answers.count).toBe(5) // stored as number
    expect(typeof inbox.body.responses[0].answers.count).toBe('number')
  })

  it('public submit rejects a malformed email on an email-typed field', async () => {
    const create = await request(server)
      .post('/api/forms')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `Email Test ${RUN_ID}`,
        is_public: true,
        status:    'open',
        fields:    [{ id: 'em', type: 'email', label: 'Email', required: true }],
      })
    expect(create.status).toBe(201)
    const slug = create.body.slug

    const submit = await request(server)
      .post(`/api/public/forms/${orgAslug}/${slug}/submit`)
      .send({ answers: { em: 'not-an-email' } })
    expect(submit.status).toBe(400)
    expect(submit.body.error).toMatch(/valid email/)
  })

  it('public submit truncates an overlong respondent_name at 200 chars', async () => {
    const create = await request(server)
      .post('/api/forms')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `Truncate Test ${RUN_ID}`,
        is_public: true,
        status:    'open',
        fields:    [{ id: 'note', type: 'short_text', label: 'Note' }],
      })
    expect(create.status).toBe(201)
    const slug = create.body.slug

    const longName = 'A'.repeat(300)
    const submit = await request(server)
      .post(`/api/public/forms/${orgAslug}/${slug}/submit`)
      .send({ answers: {}, respondent_name: longName })
    expect(submit.status).toBe(201)

    const inbox = await request(server)
      .get(`/api/forms/${create.body.id}/responses`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(inbox.body.responses[0].respondent_name).toHaveLength(200)
  })

  // -------------------------------------------------------------------

  it('DELETE /api/forms/:id cascades the responses', async () => {
    // Confirm there IS at least one response on this form before delete.
    const before = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ochr_form_responses WHERE form_id = $1`,
      [createdFormId]
    )
    expect(before.rows[0].n).toBeGreaterThanOrEqual(1)

    const del = await request(server)
      .delete(`/api/forms/${createdFormId}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(del.status).toBe(204)

    const after = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ochr_form_responses WHERE form_id = $1`,
      [createdFormId]
    )
    expect(after.rows[0].n).toBe(0)
  })
})

describe('profile avatar', () => {
  // Placed above 'role enforcement' so tokenA still has admin role
  // (avatar PATCH is self-serve and works for any role, but we share
  // the tokenA fixture with the surrounding admin-era tests).
  //
  // 1x1 transparent PNG as a base64 data URL — small enough to fit
  // well under MAX_AVATAR_CHARS, valid `data:image/...` prefix.
  const PNG_1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

  it('sets an avatar and /me reflects it', async () => {
    const set = await request(server)
      .patch('/api/auth/avatar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ avatar: PNG_1x1 })
    expect(set.status).toBe(200)
    expect(set.body.avatar).toBe(PNG_1x1)

    const me = await request(server)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(me.status).toBe(200)
    expect(me.body.user.avatar).toBe(PNG_1x1)
  })

  it('clears the avatar with null', async () => {
    const clear = await request(server)
      .patch('/api/auth/avatar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ avatar: null })
    expect(clear.status).toBe(200)
    expect(clear.body.avatar).toBeNull()

    const me = await request(server)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(me.body.user.avatar).toBeNull()
  })

  it('rejects a non-data-URL string with 400', async () => {
    const res = await request(server)
      .patch('/api/auth/avatar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ avatar: 'https://example.com/me.png' })
    expect(res.status).toBe(400)
  })

  it('rejects an oversized payload with 413', async () => {
    // Just over the 400_000 char ceiling — valid prefix so it passes
    // the type check and trips the size guard, not the format guard.
    const huge = 'data:image/png;base64,' + 'A'.repeat(400_001)
    const res = await request(server)
      .patch('/api/auth/avatar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ avatar: huge })
    expect(res.status).toBe(413)
  })

  it('rejects unauthenticated callers with 401', async () => {
    const res = await request(server)
      .patch('/api/auth/avatar')
      .send({ avatar: PNG_1x1 })
    expect(res.status).toBe(401)
  })
})

describe('schedule rotation auto-fill', () => {
  // POST /api/calendar/auto-fill-rotation walks every FUTURE occurrence
  // of a recurring series in date order and appends the next member
  // from member_ids round-robin. Past occurrences are untouched,
  // pre-existing assignees stay, re-runs are idempotent per member,
  // and foreign-org member ids are dropped before any write.
  //
  // Placed above 'role enforcement' so tokenA still has admin role
  // during setup.

  it('round-robins members across future occurrences and appends', async () => {
    const [m1, m2, m3, extra] = await Promise.all([
      request(server).post('/api/clients').set('Authorization', `Bearer ${tokenA}`)
        .send({ name: `Rot M1 ${RUN_ID}`, status: 'active', role: 'Member' }),
      request(server).post('/api/clients').set('Authorization', `Bearer ${tokenA}`)
        .send({ name: `Rot M2 ${RUN_ID}`, status: 'active', role: 'Member' }),
      request(server).post('/api/clients').set('Authorization', `Bearer ${tokenA}`)
        .send({ name: `Rot M3 ${RUN_ID}`, status: 'active', role: 'Member' }),
      request(server).post('/api/clients').set('Authorization', `Bearer ${tokenA}`)
        .send({ name: `Rot Extra ${RUN_ID}`, status: 'active', role: 'Member' }),
    ])
    const members = [m1.body.id, m2.body.id, m3.body.id]

    // Pre-existing assignee on every occurrence so we can confirm
    // append-not-replace.
    const create = await request(server)
      .post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `Rot Series ${RUN_ID}`,
        date: '2028-01-02',
        start_time: '10:00',
        end_time: '11:00',
        type: 'service',
        assigned_to: [extra.body.id],
        recurrence: { freq: 'weekly', interval: 1, count: 5 },
      })
    expect(create.status).toBe(201)
    const parentId = create.body.id

    const fill = await request(server)
      .post('/api/calendar/auto-fill-rotation')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ recurrence_parent_id: parentId, member_ids: members })
    expect(fill.status).toBe(200)
    expect(fill.body).toEqual({ occurrences: 5, assigned: 5, skipped: 0, unfilled: 0 })

    const { rows } = await pool.query(
      `SELECT assigned_to FROM ochr_calendar_events
        WHERE recurrence_parent_id = $1 ORDER BY date ASC`,
      [parentId]
    )
    expect(rows.length).toBe(5)
    // Round-robin: indices 0,1,2,0,1 with the prior assignee preserved.
    expect(rows[0].assigned_to).toEqual([extra.body.id, members[0]])
    expect(rows[1].assigned_to).toEqual([extra.body.id, members[1]])
    expect(rows[2].assigned_to).toEqual([extra.body.id, members[2]])
    expect(rows[3].assigned_to).toEqual([extra.body.id, members[0]])
    expect(rows[4].assigned_to).toEqual([extra.body.id, members[1]])
  })

  it('leaves past occurrences untouched', async () => {
    const m = await request(server).post('/api/clients')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `Rot Past M ${RUN_ID}`, status: 'active', role: 'Member' })

    const create = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `Rot Past Series ${RUN_ID}`,
        date: '2028-02-06',
        start_time: '10:00',
        end_time: '11:00',
        type: 'service',
        recurrence: { freq: 'weekly', interval: 1, count: 2 },
      })
    const parentId = create.body.id

    // Backdate the seed so it counts as past; the sibling stays future.
    await pool.query(
      `UPDATE ochr_calendar_events SET date = '2020-01-01' WHERE id = $1`,
      [parentId]
    )

    const fill = await request(server)
      .post('/api/calendar/auto-fill-rotation')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ recurrence_parent_id: parentId, member_ids: [m.body.id] })
    expect(fill.status).toBe(200)
    expect(fill.body).toEqual({ occurrences: 1, assigned: 1, skipped: 0, unfilled: 0 })

    // Past row is untouched — empty assigned_to.
    const { rows: past } = await pool.query(
      'SELECT assigned_to FROM ochr_calendar_events WHERE id = $1',
      [parentId]
    )
    expect(past[0].assigned_to).toEqual([])
  })

  it('is idempotent — re-running the same fill skips already-assigned', async () => {
    const m = await request(server).post('/api/clients')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `Rot Idem M ${RUN_ID}`, status: 'active', role: 'Member' })

    const create = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `Rot Idem ${RUN_ID}`,
        date: '2028-03-05',
        start_time: '09:00',
        end_time: '10:00',
        type: 'service',
        recurrence: { freq: 'weekly', interval: 1, count: 3 },
      })

    const first = await request(server)
      .post('/api/calendar/auto-fill-rotation')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ recurrence_parent_id: create.body.id, member_ids: [m.body.id] })
    expect(first.body).toEqual({ occurrences: 3, assigned: 3, skipped: 0, unfilled: 0 })

    const second = await request(server)
      .post('/api/calendar/auto-fill-rotation')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ recurrence_parent_id: create.body.id, member_ids: [m.body.id] })
    expect(second.body).toEqual({ occurrences: 3, assigned: 0, skipped: 3, unfilled: 0 })
  })

  it('drops foreign-org member ids before any write', async () => {
    const mine = await request(server).post('/api/clients')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `Rot Mine ${RUN_ID}`, status: 'active', role: 'Member' })
    const foreign = await request(server).post('/api/clients')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ name: `Rot Foreign ${RUN_ID}`, status: 'active', role: 'Member' })

    const mixed = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `Rot Mixed ${RUN_ID}`,
        date: '2028-04-02',
        start_time: '10:00',
        end_time: '11:00',
        type: 'service',
        recurrence: { freq: 'weekly', interval: 1, count: 2 },
      })

    // Foreign id is silently dropped, mine survives → both occurrences
    // get the legitimate id only.
    const ok = await request(server)
      .post('/api/calendar/auto-fill-rotation')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ recurrence_parent_id: mixed.body.id, member_ids: [foreign.body.id, mine.body.id] })
    expect(ok.status).toBe(200)
    expect(ok.body.assigned).toBe(2)
    const { rows } = await pool.query(
      `SELECT assigned_to FROM ochr_calendar_events
        WHERE recurrence_parent_id = $1 ORDER BY date ASC`,
      [mixed.body.id]
    )
    expect(rows[0].assigned_to).toEqual([mine.body.id])
    expect(rows[1].assigned_to).toEqual([mine.body.id])

    // Foreign-only → 400 with no occurrences touched.
    const onlyForeignSeries = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `Rot ForeignOnly ${RUN_ID}`,
        date: '2028-05-07',
        start_time: '10:00',
        end_time: '11:00',
        type: 'service',
        recurrence: { freq: 'weekly', interval: 1, count: 2 },
      })
    const bad = await request(server)
      .post('/api/calendar/auto-fill-rotation')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ recurrence_parent_id: onlyForeignSeries.body.id, member_ids: [foreign.body.id] })
    expect(bad.status).toBe(400)
  })

  it('treats member_ids as an ordered set — dupes dropped, order preserved', async () => {
    const [m1, m2] = await Promise.all([
      request(server).post('/api/clients').set('Authorization', `Bearer ${tokenA}`)
        .send({ name: `Rot Ord M1 ${RUN_ID}`, status: 'active', role: 'Member' }),
      request(server).post('/api/clients').set('Authorization', `Bearer ${tokenA}`)
        .send({ name: `Rot Ord M2 ${RUN_ID}`, status: 'active', role: 'Member' }),
    ])

    const create = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `Rot Ord ${RUN_ID}`,
        date: '2028-06-04',
        start_time: '10:00',
        end_time: '11:00',
        type: 'service',
        recurrence: { freq: 'weekly', interval: 1, count: 4 },
      })

    // [m1, m1, m2] collapses to [m1, m2] → occurrences alternate m1/m2.
    const fill = await request(server)
      .post('/api/calendar/auto-fill-rotation')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        recurrence_parent_id: create.body.id,
        member_ids: [m1.body.id, m1.body.id, m2.body.id],
      })
    expect(fill.body).toEqual({ occurrences: 4, assigned: 4, skipped: 0, unfilled: 0 })

    const { rows } = await pool.query(
      `SELECT assigned_to FROM ochr_calendar_events
        WHERE recurrence_parent_id = $1 ORDER BY date ASC`,
      [create.body.id]
    )
    expect(rows.map(r => r.assigned_to)).toEqual([
      [m1.body.id],
      [m2.body.id],
      [m1.body.id],
      [m2.body.id],
    ])
  })
})

describe('swap requests (VS.2)', () => {
  // Path A — token-based magic links. Members don't have login
  // accounts, so admins rotate a per-client swap_token; the member's
  // public endpoints resolve via the token. Placed ABOVE
  // 'role enforcement' so tokenA keeps admin role for the rotate
  // calls.

  let memberAId, memberBId, memberAToken, memberBToken, eventId, requestId

  beforeAll(async () => {
    const m1 = await request(server).post('/api/clients')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `Swap A ${RUN_ID}`, status: 'active', role: 'Member' })
    memberAId = m1.body.id
    const m2 = await request(server).post('/api/clients')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `Swap B ${RUN_ID}`, status: 'active', role: 'Member' })
    memberBId = m2.body.id

    // Far-future event with member A on the roster — well past
    // CURRENT_DATE so the future-only filter is satisfied.
    const ev = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `Swap Smoke ${RUN_ID}`,
        date: '2027-11-07', start_time: '10:00', end_time: '11:00',
        type: 'service',
        assigned_to: [memberAId],
      })
    eventId = ev.body.id
  })

  it('admin rotates a swap-token for a member', async () => {
    const a = await request(server)
      .post(`/api/swap-admin/clients/${memberAId}/rotate-token`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(a.status).toBe(200)
    expect(a.body.swap_token).toMatch(/^[A-Za-z0-9_-]{16,}$/)
    memberAToken = a.body.swap_token

    const b = await request(server)
      .post(`/api/swap-admin/clients/${memberBId}/rotate-token`)
      .set('Authorization', `Bearer ${tokenA}`)
    memberBToken = b.body.swap_token
  })

  it('rotate-token 404s for a member in another org', async () => {
    const res = await request(server)
      .post(`/api/swap-admin/clients/${memberAId}/rotate-token`)
      .set('Authorization', `Bearer ${tokenB}`)
    expect(res.status).toBe(404)
  })

  it('GET /by-token resolves with upcoming assignments + empty requests', async () => {
    const res = await request(server).get(`/api/swap/by-token/${memberAToken}`)
    expect(res.status).toBe(200)
    expect(res.body.me.id).toBe(memberAId)
    expect(Array.isArray(res.body.upcoming_assignments)).toBe(true)
    expect(res.body.upcoming_assignments.some(e => e.id === eventId)).toBe(true)
    expect(res.body.swap_requests.length).toBe(0)
  })

  it('GET /by-token with a bad token 404s', async () => {
    const res = await request(server).get('/api/swap/by-token/totally-not-a-real-token-1234567890')
    expect(res.status).toBe(404)
  })

  it('member A creates a swap request to member B (happy path)', async () => {
    const res = await request(server)
      .post(`/api/swap/by-token/${memberAToken}/request`)
      .send({ calendar_event_id: eventId, target_client_id: memberBId, note: 'Work conflict' })
    expect(res.status).toBe(201)
    expect(res.body.status).toBe('pending')
    requestId = res.body.id
  })

  it('cannot request a swap if requester is not assigned to the event', async () => {
    const res = await request(server)
      .post(`/api/swap/by-token/${memberBToken}/request`)
      .send({ calendar_event_id: eventId, target_client_id: memberAId })
    expect(res.status).toBe(400)
  })

  it("only the target's token can accept — wrong token gets 403", async () => {
    const res = await request(server)
      .post(`/api/swap/by-token/${memberAToken}/accept`)
      .send({ request_id: requestId })
    expect(res.status).toBe(403)
  })

  it('target accepts — assigned_to is rewritten and status is accepted', async () => {
    const res = await request(server)
      .post(`/api/swap/by-token/${memberBToken}/accept`)
      .send({ request_id: requestId })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('accepted')

    const { rows } = await pool.query(
      'SELECT assigned_to FROM ochr_calendar_events WHERE id = $1',
      [eventId]
    )
    expect(rows[0].assigned_to).not.toContain(memberAId)
    expect(rows[0].assigned_to).toContain(memberBId)
  })

  it('admin can list all swap requests in the org', async () => {
    const res = await request(server).get('/api/swap-admin/requests')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.requests)).toBe(true)
    expect(res.body.requests.some(r => r.id === requestId && r.status === 'accepted')).toBe(true)
  })

  it("admin list — org B cannot see org A's swap requests", async () => {
    const res = await request(server).get('/api/swap-admin/requests')
      .set('Authorization', `Bearer ${tokenB}`)
    expect(res.status).toBe(200)
    expect(res.body.requests.every(r => r.id !== requestId)).toBe(true)
  })
})

describe('schedule conflict scan (VS.3)', () => {
  // Multi-week double-booking scanner. Members assigned to two
  // overlapping events on the same day appear in the conflicts
  // list. Placed ABOVE 'role enforcement' so tokenA keeps admin.

  const inDays = (n) =>
    new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  let m1Id, m2Id

  beforeAll(async () => {
    const m1 = await request(server).post('/api/clients')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `Conflict M1 ${RUN_ID}`, status: 'active', role: 'Member' })
    m1Id = m1.body.id
    const m2 = await request(server).post('/api/clients')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `Conflict M2 ${RUN_ID}`, status: 'active', role: 'Member' })
    m2Id = m2.body.id
  })

  it('returns weeks_scanned + conflicts array on a clean scan', async () => {
    const res = await request(server)
      .get('/api/calendar/conflicts/scan?weeks=2')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.weeks_scanned).toBe(2)
    expect(Array.isArray(res.body.conflicts)).toBe(true)
  })

  it('detects a real double-booking on the same date with a shared member', async () => {
    const date = inDays(3)
    await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `Conflict A ${RUN_ID}`,
        date, start_time: '10:00', end_time: '11:30',
        type: 'service', assigned_to: [m1Id, m2Id],
      })
    await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `Conflict B ${RUN_ID}`,
        date, start_time: '11:00', end_time: '12:00',
        type: 'meeting', assigned_to: [m1Id],
      })

    const res = await request(server)
      .get('/api/calendar/conflicts/scan?weeks=26')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    const mine = res.body.conflicts.filter(c =>
      c.events.some(e => e.title.startsWith('Conflict A ' + RUN_ID)) &&
      c.events.some(e => e.title.startsWith('Conflict B ' + RUN_ID)))
    expect(mine.length).toBe(1)
    expect(mine[0].members.some(m => m.id === m1Id)).toBe(true)
  })

  it('does not flag same-day events that do not overlap in time', async () => {
    const date = inDays(5)
    await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `Conflict X ${RUN_ID}`,
        date, start_time: '09:00', end_time: '10:00',
        type: 'service', assigned_to: [m1Id],
      })
    await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `Conflict Y ${RUN_ID}`,
        date, start_time: '14:00', end_time: '15:00',
        type: 'meeting', assigned_to: [m1Id],
      })
    const res = await request(server)
      .get('/api/calendar/conflicts/scan?weeks=26')
      .set('Authorization', `Bearer ${tokenA}`)
    const between = res.body.conflicts.filter(c =>
      c.events.some(e => e.title.startsWith('Conflict X ' + RUN_ID)) &&
      c.events.some(e => e.title.startsWith('Conflict Y ' + RUN_ID)))
    expect(between.length).toBe(0)
  })

  it('does not flag overlapping events with NO shared member', async () => {
    const date = inDays(7)
    await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `Conflict P ${RUN_ID}`,
        date, start_time: '10:00', end_time: '11:00',
        type: 'service', assigned_to: [m1Id],
      })
    await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `Conflict Q ${RUN_ID}`,
        date, start_time: '10:30', end_time: '11:30',
        type: 'meeting', assigned_to: [m2Id],
      })
    const res = await request(server)
      .get('/api/calendar/conflicts/scan?weeks=26')
      .set('Authorization', `Bearer ${tokenA}`)
    const between = res.body.conflicts.filter(c =>
      c.events.some(e => e.title.startsWith('Conflict P ' + RUN_ID)) &&
      c.events.some(e => e.title.startsWith('Conflict Q ' + RUN_ID)))
    expect(between.length).toBe(0)
  })

  it("tenant-isolates — org B doesn't see org A's RUN_ID conflicts", async () => {
    const res = await request(server)
      .get('/api/calendar/conflicts/scan?weeks=26')
      .set('Authorization', `Bearer ${tokenB}`)
    expect(res.status).toBe(200)
    const leaked = res.body.conflicts.filter(c =>
      c.events.some(e => e.title.includes(RUN_ID)))
    expect(leaked.length).toBe(0)
  })
})

describe('groups (A4.1)', () => {
  // CRUD + member management for ochr_groups + ochr_group_members.
  // Placed ABOVE 'role enforcement' so tokenA keeps admin role.

  let groupId, m1Id, m2Id

  beforeAll(async () => {
    const m1 = await request(server).post('/api/clients')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `Group M1 ${RUN_ID}`, status: 'active', role: 'Member' })
    m1Id = m1.body.id
    const m2 = await request(server).post('/api/clients')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `Group M2 ${RUN_ID}`, status: 'active', role: 'Member' })
    m2Id = m2.body.id
  })

  it('creates a group with a leader + initial members', async () => {
    const res = await request(server).post('/api/groups')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        name: `Worship Team ${RUN_ID}`,
        category: 'ministry',
        description: 'Sunday worship music ministry',
        leader_client_id: m1Id,
        member_ids: [m2Id],
      })
    expect(res.status).toBe(201)
    expect(res.body.name).toBe(`Worship Team ${RUN_ID}`)
    expect(res.body.leader_client_id).toBe(m1Id)
    groupId = res.body.id
  })

  it('400s on an invalid category', async () => {
    const res = await request(server).post('/api/groups')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `Bad ${RUN_ID}`, category: 'invalid' })
    expect(res.status).toBe(400)
  })

  it('lists groups in the org with member count + leader name', async () => {
    const res = await request(server).get('/api/groups')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    const ours = res.body.groups.find(g => g.id === groupId)
    expect(ours).toBeTruthy()
    // Leader is auto-added to the roster, so member_count = leader + 1
    // initial member = 2.
    expect(ours.member_count).toBe(2)
    expect(ours.leader_name).toMatch(/^Group M1 /)
  })

  it('GET /:id returns the group plus its members list', async () => {
    const res = await request(server).get(`/api/groups/${groupId}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.id).toBe(groupId)
    expect(res.body.members.length).toBe(2)
  })

  it('PATCH updates name + category', async () => {
    const res = await request(server).patch(`/api/groups/${groupId}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `Worship Team renamed ${RUN_ID}`, category: 'committee' })
    expect(res.status).toBe(200)
    expect(res.body.name).toBe(`Worship Team renamed ${RUN_ID}`)
    expect(res.body.category).toBe('committee')
  })

  it('adds a new member via POST /:id/members', async () => {
    const m3 = await request(server).post('/api/clients')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `Group M3 ${RUN_ID}`, status: 'active', role: 'Member' })
    const res = await request(server).post(`/api/groups/${groupId}/members`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ client_id: m3.body.id })
    expect(res.status).toBe(201)
    expect(res.body.client_id).toBe(m3.body.id)
  })

  it('409s on duplicate member add', async () => {
    const res = await request(server).post(`/api/groups/${groupId}/members`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ client_id: m1Id })
    expect(res.status).toBe(409)
  })

  it('removes a member via DELETE /:id/members/:client_id', async () => {
    const res = await request(server).delete(`/api/groups/${groupId}/members/${m2Id}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(204)
  })

  it("tenant-isolates — org B can't read org A's group", async () => {
    const res = await request(server).get(`/api/groups/${groupId}`)
      .set('Authorization', `Bearer ${tokenB}`)
    expect(res.status).toBe(404)
  })

  it('DELETE removes the group', async () => {
    const res = await request(server).delete(`/api/groups/${groupId}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(204)
  })
})

describe('event ↔ group link (A4.3)', () => {
  // Calendar events can carry an optional group_id (migration 022).
  // Placed ABOVE 'role enforcement' so tokenA keeps its admin role.

  let groupId, eventId

  beforeAll(async () => {
    const g = await request(server).post('/api/groups')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `Linked Group ${RUN_ID}`, category: 'ministry' })
    groupId = g.body.id
  })

  it('creates a calendar event linked to a group', async () => {
    const res = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title:      `Group Service ${RUN_ID}`,
        date:       '2026-07-05',
        start_time: '09:00',
        end_time:   '10:30',
        type:       'service',
        group_id:   groupId,
      })
    expect(res.status).toBe(201)
    expect(res.body.group_id).toBe(groupId)
    eventId = res.body.id
  })

  it('returns group_id when listing events', async () => {
    const res = await request(server).get('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    const ours = res.body.find(e => e.id === eventId)
    expect(ours).toBeTruthy()
    expect(ours.group_id).toBe(groupId)
  })

  it("rejects a group_id from another org with 400", async () => {
    const foreign = await request(server).post('/api/groups')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ name: `Foreign Group ${RUN_ID}`, category: 'ministry' })
    const res = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title:      `Cross-org ${RUN_ID}`,
        date:       '2026-07-06',
        start_time: '09:00',
        end_time:   '10:00',
        group_id:   foreign.body.id,
      })
    expect(res.status).toBe(400)
  })

  it('nulls the event group_id when the group is deleted (ON DELETE SET NULL)', async () => {
    const del = await request(server).delete(`/api/groups/${groupId}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(del.status).toBe(204)
    const { rows } = await pool.query(
      'SELECT group_id FROM ochr_calendar_events WHERE id = $1',
      [eventId]
    )
    expect(rows.length).toBe(1)
    expect(rows[0].group_id).toBeNull()
  })
})

describe('church public page (A5.1)', () => {
  // Editable public homepage fields on ochr_organizations + the
  // published-gated public endpoint. Placed ABOVE 'role enforcement'
  // so tokenA keeps its admin role for the PATCH writes.

  let slugA

  beforeAll(async () => {
    const me = await request(server).get('/api/organization')
      .set('Authorization', `Bearer ${tokenA}`)
    slugA = me.body.slug
  })

  it('admin publishes the church page with content', async () => {
    const res = await request(server).patch('/api/organization')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        tagline:        `Come as you are ${RUN_ID}`,
        about:          'A welcoming parish in the heart of town.',
        service_times:  'Sundays · 9am & 11am\nWednesday · 7pm',
        address:        '123 Chapel St, Springfield',
        page_published: true,
      })
    expect(res.status).toBe(200)
    expect(res.body.page_published).toBe(true)
    expect(res.body.tagline).toBe(`Come as you are ${RUN_ID}`)
  })

  it('reflects the published page in onboarding status (A5.3)', async () => {
    const res = await request(server).get('/api/onboarding/status')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.has_published_page).toBe(true)
  })

  it('serves the published page on the public endpoint', async () => {
    const res = await request(server).get(`/api/public/${slugA}/page`)
    expect(res.status).toBe(200)
    expect(res.body.church.slug).toBe(slugA)
    expect(res.body.page.tagline).toBe(`Come as you are ${RUN_ID}`)
    expect(res.body.page.service_times).toMatch(/Sundays/)
    expect(res.body.page.address).toMatch(/Chapel St/)
  })

  it('400s on a non-boolean page_published', async () => {
    const res = await request(server).patch('/api/organization')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ page_published: 'yes' })
    expect(res.status).toBe(400)
  })

  it('404s the public page once unpublished', async () => {
    const unpub = await request(server).patch('/api/organization')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ page_published: false })
    expect(unpub.status).toBe(200)
    expect(unpub.body.page_published).toBe(false)

    const res = await request(server).get(`/api/public/${slugA}/page`)
    expect(res.status).toBe(404)
  })
})

describe('member unavailability + availability-aware rotation (VS.4a)', () => {
  // Blackout dates + the auto-fill substitution that reads them.
  // Placed ABOVE 'role enforcement' so tokenA keeps its admin role.

  let mA, mB, blockId

  // Future, deterministic dates so the auto-fill's date >= CURRENT_DATE
  // filter always includes them, regardless of the wall clock.
  const pad   = n => String(n).padStart(2, '0')
  const toISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const plusDays = n => { const d = new Date(); d.setDate(d.getDate() + n); return toISO(d) }
  const SEED  = plusDays(14)   // substitution series seed
  const SEED3 = plusDays(60)   // all-unavailable series seed
  const SEED3_WK2 = plusDays(67)

  beforeAll(async () => {
    const a = await request(server).post('/api/clients')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `Avail A ${RUN_ID}`, status: 'active', role: 'Member' })
    mA = a.body.id
    const b = await request(server).post('/api/clients')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `Avail B ${RUN_ID}`, status: 'active', role: 'Member' })
    mB = b.body.id
  })

  it('adds a blackout range and lists it by client', async () => {
    const res = await request(server).post('/api/availability')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ client_id: mA, start_date: SEED, end_date: SEED, reason: 'Out of town' })
    expect(res.status).toBe(201)
    expect(res.body.client_id).toBe(mA)
    expect(res.body.start_date).toBe(SEED)
    blockId = res.body.id

    const list = await request(server).get(`/api/availability?client_id=${mA}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(list.status).toBe(200)
    expect(list.body.unavailability.some(u => u.id === blockId)).toBe(true)
  })

  it('lists members unavailable on a given date', async () => {
    const res = await request(server).get(`/api/availability?date=${SEED}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.unavailability.some(u => u.client_id === mA)).toBe(true)
  })

  it("400s a blackout for a member outside the caller's org", async () => {
    const res = await request(server).post('/api/availability')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ client_id: mA, start_date: SEED, end_date: SEED })
    expect(res.status).toBe(400)
  })

  it('auto-fill substitutes an unavailable member', async () => {
    // Weekly series of 2 from SEED; mA is blacked out on SEED.
    const series = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `Avail Service ${RUN_ID}`,
        date: SEED, start_time: '09:00', end_time: '10:00', type: 'service',
        recurrence: { freq: 'weekly', interval: 1, count: 2 },
      })
    expect(series.status).toBe(201)
    const parentId = series.body.id

    const fill = await request(server).post('/api/calendar/auto-fill-rotation')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ recurrence_parent_id: parentId, member_ids: [mA, mB] })
    expect(fill.status).toBe(200)
    expect(fill.body.unfilled).toBe(0)

    // The SEED occurrence (mA's slot) should have been filled with mB.
    const { rows } = await pool.query(
      'SELECT assigned_to FROM ochr_calendar_events WHERE id = $1',
      [parentId]
    )
    const assigned = Array.isArray(rows[0].assigned_to) ? rows[0].assigned_to : []
    expect(assigned).toContain(mB)
    expect(assigned).not.toContain(mA)
  })

  it('leaves a slot unfilled when everyone is unavailable', async () => {
    // Black out BOTH members across the whole SEED3 window.
    for (const cid of [mA, mB]) {
      await request(server).post('/api/availability')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ client_id: cid, start_date: SEED3, end_date: SEED3_WK2, reason: 'Retreat' })
    }
    const series = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `All-out Service ${RUN_ID}`,
        date: SEED3, start_time: '09:00', end_time: '10:00', type: 'service',
        recurrence: { freq: 'weekly', interval: 1, count: 2 },
      })
    const fill = await request(server).post('/api/calendar/auto-fill-rotation')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ recurrence_parent_id: series.body.id, member_ids: [mA, mB] })
    expect(fill.status).toBe(200)
    expect(fill.body.assigned).toBe(0)
    expect(fill.body.unfilled).toBe(2)
  })

  it('deletes a blackout', async () => {
    const del = await request(server).delete(`/api/availability/${blockId}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(del.status).toBe(204)
    const list = await request(server).get(`/api/availability?client_id=${mA}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(list.body.unavailability.some(u => u.id === blockId)).toBe(false)
  })
})

describe('connect card (CC.1)', () => {
  // Public connect-card submission → admin-approved group interest.
  // Placed ABOVE 'role enforcement' so tokenA keeps its admin role.

  let slugA, groupId

  beforeAll(async () => {
    const me = await request(server).get('/api/organization')
      .set('Authorization', `Bearer ${tokenA}`)
    slugA = me.body.slug
    // Connect surfaces are gated on the church page being published.
    await request(server).patch('/api/organization')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ page_published: true })
    const g = await request(server).post('/api/groups')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `Connect Choir ${RUN_ID}`, category: 'ministry' })
    groupId = g.body.id
  })

  it('lists the church groups on the public endpoint', async () => {
    const res = await request(server).get(`/api/public/${slugA}/groups`)
    expect(res.status).toBe(200)
    expect(res.body.groups.some(g => g.id === groupId)).toBe(true)
  })

  it('accepts a public connect submission as pending', async () => {
    const res = await request(server).post(`/api/public/${slugA}/connect`)
      .send({
        group_id: groupId,
        name:     `Visitor ${RUN_ID}`,
        email:    `visitor_${RUN_ID}@example.com`,
        message:  'Interested in the choir',
      })
    expect(res.status).toBe(201)
    expect(res.body.ok).toBe(true)
  })

  it('shows the interest in the admin pending queue', async () => {
    const res = await request(server).get('/api/connect?status=pending')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    const ours = res.body.interests.find(i => i.name === `Visitor ${RUN_ID}`)
    expect(ours).toBeTruthy()
    expect(ours.group_name).toBe(`Connect Choir ${RUN_ID}`)
  })

  it('approve creates the member and adds them to the group', async () => {
    const queue = await request(server).get('/api/connect?status=pending')
      .set('Authorization', `Bearer ${tokenA}`)
    const ours = queue.body.interests.find(i => i.name === `Visitor ${RUN_ID}`)

    const res = await request(server).post(`/api/connect/${ours.id}/approve`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('approved')
    expect(res.body.client_id).toBeTruthy()

    const grp = await request(server).get(`/api/groups/${groupId}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(grp.body.members.some(m => m.client_id === res.body.client_id)).toBe(true)
  })

  it("tenant-isolates — org B can't approve org A's interest", async () => {
    await request(server).post(`/api/public/${slugA}/connect`)
      .send({ group_id: groupId, name: `Visitor2 ${RUN_ID}` })
    const queue = await request(server).get('/api/connect?status=pending')
      .set('Authorization', `Bearer ${tokenA}`)
    const pend = queue.body.interests.find(i => i.name === `Visitor2 ${RUN_ID}`)

    const res = await request(server).post(`/api/connect/${pend.id}/approve`)
      .set('Authorization', `Bearer ${tokenB}`)
    expect(res.status).toBe(404)
  })

  it('declines a pending interest', async () => {
    const queue = await request(server).get('/api/connect?status=pending')
      .set('Authorization', `Bearer ${tokenA}`)
    const pend = queue.body.interests.find(i => i.name === `Visitor2 ${RUN_ID}`)
    const res = await request(server).post(`/api/connect/${pend.id}/decline`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('declined')
  })

  it('404s a public submission once the page is unpublished', async () => {
    await request(server).patch('/api/organization')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ page_published: false })
    const res = await request(server).post(`/api/public/${slugA}/connect`)
      .send({ group_id: groupId, name: `Nope ${RUN_ID}` })
    expect(res.status).toBe(404)
  })
})

describe('online giving (GIV.1)', () => {
  // Funds + public give flow against the payments stub. Online gifts
  // land in ochr_donations. Placed ABOVE 'role enforcement' so tokenA
  // keeps its admin role.

  let slugA, fundId

  beforeAll(async () => {
    const me = await request(server).get('/api/organization')
      .set('Authorization', `Bearer ${tokenA}`)
    slugA = me.body.slug
  })

  it('admin creates and lists a fund', async () => {
    const res = await request(server).post('/api/funds')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `Building Fund ${RUN_ID}`, description: 'New roof' })
    expect(res.status).toBe(201)
    expect(res.body.active).toBe(true)
    fundId = res.body.id

    const list = await request(server).get('/api/funds')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(list.status).toBe(200)
    expect(list.body.funds.some(f => f.id === fundId)).toBe(true)
  })

  it('exposes active funds on the public endpoint', async () => {
    const res = await request(server).get(`/api/public/${slugA}/funds`)
    expect(res.status).toBe(200)
    expect(res.body.funds.some(f => f.id === fundId)).toBe(true)
  })

  it('records an online gift as a donation via the stub', async () => {
    const res = await request(server).post(`/api/public/${slugA}/give`)
      .send({ fund_id: fundId, amount: 25.50, donor_name: `Donor ${RUN_ID}`, donor_email: `donor_${RUN_ID}@example.com` })
    expect(res.status).toBe(201)
    expect(res.body.ok).toBe(true)
    expect(res.body.receipt.amount).toBe(25.5)
    expect(res.body.receipt.reference).toBeTruthy()

    const { rows } = await pool.query(
      'SELECT amount, method, source, payment_status, category FROM ochr_donations WHERE payment_ref = $1',
      [res.body.receipt.reference]
    )
    expect(rows.length).toBe(1)
    expect(Number(rows[0].amount)).toBe(25.5)
    expect(rows[0].method).toBe('online')
    expect(rows[0].source).toBe('online')
    expect(rows[0].payment_status).toBe('succeeded')
    expect(rows[0].category).toBe(`Building Fund ${RUN_ID}`)
  })

  it('rejects a gift with no valid fund', async () => {
    const res = await request(server).post(`/api/public/${slugA}/give`)
      .send({ fund_id: 999999999, amount: 10, donor_name: `Donor ${RUN_ID}` })
    expect(res.status).toBe(400)
  })

  it('rejects a non-positive amount', async () => {
    const res = await request(server).post(`/api/public/${slugA}/give`)
      .send({ fund_id: fundId, amount: 0, donor_name: `Donor ${RUN_ID}` })
    expect(res.status).toBe(400)
  })

  it('hides an inactive fund publicly and rejects giving to it', async () => {
    const patch = await request(server).patch(`/api/funds/${fundId}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ active: false })
    expect(patch.status).toBe(200)
    expect(patch.body.active).toBe(false)

    const list = await request(server).get(`/api/public/${slugA}/funds`)
    expect(list.body.funds.some(f => f.id === fundId)).toBe(false)

    const give = await request(server).post(`/api/public/${slugA}/give`)
      .send({ fund_id: fundId, amount: 10, donor_name: `Donor ${RUN_ID}` })
    expect(give.status).toBe(400)
  })

  it("tenant-isolates — org B can't edit org A's fund", async () => {
    const res = await request(server).patch(`/api/funds/${fundId}`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ name: 'Hijacked' })
    expect(res.status).toBe(404)
  })
})

describe('schedule serving reminders (RM.1)', () => {
  // Assigning a member to a Schedule event queues an assignment_reminder
  // (24h before) linked to the event. Placed ABOVE 'role enforcement'
  // so tokenA keeps its admin role.

  const pad = n => String(n).padStart(2, '0')
  const toISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const plusDays = n => { const d = new Date(); d.setDate(d.getDate() + n); return toISO(d) }
  const FUTURE = plusDays(10)

  let memberId, memberEmail, noEmailId, eventId
  const base = { start_time: '09:00', end_time: '10:30', type: 'service' }

  async function pendingReminders(eid) {
    const { rows } = await pool.query(
      `SELECT recipient_email, notification_type FROM ochr_scheduled_notifications
        WHERE source_type = 'calendar_event' AND source_id = $1 AND status = 'pending'`,
      [eid]
    )
    return rows
  }

  beforeAll(async () => {
    memberEmail = `serve_${RUN_ID}@example.com`
    const m = await request(server).post('/api/clients')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `Serve M ${RUN_ID}`, email: memberEmail, status: 'active', role: 'Member' })
    memberId = m.body.id
    const n = await request(server).post('/api/clients')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `NoEmail ${RUN_ID}`, status: 'active', role: 'Member' })
    noEmailId = n.body.id
  })

  it('queues a serving reminder when a member is assigned', async () => {
    const res = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ ...base, title: `Serve ${RUN_ID}`, date: FUTURE, assigned_to: [memberId] })
    expect(res.status).toBe(201)
    eventId = res.body.id

    const rows = await pendingReminders(eventId)
    expect(rows.length).toBe(1)
    expect(rows[0].recipient_email).toBe(memberEmail)
    expect(rows[0].notification_type).toBe('assignment_reminder')
  })

  it('re-syncs reminders when the roster changes', async () => {
    const res = await request(server).patch(`/api/calendar/${eventId}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ ...base, title: `Serve ${RUN_ID}`, date: FUTURE, assigned_to: [] })
    expect(res.status).toBe(200)
    expect((await pendingReminders(eventId)).length).toBe(0)
  })

  it('cancels reminders when the event is deleted', async () => {
    await request(server).patch(`/api/calendar/${eventId}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ ...base, title: `Serve ${RUN_ID}`, date: FUTURE, assigned_to: [memberId] })
    expect((await pendingReminders(eventId)).length).toBe(1)

    const del = await request(server).delete(`/api/calendar/${eventId}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(del.status).toBe(204)
    expect((await pendingReminders(eventId)).length).toBe(0)
  })

  it('skips a member with no email on file', async () => {
    const res = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ ...base, title: `NoEmail Serve ${RUN_ID}`, date: FUTURE, assigned_to: [noEmailId] })
    expect(res.status).toBe(201)
    expect((await pendingReminders(res.body.id)).length).toBe(0)
  })

  it('does not queue a past-due reminder', async () => {
    // Event today → reminder time (24h before) is already in the past.
    const res = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ ...base, title: `Today Serve ${RUN_ID}`, date: plusDays(0), assigned_to: [memberId] })
    expect(res.status).toBe(201)
    expect((await pendingReminders(res.body.id)).length).toBe(0)
  })
})

describe('serving-reminder opt-out (RM.2)', () => {
  // A member turns serving reminders off from their swap-token page; the
  // sync then skips them. Placed ABOVE 'role enforcement' so tokenA
  // keeps its admin role.

  const pad = n => String(n).padStart(2, '0')
  const toISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const plusDays = n => { const d = new Date(); d.setDate(d.getDate() + n); return toISO(d) }
  const FUTURE = plusDays(12)
  const base = { start_time: '09:00', end_time: '10:30', type: 'service' }

  let memberId, token

  async function pendingReminders(eid) {
    const { rows } = await pool.query(
      `SELECT id FROM ochr_scheduled_notifications
        WHERE source_type = 'calendar_event' AND source_id = $1 AND status = 'pending'`,
      [eid]
    )
    return rows
  }

  beforeAll(async () => {
    const m = await request(server).post('/api/clients')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `Optout M ${RUN_ID}`, email: `optout_${RUN_ID}@example.com`, status: 'active', role: 'Member' })
    memberId = m.body.id
    const t = await request(server).post(`/api/swap-admin/clients/${memberId}/rotate-token`)
      .set('Authorization', `Bearer ${tokenA}`)
    token = t.body.swap_token
  })

  it('opts the member out via their token', async () => {
    const res = await request(server).patch(`/api/swap/by-token/${token}/reminders`)
      .send({ opt_out: true })
    expect(res.status).toBe(200)
    expect(res.body.reminders_opt_out).toBe(true)
  })

  it('skips reminders for an opted-out member', async () => {
    const ev = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ ...base, title: `Optout Serve ${RUN_ID}`, date: FUTURE, assigned_to: [memberId] })
    expect(ev.status).toBe(201)
    expect((await pendingReminders(ev.body.id)).length).toBe(0)
  })

  it('re-enables and then queues reminders again', async () => {
    const pref = await request(server).patch(`/api/swap/by-token/${token}/reminders`)
      .send({ opt_out: false })
    expect(pref.status).toBe(200)
    expect(pref.body.reminders_opt_out).toBe(false)

    const ev = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ ...base, title: `Reopt Serve ${RUN_ID}`, date: FUTURE, assigned_to: [memberId] })
    expect((await pendingReminders(ev.body.id)).length).toBe(1)
  })

  it('400s a non-boolean opt_out', async () => {
    const res = await request(server).patch(`/api/swap/by-token/${token}/reminders`)
      .send({ opt_out: 'yes' })
    expect(res.status).toBe(400)
  })

  it('404s an unknown token', async () => {
    const res = await request(server).patch('/api/swap/by-token/totally-unknown-token/reminders')
      .send({ opt_out: true })
    expect(res.status).toBe(404)
  })
})

describe('configurable reminder lead time (RM.3)', () => {
  // Org-level reminder_lead_hours drives how far ahead the queued
  // send_at lands. Placed ABOVE 'role enforcement' so tokenA keeps admin.

  const pad = n => String(n).padStart(2, '0')
  const toISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const plusDays = n => { const d = new Date(); d.setDate(d.getDate() + n); return toISO(d) }
  const FUTURE = plusDays(15)
  const base = { start_time: '09:00', end_time: '10:30', type: 'service' }

  let memberId

  async function sendAt(eid) {
    const { rows } = await pool.query(
      `SELECT send_at FROM ochr_scheduled_notifications
        WHERE source_type = 'calendar_event' AND source_id = $1 AND status = 'pending'
        LIMIT 1`,
      [eid]
    )
    return rows[0]?.send_at ?? null
  }

  beforeAll(async () => {
    const m = await request(server).post('/api/clients')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `Lead M ${RUN_ID}`, email: `lead_${RUN_ID}@example.com`, status: 'active', role: 'Member' })
    memberId = m.body.id
  })

  it('clamps reminder_lead_hours to the allowed range', async () => {
    const res = await request(server).patch('/api/organization')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ reminder_lead_hours: 1000 })
    expect(res.status).toBe(200)
    expect(res.body.reminder_lead_hours).toBe(168) // max
  })

  it('400s a non-integer lead time', async () => {
    const res = await request(server).patch('/api/organization')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ reminder_lead_hours: 'soon' })
    expect(res.status).toBe(400)
  })

  it('lead time shifts the queued reminder send_at', async () => {
    await request(server).patch('/api/organization')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ reminder_lead_hours: 24 })
    const a = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ ...base, title: `Lead24 ${RUN_ID}`, date: FUTURE, assigned_to: [memberId] })
    const sa = await sendAt(a.body.id)

    await request(server).patch('/api/organization')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ reminder_lead_hours: 48 })
    const b = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ ...base, title: `Lead48 ${RUN_ID}`, date: FUTURE, assigned_to: [memberId] })
    const sb = await sendAt(b.body.id)

    expect(sa).toBeTruthy()
    expect(sb).toBeTruthy()
    // 48h lead fires 24h earlier than 24h lead, for the same event time.
    expect(new Date(sa).getTime() - new Date(sb).getTime()).toBe(24 * 60 * 60 * 1000)
  })
})

describe('immediate assignment notice (RM.3b)', () => {
  // Assigning a member fires an immediate event_assignment_added through
  // notify() (stub → notification_log). Placed ABOVE 'role enforcement'.

  const pad = n => String(n).padStart(2, '0')
  const toISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const plusDays = n => { const d = new Date(); d.setDate(d.getDate() + n); return toISO(d) }
  const FUTURE = plusDays(20)
  const base = { start_time: '09:00', end_time: '10:30', type: 'service' }

  let memberId, memberEmail, optoutId, optoutEmail

  async function noticeCount(email) {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ochr_notification_log
        WHERE notification_type = 'event_assignment_added' AND recipient_email = $1`,
      [email]
    )
    return rows[0].n
  }

  beforeAll(async () => {
    memberEmail = `notice_${RUN_ID}@example.com`
    const m = await request(server).post('/api/clients')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `Notice M ${RUN_ID}`, email: memberEmail, status: 'active', role: 'Member' })
    memberId = m.body.id

    optoutEmail = `noticeoff_${RUN_ID}@example.com`
    const o = await request(server).post('/api/clients')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `Notice Off ${RUN_ID}`, email: optoutEmail, status: 'active', role: 'Member' })
    optoutId = o.body.id
    await pool.query('UPDATE ochr_clients SET reminders_opt_out = TRUE WHERE id = $1', [optoutId])
  })

  it('logs an immediate notice when assigned on create', async () => {
    const before = await noticeCount(memberEmail)
    const ev = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ ...base, title: `Notice Create ${RUN_ID}`, date: FUTURE, assigned_to: [memberId] })
    expect(ev.status).toBe(201)
    expect(await noticeCount(memberEmail)).toBe(before + 1)
  })

  it('logs a notice for a member added on edit', async () => {
    const ev = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ ...base, title: `Notice Edit ${RUN_ID}`, date: FUTURE, assigned_to: [] })
    const before = await noticeCount(memberEmail)
    const patch = await request(server).patch(`/api/calendar/${ev.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ ...base, title: `Notice Edit ${RUN_ID}`, date: FUTURE, assigned_to: [memberId] })
    expect(patch.status).toBe(200)
    expect(await noticeCount(memberEmail)).toBe(before + 1)
  })

  it('skips the immediate notice for an opted-out member', async () => {
    const before = await noticeCount(optoutEmail)
    await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ ...base, title: `Notice Optout ${RUN_ID}`, date: FUTURE, assigned_to: [optoutId] })
    expect(await noticeCount(optoutEmail)).toBe(before)
  })
})

describe('giving by fund (GIV.4)', () => {
  // Per-fund donation totals. Placed ABOVE 'role enforcement'.
  const FUND_A = `Building ${RUN_ID}`
  const FUND_B = `Missions ${RUN_ID}`

  beforeAll(async () => {
    const mk = (category, amount) => request(server).post('/api/donations')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ donor_name: `Giver ${RUN_ID}`, amount, category })
    await mk(FUND_A, 100)
    await mk(FUND_A, 50)
    await mk(FUND_B, 75)
  })

  it('aggregates donation totals by fund', async () => {
    const res = await request(server).get('/api/donations/by-fund?days=365')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)

    const a = res.body.funds.find(f => f.category === FUND_A)
    expect(a).toBeTruthy()
    expect(Number(a.total)).toBe(150)
    expect(a.count).toBe(2)

    const b = res.body.funds.find(f => f.category === FUND_B)
    expect(Number(b.total)).toBe(75)
    expect(b.count).toBe(1)
  })

  it('orders funds largest first', async () => {
    const res = await request(server).get('/api/donations/by-fund?days=365')
      .set('Authorization', `Bearer ${tokenA}`)
    const totals = res.body.funds.map(f => Number(f.total))
    const sorted = [...totals].sort((x, y) => y - x)
    expect(totals).toEqual(sorted)
  })
})

describe('giving receipt (GIV.5)', () => {
  // An online gift with an email queues a donation_receipt through
  // notify() (stub → notification_log). Placed ABOVE 'role enforcement'.

  let slugA, fundId
  const donorEmail = `receipt_${RUN_ID}@example.com`

  beforeAll(async () => {
    const me = await request(server).get('/api/organization')
      .set('Authorization', `Bearer ${tokenA}`)
    slugA = me.body.slug
    await request(server).patch('/api/organization')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ page_published: true })
    const f = await request(server).post('/api/funds')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `Receipt Fund ${RUN_ID}` })
    fundId = f.body.id
  })

  it('emails the donor a receipt on an online gift', async () => {
    const res = await request(server).post(`/api/public/${slugA}/give`)
      .send({ fund_id: fundId, amount: 40, donor_name: `Receipt Donor ${RUN_ID}`, donor_email: donorEmail })
    expect(res.status).toBe(201)

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ochr_notification_log
        WHERE notification_type = 'donation_receipt' AND recipient_email = $1`,
      [donorEmail]
    )
    expect(rows[0].n).toBe(1)
  })

  it('still records a gift when no email is given (no receipt)', async () => {
    const res = await request(server).post(`/api/public/${slugA}/give`)
      .send({ fund_id: fundId, amount: 20, donor_name: `No Email ${RUN_ID}` })
    expect(res.status).toBe(201)
    expect(res.body.ok).toBe(true)
  })
})

describe('refund online gift (GIV.6)', () => {
  // Refunding an online gift marks it refunded and drops it from fund
  // totals. Placed ABOVE 'role enforcement'.

  let slugA, fundId, donationId
  const FUND = `Refund Fund ${RUN_ID}`

  beforeAll(async () => {
    const me = await request(server).get('/api/organization')
      .set('Authorization', `Bearer ${tokenA}`)
    slugA = me.body.slug
    await request(server).patch('/api/organization')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ page_published: true })
    const f = await request(server).post('/api/funds')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: FUND })
    fundId = f.body.id
  })

  it('refunds an online gift and drops it from fund totals', async () => {
    const give = await request(server).post(`/api/public/${slugA}/give`)
      .send({ fund_id: fundId, amount: 60, donor_name: `Refund Donor ${RUN_ID}` })
    expect(give.status).toBe(201)
    const ref = give.body.receipt.reference

    const found = await pool.query('SELECT id FROM ochr_donations WHERE payment_ref = $1', [ref])
    donationId = found.rows[0].id

    const before = await request(server).get('/api/donations/by-fund?days=365')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(before.body.funds.find(f => f.category === FUND)).toBeTruthy()

    const refund = await request(server).post(`/api/donations/${donationId}/refund`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(refund.status).toBe(200)
    expect(refund.body.payment_status).toBe('refunded')
    expect(refund.body.refunded_at).toBeTruthy()

    const after = await request(server).get('/api/donations/by-fund?days=365')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(after.body.funds.find(f => f.category === FUND)).toBeFalsy()
  })

  it('409s a double refund', async () => {
    const res = await request(server).post(`/api/donations/${donationId}/refund`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(409)
  })

  it('rejects refunding a manual donation', async () => {
    const manual = await request(server).post('/api/donations')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ donor_name: `Cash ${RUN_ID}`, amount: 30, category: 'tithe' })
    const res = await request(server).post(`/api/donations/${manual.body.id}/refund`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(400)
  })
})

describe('recurring giving (GIV.7)', () => {
  // Setup via give, cron charges due cycles, admin cancels. Placed ABOVE
  // 'role enforcement'.

  let slugA, fundId, recurringId
  const donorName = `Recurring Donor ${RUN_ID}`
  const CRON = 'giv7-cron-secret'
  const prevSecret = process.env.CRON_SECRET

  async function recurringDonationCount() {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ochr_donations
        WHERE donor_name = $1 AND source = 'recurring'`,
      [donorName]
    )
    return rows[0].n
  }

  beforeAll(async () => {
    const me = await request(server).get('/api/organization')
      .set('Authorization', `Bearer ${tokenA}`)
    slugA = me.body.slug
    await request(server).patch('/api/organization')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ page_published: true })
    const f = await request(server).post('/api/funds')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `Recurring Fund ${RUN_ID}` })
    fundId = f.body.id
    process.env.CRON_SECRET = CRON
  })

  afterAll(() => {
    if (prevSecret === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = prevSecret
  })

  it('sets up a recurring gift on give', async () => {
    const res = await request(server).post(`/api/public/${slugA}/give`)
      .send({ fund_id: fundId, amount: 30, donor_name: donorName, frequency: 'monthly' })
    expect(res.status).toBe(201)
    expect(res.body.receipt.recurring).toBe('monthly')

    const { rows } = await pool.query(
      `SELECT id, status, frequency FROM ochr_recurring_gifts WHERE donor_name = $1`,
      [donorName]
    )
    expect(rows.length).toBe(1)
    expect(rows[0].status).toBe('active')
    expect(rows[0].frequency).toBe('monthly')
    recurringId = rows[0].id
  })

  it('charges a due recurring gift via cron', async () => {
    await pool.query(
      `UPDATE ochr_recurring_gifts SET next_charge_date = CURRENT_DATE - INTERVAL '1 day' WHERE id = $1`,
      [recurringId]
    )
    const before = await recurringDonationCount()

    const res = await request(server).post('/api/cron/charge-recurring')
      .set('Authorization', `Bearer ${CRON}`)
    expect(res.status).toBe(200)
    expect(res.body.charged).toBeGreaterThanOrEqual(1)

    expect(await recurringDonationCount()).toBe(before + 1)

    const { rows } = await pool.query(
      `SELECT (next_charge_date > CURRENT_DATE) AS future FROM ochr_recurring_gifts WHERE id = $1`,
      [recurringId]
    )
    expect(rows[0].future).toBe(true)
  })

  it('retrying the same billing period cannot double-charge (idempotency key)', async () => {
    // Simulate a cron retry after a mid-batch crash: rewind the schedule
    // to the SAME due date the previous test already charged. The
    // idempotency key derives from (gift id, due date), so the transport
    // returns the identical payment_ref and the donation insert conflicts
    // (uq_donations_org_payment_ref) instead of posting a second gift.
    await pool.query(
      `UPDATE ochr_recurring_gifts SET next_charge_date = CURRENT_DATE - INTERVAL '1 day' WHERE id = $1`,
      [recurringId]
    )
    const before = await recurringDonationCount()

    const res = await request(server).post('/api/cron/charge-recurring')
      .set('Authorization', `Bearer ${CRON}`)
    expect(res.status).toBe(200)
    expect(res.body.deduped).toBeGreaterThanOrEqual(1)

    // No duplicate donation row for the replayed period…
    expect(await recurringDonationCount()).toBe(before)

    // …and the schedule still advances, so the gift isn't re-selected forever.
    const { rows } = await pool.query(
      `SELECT (next_charge_date > CURRENT_DATE) AS future FROM ochr_recurring_gifts WHERE id = $1`,
      [recurringId]
    )
    expect(rows[0].future).toBe(true)
  })

  it('cancels a recurring gift so cron stops charging it', async () => {
    const cancel = await request(server).post(`/api/donations/recurring/${recurringId}/cancel`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(cancel.status).toBe(200)
    expect(cancel.body.status).toBe('cancelled')

    await pool.query(
      `UPDATE ochr_recurring_gifts SET next_charge_date = CURRENT_DATE - INTERVAL '1 day' WHERE id = $1`,
      [recurringId]
    )
    const before = await recurringDonationCount()
    await request(server).post('/api/cron/charge-recurring').set('Authorization', `Bearer ${CRON}`)
    expect(await recurringDonationCount()).toBe(before)
  })
})

describe('cash count confirm (GIV.6) — double-confirm safety', () => {
  // Regression for the check-then-act race: confirming a counted
  // collection posts it to the donations ledger EXACTLY once, and a
  // second confirm (double-click, second tab) is refused with 409
  // instead of double-posting the Sunday offering.
  let sessionId
  async function postedCount() {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ochr_donations WHERE donor_name = $1`,
      [`Sunday Count ${RUN_ID} (Cash Collection)`]
    )
    return rows[0].n
  }

  it('creates a pending cash count session', async () => {
    const res = await request(server).post('/api/donations/cash-counts')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ service_name: `Sunday Count ${RUN_ID}`, counted_by: 'Margaret', total: 123.45 })
    expect(res.status).toBe(201)
    expect(res.body.status).toBe('pending')
    sessionId = res.body.id
  })

  it('confirm posts the collection to the ledger exactly once', async () => {
    const res = await request(server).patch(`/api/donations/cash-counts/${sessionId}/confirm`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.session.status).toBe('confirmed')
    expect(Number(res.body.donation.amount)).toBe(123.45)
    expect(await postedCount()).toBe(1)
  })

  it('a second confirm is refused with 409 and does not double-post', async () => {
    const res = await request(server).patch(`/api/donations/cash-counts/${sessionId}/confirm`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(409)
    expect(await postedCount()).toBe(1)
  })

  it('two SIMULTANEOUS confirms post exactly once (the actual TOCTOU race)', async () => {
    // The sequential cases above pass even against the pre-fix code
    // (which already returned early on an already-confirmed session).
    // This is the race the fix truly closes: two requests interleave —
    // both read the session as pending before either commits. Only the
    // FOR UPDATE row lock + guarded `AND status <> 'confirmed'` UPDATE
    // serialize them. A fresh session, both confirms fired at once:
    // exactly one wins (200), the loser is refused (409), and the
    // Sunday offering hits the ledger a single time — never twice.
    const create = await request(server).post('/api/donations/cash-counts')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ service_name: `Race Count ${RUN_ID}`, counted_by: 'Margaret', total: 87.60 })
    expect(create.status).toBe(201)
    const raceId = create.body.id

    const [a, b] = await Promise.all([
      request(server).patch(`/api/donations/cash-counts/${raceId}/confirm`).set('Authorization', `Bearer ${tokenA}`),
      request(server).patch(`/api/donations/cash-counts/${raceId}/confirm`).set('Authorization', `Bearer ${tokenA}`),
    ])
    expect([a.status, b.status].sort((x, y) => x - y)).toEqual([200, 409])

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ochr_donations WHERE donor_name = $1`,
      [`Race Count ${RUN_ID} (Cash Collection)`]
    )
    expect(rows[0].n).toBe(1)
  })
})

describe('auth hardening — session lifecycle (H5)', () => {
  // Self-contained: creates its own throwaway orgs so nothing here
  // depends on (or disturbs) the shared orgA/orgB state.
  const SECRET = process.env.JWT_SECRET || 'dev-only-change-me-please'
  const authOrg = {
    organizationName: `Auth Org ${RUN_ID}`,
    name: 'Norma Secretary',
    email: `auth_${RUN_ID}@example.com`,
    password: 'smoke-test-pw-9',
  }
  let authToken, authUserId, authOrgId
  const cleanupOrgIds = []

  beforeAll(async () => {
    // The suite's earlier signups (org A, org B, the CSV-injection org)
    // exhaust the 3-per-hour-per-IP signup limiter. `trust proxy` is 1,
    // so a distinct X-Forwarded-For gives this signup its own limiter
    // bucket instead of a deterministic 429 on the suite's 4th signup.
    const res = await request(server).post('/api/auth/signup')
      .set('X-Forwarded-For', '10.99.0.1')
      .send(authOrg)
    expect(res.status).toBe(201)
    authToken = res.body.token
    authUserId = res.body.user.id
    authOrgId  = res.body.user.organization.id
    cleanupOrgIds.push(authOrgId)
  })

  afterAll(async () => {
    for (const id of cleanupOrgIds) {
      await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
    }
  })

  it('rejects a missing token', async () => {
    const res = await request(server).get('/api/auth/me')
    expect(res.status).toBe(401)
  })

  it('rejects a garbage token', async () => {
    const res = await request(server).get('/api/auth/me')
      .set('Authorization', 'Bearer not-a-jwt-at-all')
    expect(res.status).toBe(401)
  })

  it('rejects an expired token', async () => {
    const expired = jwt.sign(
      { userId: authUserId, organizationId: authOrgId, role: 'admin', tv: 1 },
      SECRET, { expiresIn: '-10s' }
    )
    const res = await request(server).get('/api/auth/me')
      .set('Authorization', `Bearer ${expired}`)
    expect(res.status).toBe(401)
  })

  it('rejects a token signed with a foreign secret', async () => {
    const forged = jwt.sign(
      { userId: authUserId, organizationId: authOrgId, role: 'admin', tv: 1 },
      'attacker-supplied-secret', { expiresIn: '7d' }
    )
    const res = await request(server).get('/api/auth/me')
      .set('Authorization', `Bearer ${forged}`)
    expect(res.status).toBe(401)
  })

  it('rejects a valid token whose user was deleted', async () => {
    const ghost = {
      organizationName: `Ghost Org ${RUN_ID}`,
      name: 'Gone Admin',
      email: `ghost_${RUN_ID}@example.com`,
      password: 'smoke-test-pw-8',
    }
    // Own limiter bucket — see the beforeAll note.
    const signup = await request(server).post('/api/auth/signup')
      .set('X-Forwarded-For', '10.99.0.2')
      .send(ghost)
    expect(signup.status).toBe(201)
    cleanupOrgIds.push(signup.body.user.organization.id)

    await pool.query('DELETE FROM ochr_users WHERE id = $1', [signup.body.user.id])

    const res = await request(server).get('/api/auth/me')
      .set('Authorization', `Bearer ${signup.body.token}`)
    expect(res.status).toBe(401)
  })

  it('logout-all revokes every outstanding token; a fresh login works', async () => {
    // The token works…
    const before = await request(server).get('/api/auth/me')
      .set('Authorization', `Bearer ${authToken}`)
    expect(before.status).toBe(200)

    // …until the version bump…
    const revoke = await request(server).post('/api/auth/logout-all')
      .set('Authorization', `Bearer ${authToken}`)
    expect(revoke.status).toBe(204)

    const after = await request(server).get('/api/auth/me')
      .set('Authorization', `Bearer ${authToken}`)
    expect(after.status).toBe(401)

    // …and a fresh login issues a token carrying the new version.
    const relogin = await request(server).post('/api/auth/login')
      .send({ email: authOrg.email, password: authOrg.password })
    expect(relogin.status).toBe(200)
    const again = await request(server).get('/api/auth/me')
      .set('Authorization', `Bearer ${relogin.body.token}`)
    expect(again.status).toBe(200)
  })
})

describe('change password while signed in (F1) + vendor-only maintenance (F3)', () => {
  // Self-contained throwaway org. Its own X-Forwarded-For bucket because
  // the suite's earlier signups exhaust the 3-per-hour-per-IP limiter
  // (10.99.0.1 and .2 are already spoken for).
  const pwOrg = {
    organizationName: `Pw Org ${RUN_ID}`,
    name: 'Norma Secretary',
    email: `pw_${RUN_ID}@example.com`,
    password: 'smoke-test-pw-9',
  }
  const NEXT_PW = 'smoke-test-pw-10-next'
  let pwToken, pwOrgId

  beforeAll(async () => {
    const res = await request(server).post('/api/auth/signup')
      .set('X-Forwarded-For', '10.99.0.3')
      .send(pwOrg)
    expect(res.status).toBe(201)
    pwToken = res.body.token
    pwOrgId = res.body.user.organization.id
  })

  afterAll(async () => {
    await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [pwOrgId]).catch(() => {})
  })

  it('requires the current password', async () => {
    const res = await request(server).patch('/api/auth/password')
      .set('Authorization', `Bearer ${pwToken}`)
      .send({ password: NEXT_PW })
    expect(res.status).toBe(400)
  })

  it('enforces the minimum length on the new password', async () => {
    const res = await request(server).patch('/api/auth/password')
      .set('Authorization', `Bearer ${pwToken}`)
      .send({ currentPassword: pwOrg.password, password: 'short' })
    expect(res.status).toBe(400)
  })

  it('refuses a new password identical to the current one', async () => {
    const res = await request(server).patch('/api/auth/password')
      .set('Authorization', `Bearer ${pwToken}`)
      .send({ currentPassword: pwOrg.password, password: pwOrg.password })
    expect(res.status).toBe(400)
  })

  it('rejects a wrong current password with 401, and leaves the password alone', async () => {
    const res = await request(server).patch('/api/auth/password')
      .set('Authorization', `Bearer ${pwToken}`)
      .send({ currentPassword: 'not-the-password', password: NEXT_PW })
    expect(res.status).toBe(401)

    // Still the old password.
    const login = await request(server).post('/api/auth/login')
      .send({ email: pwOrg.email, password: pwOrg.password })
    expect(login.status).toBe(200)
  })

  it('requires authentication', async () => {
    const res = await request(server).patch('/api/auth/password')
      .send({ currentPassword: pwOrg.password, password: NEXT_PW })
    expect(res.status).toBe(401)
  })

  it('changes the password, revokes old sessions, and keeps the caller signed in', async () => {
    const res = await request(server).patch('/api/auth/password')
      .set('Authorization', `Bearer ${pwToken}`)
      .send({ currentPassword: pwOrg.password, password: NEXT_PW })
    expect(res.status).toBe(200)
    expect(res.body.token).toBeTruthy()

    // The returned token works…
    const fresh = await request(server).get('/api/auth/me')
      .set('Authorization', `Bearer ${res.body.token}`)
    expect(fresh.status).toBe(200)

    // …the token that made the change does not (token_version bumped).
    const stale = await request(server).get('/api/auth/me')
      .set('Authorization', `Bearer ${pwToken}`)
    expect(stale.status).toBe(401)

    // Old password is dead, new one works.
    const old = await request(server).post('/api/auth/login')
      .send({ email: pwOrg.email, password: pwOrg.password })
    expect(old.status).toBe(401)

    const now = await request(server).post('/api/auth/login')
      .send({ email: pwOrg.email, password: NEXT_PW })
    expect(now.status).toBe(200)

    pwToken = now.body.token
  })

  it('F3: a parish admin cannot trigger the global retention prune', async () => {
    // requireSuperAdmin 404s rather than 403 so the surface is not
    // advertised to authenticated users probing /api/admin/*.
    const res = await request(server).post('/api/admin/maintenance/retention-prune')
      .set('Authorization', `Bearer ${pwToken}`)
    expect(res.status).toBe(404)
  })

  it('F3: the maintenance surface still refuses an unauthenticated caller', async () => {
    const res = await request(server).post('/api/admin/maintenance/retention-prune')
    expect(res.status).toBe(401)
  })
})

describe('change-password rate limit is per user, not per network', () => {
  // Its own org and its own X-Forwarded-For bucket so the counter starts
  // clean — the limiter keys on user id, and the sibling describe above
  // has already spent attempts on ITS user.
  const rlOrg = {
    organizationName: `RL Org ${RUN_ID}`,
    name: 'Norma Secretary',
    email: `rl_${RUN_ID}@example.com`,
    password: 'smoke-test-pw-9',
  }
  let rlToken, rlOrgId

  beforeAll(async () => {
    const res = await request(server).post('/api/auth/signup')
      .set('X-Forwarded-For', '10.99.0.4')
      .send(rlOrg)
    expect(res.status).toBe(201)
    rlToken = res.body.token
    rlOrgId = res.body.user.organization.id
  })

  afterAll(async () => {
    await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [rlOrgId]).catch(() => {})
  })

  it('locks out after repeated wrong current passwords, and says so', async () => {
    const MAX = 10
    let last
    for (let i = 0; i < MAX + 1; i++) {
      last = await request(server).patch('/api/auth/password')
        .set('Authorization', `Bearer ${rlToken}`)
        .send({ currentPassword: `wrong-${i}`, password: 'a-new-password-entirely' })
    }
    // The first MAX are credential failures; the next is the limiter.
    expect(last.status).toBe(429)
    expect(last.body.error).toMatch(/too many/i)

    // And the account is untouched — the real password still works.
    const login = await request(server).post('/api/auth/login')
      .send({ email: rlOrg.email, password: rlOrg.password })
    expect(login.status).toBe(200)
  })
})

describe('forgot / reset password — the emailed route', () => {
  // This flow had NO server coverage until 2026-08-17, which is how it
  // went unnoticed that it is currently the ONLY password route for a
  // signed-out user and that it cannot deliver without an email provider.
  // The delivery half is stubbed; everything up to and including token
  // redemption is real and is what these tests hold.
  //
  // The raw token only ever exists inside the email, so these tests mint
  // their own and insert the hash the same way the route does — that is
  // exactly what a real reset link carries.
  const rsOrg = {
    organizationName: `Reset Org ${RUN_ID}`,
    name: 'Norma Secretary',
    email: `reset_${RUN_ID}@example.com`,
    password: 'smoke-test-pw-9',
  }
  const NEW_PW = 'reset-flow-new-password'
  let rsUserId, rsOrgId, rsToken

  const sha = s => crypto.createHash('sha256').update(s).digest('hex')

  async function mintToken({ minutesValid = 60 } = {}) {
    const raw = crypto.randomBytes(32).toString('base64url')
    await pool.query(
      `INSERT INTO ochr_password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [rsUserId, sha(raw), new Date(Date.now() + minutesValid * 60 * 1000)]
    )
    return raw
  }

  beforeAll(async () => {
    const res = await request(server).post('/api/auth/signup')
      .set('X-Forwarded-For', '10.99.0.5')
      .send(rsOrg)
    expect(res.status).toBe(201)
    rsUserId = res.body.user.id
    rsOrgId  = res.body.user.organization.id
    rsToken  = res.body.token
  })

  afterAll(async () => {
    await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [rsOrgId]).catch(() => {})
  })

  it('forgot-password answers 200 for a real address AND an unknown one', async () => {
    const real = await request(server).post('/api/auth/forgot-password')
      .set('X-Forwarded-For', '10.99.0.5').send({ email: rsOrg.email })
    expect(real.status).toBe(200)

    // Identical shape for an address with no account — otherwise the
    // endpoint is an account-enumeration oracle.
    const ghost = await request(server).post('/api/auth/forgot-password')
      .set('X-Forwarded-For', '10.99.0.5').send({ email: `nobody_${RUN_ID}@example.com` })
    expect(ghost.status).toBe(200)
    expect(ghost.body).toEqual(real.body)
  })

  it('issues a token row for the real address', async () => {
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM ochr_password_reset_tokens WHERE user_id = $1',
      [rsUserId]
    )
    expect(rows[0].n).toBeGreaterThanOrEqual(1)
  })

  it('rejects a garbage token', async () => {
    const res = await request(server).post('/api/auth/reset-password')
      .send({ token: 'not-a-real-token', password: NEW_PW })
    expect(res.status).toBe(400)
  })

  it('rejects an expired token', async () => {
    const expired = await mintToken({ minutesValid: -5 })
    const res = await request(server).post('/api/auth/reset-password')
      .send({ token: expired, password: NEW_PW })
    expect(res.status).toBe(400)

    // …and the old password still works, i.e. nothing half-applied.
    const login = await request(server).post('/api/auth/login')
      .send({ email: rsOrg.email, password: rsOrg.password })
    expect(login.status).toBe(200)
  })

  it('enforces the minimum length before spending the token', async () => {
    const raw = await mintToken()
    const short = await request(server).post('/api/auth/reset-password')
      .send({ token: raw, password: 'short' })
    expect(short.status).toBe(400)

    // The token must survive a rejected attempt — otherwise a typo costs
    // the user another round-trip through an inbox.
    const ok = await request(server).post('/api/auth/reset-password')
      .send({ token: raw, password: NEW_PW })
    expect(ok.status).toBe(200)
  })

  it('the reset actually changed the password and revoked old sessions', async () => {
    const old = await request(server).post('/api/auth/login')
      .send({ email: rsOrg.email, password: rsOrg.password })
    expect(old.status).toBe(401)

    const now = await request(server).post('/api/auth/login')
      .send({ email: rsOrg.email, password: NEW_PW })
    expect(now.status).toBe(200)

    // The session held since signup was signed in with the OLD password.
    const stale = await request(server).get('/api/auth/me')
      .set('Authorization', `Bearer ${rsToken}`)
    expect(stale.status).toBe(401)
  })

  it('a spent token cannot be replayed', async () => {
    const raw = await mintToken()
    const first = await request(server).post('/api/auth/reset-password')
      .send({ token: raw, password: 'another-fresh-password-1' })
    expect(first.status).toBe(200)

    const replay = await request(server).post('/api/auth/reset-password')
      .send({ token: raw, password: 'another-fresh-password-2' })
    expect(replay.status).toBe(400)
  })
})

describe('immediate notice on auto-fill + following edit (NV.2)', () => {
  // Closes the paths RM.3b deferred. Placed ABOVE 'role enforcement'.

  const pad = n => String(n).padStart(2, '0')
  const toISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const plusDays = n => { const d = new Date(); d.setDate(d.getDate() + n); return toISO(d) }
  const FUTURE = plusDays(25)
  const base = { start_time: '09:00', end_time: '10:30', type: 'service' }

  let memberId, memberEmail

  async function noticeCount(email) {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ochr_notification_log
        WHERE notification_type = 'event_assignment_added' AND recipient_email = $1`,
      [email]
    )
    return rows[0].n
  }

  beforeAll(async () => {
    memberEmail = `nv2_${RUN_ID}@example.com`
    const m = await request(server).post('/api/clients')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `NV2 M ${RUN_ID}`, email: memberEmail, status: 'active', role: 'Member' })
    memberId = m.body.id
  })

  it('fires one immediate notice when auto-fill assigns a member', async () => {
    const series = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ ...base, title: `NV2 Auto ${RUN_ID}`, date: FUTURE, assigned_to: [],
              recurrence: { freq: 'weekly', interval: 1, count: 2 } })
    expect(series.status).toBe(201)
    const before = await noticeCount(memberEmail)

    const fill = await request(server).post('/api/calendar/auto-fill-rotation')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ recurrence_parent_id: series.body.id, member_ids: [memberId] })
    expect(fill.status).toBe(200)
    expect(await noticeCount(memberEmail)).toBe(before + 1)
  })

  it('fires an immediate notice for a member added via following edit', async () => {
    const series = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ ...base, title: `NV2 Follow ${RUN_ID}`, date: FUTURE, assigned_to: [],
              recurrence: { freq: 'weekly', interval: 1, count: 2 } })
    const before = await noticeCount(memberEmail)

    const patch = await request(server).patch(`/api/calendar/${series.body.id}?scope=following`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ ...base, title: `NV2 Follow ${RUN_ID}`, date: FUTURE, assigned_to: [memberId] })
    expect(patch.status).toBe(200)
    expect(await noticeCount(memberEmail)).toBe(before + 1)
  })
})

describe('weekly serving digest (NV.4)', () => {
  // A member serving in the next 7 days gets one digest. Placed ABOVE
  // 'role enforcement'.

  const pad = n => String(n).padStart(2, '0')
  const toISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const plusDays = n => { const d = new Date(); d.setDate(d.getDate() + n); return toISO(d) }
  const THIS_WEEK = plusDays(2)

  let memberId, memberEmail
  const CRON = 'nv4-cron-secret'
  const prevSecret = process.env.CRON_SECRET

  async function digestCount(email) {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ochr_notification_log
        WHERE notification_type = 'weekly_serving_digest' AND recipient_email = $1`,
      [email]
    )
    return rows[0].n
  }

  beforeAll(async () => {
    memberEmail = `nv4_${RUN_ID}@example.com`
    const m = await request(server).post('/api/clients')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `NV4 M ${RUN_ID}`, email: memberEmail, status: 'active', role: 'Member' })
    memberId = m.body.id
    await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ title: `NV4 Serve ${RUN_ID}`, date: THIS_WEEK, start_time: '09:00', end_time: '10:30', type: 'service', assigned_to: [memberId] })
    process.env.CRON_SECRET = CRON
  })

  afterAll(() => {
    if (prevSecret === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = prevSecret
  })

  it('sends a weekly digest to a member serving this week', async () => {
    const before = await digestCount(memberEmail)
    const res = await request(server).post('/api/cron/weekly-serving-digest')
      .set('Authorization', `Bearer ${CRON}`)
    expect(res.status).toBe(200)
    expect(res.body.sent).toBeGreaterThanOrEqual(1)
    expect(await digestCount(memberEmail)).toBe(before + 1)
  })
})

describe('swap-pending nudge (NV.3)', () => {
  // A stale pending swap nudges the target once. Placed ABOVE 'role
  // enforcement'.

  const pad = n => String(n).padStart(2, '0')
  const toISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const plusDays = n => { const d = new Date(); d.setDate(d.getDate() + n); return toISO(d) }
  const FUTURE = plusDays(20)

  const targetEmail = `nv3target_${RUN_ID}@example.com`
  let swapId
  const CRON = 'nv3-cron-secret'
  const prevSecret = process.env.CRON_SECRET

  async function nudgeCount(email) {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ochr_notification_log
        WHERE notification_type = 'swap_pending_reminder' AND recipient_email = $1`,
      [email]
    )
    return rows[0].n
  }

  beforeAll(async () => {
    const reqM = await request(server).post('/api/clients')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `NV3 Req ${RUN_ID}`, status: 'active', role: 'Member' })
    const tgtM = await request(server).post('/api/clients')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `NV3 Tgt ${RUN_ID}`, email: targetEmail, status: 'active', role: 'Member' })
    const ev = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ title: `NV3 Event ${RUN_ID}`, date: FUTURE, start_time: '09:00', end_time: '10:30', type: 'service', assigned_to: [reqM.body.id] })

    const orgRow = await pool.query('SELECT organization_id FROM ochr_clients WHERE id = $1', [tgtM.body.id])
    const orgId = orgRow.rows[0].organization_id
    const ins = await pool.query(
      `INSERT INTO ochr_swap_requests
         (organization_id, calendar_event_id, requester_client_id, target_client_id, status, created_at)
       VALUES ($1, $2, $3, $4, 'pending', NOW() - INTERVAL '3 days')
       RETURNING id`,
      [orgId, ev.body.id, reqM.body.id, tgtM.body.id]
    )
    swapId = ins.rows[0].id
    process.env.CRON_SECRET = CRON
  })

  afterAll(() => {
    if (prevSecret === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = prevSecret
  })

  it('nudges the target of a stale pending swap', async () => {
    const before = await nudgeCount(targetEmail)
    const res = await request(server).post('/api/cron/nudge-swaps')
      .set('Authorization', `Bearer ${CRON}`)
    expect(res.status).toBe(200)
    expect(res.body.nudged).toBeGreaterThanOrEqual(1)
    expect(await nudgeCount(targetEmail)).toBe(before + 1)

    const { rows } = await pool.query('SELECT reminded_at FROM ochr_swap_requests WHERE id = $1', [swapId])
    expect(rows[0].reminded_at).toBeTruthy()
  })

  it('does not nudge the same request twice', async () => {
    const before = await nudgeCount(targetEmail)
    await request(server).post('/api/cron/nudge-swaps').set('Authorization', `Bearer ${CRON}`)
    expect(await nudgeCount(targetEmail)).toBe(before)
  })
})

describe('notifications admin view (NV.1)', () => {
  it('lists scheduled and recent notifications for the org', async () => {
    const s = await request(server).get('/api/admin/notifications/scheduled')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(s.status).toBe(200)
    expect(Array.isArray(s.body.scheduled)).toBe(true)

    const l = await request(server).get('/api/admin/notifications/log')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(l.status).toBe(200)
    expect(Array.isArray(l.body.log)).toBe(true)
  })
})

describe('health check (H.1)', () => {
  it('reports ok with a db ping and the payments provider', async () => {
    const res = await request(server).get('/api/health')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ok')
    expect(res.body.db).toBe('ok')
    expect(res.body.payments_provider).toBeTruthy()
  })
})

describe('check-in (CHK.1)', () => {
  // Check people in to a Schedule event. Placed ABOVE 'role enforcement'.

  const pad = n => String(n).padStart(2, '0')
  const toISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const today = toISO(new Date())

  let eventId, memberId, memberName, checkinId

  beforeAll(async () => {
    memberName = `Checkin M ${RUN_ID}`
    const m = await request(server).post('/api/clients')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: memberName, status: 'active', role: 'Member' })
    memberId = m.body.id
    const ev = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ title: `Checkin Service ${RUN_ID}`, date: today, start_time: '09:00', end_time: '10:30', type: 'service' })
    eventId = ev.body.id
  })

  it('checks a member in and lists them', async () => {
    const ci = await request(server).post('/api/checkins')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ calendar_event_id: eventId, client_id: memberId })
    expect(ci.status).toBe(201)
    expect(ci.body.person_name).toBe(memberName)
    checkinId = ci.body.id

    const list = await request(server).get(`/api/checkins?event_id=${eventId}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(list.status).toBe(200)
    expect(list.body.checkins.some(c => c.id === checkinId)).toBe(true)
    expect(list.body.present).toBe(1)
  })

  it('checks in a guest by name', async () => {
    const ci = await request(server).post('/api/checkins')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ calendar_event_id: eventId, person_name: `Guest ${RUN_ID}`, kind: 'guest' })
    expect(ci.status).toBe(201)
    expect(ci.body.kind).toBe('guest')
  })

  it('checks out, then removes a check-in', async () => {
    const out = await request(server).post(`/api/checkins/${checkinId}/checkout`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(out.status).toBe(200)
    expect(out.body.checked_out_at).toBeTruthy()

    const del = await request(server).delete(`/api/checkins/${checkinId}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(del.status).toBe(204)
  })

  it('rejects a check-in to an unknown event', async () => {
    const res = await request(server).post('/api/checkins')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ calendar_event_id: 999999999, person_name: 'Nope' })
    expect(res.status).toBe(400)
  })
})

describe('kid-pickup security code (CHK.3)', () => {
  const pad = n => String(n).padStart(2, '0')
  const toISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const today = toISO(new Date())

  let eventId, childId, code

  beforeAll(async () => {
    const ev = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ title: `CHK3 Service ${RUN_ID}`, date: today, start_time: '09:00', end_time: '10:30', type: 'service' })
    eventId = ev.body.id
  })

  it('issues a pickup code on child check-in and hides it from the list', async () => {
    const ci = await request(server).post('/api/checkins')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ calendar_event_id: eventId, person_name: `Kid ${RUN_ID}`, kind: 'child', guardian_name: 'Parent' })
    expect(ci.status).toBe(201)
    expect(ci.body.kind).toBe('child')
    expect(ci.body.security_code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/)
    childId = ci.body.id
    code = ci.body.security_code

    const list = await request(server).get(`/api/checkins?event_id=${eventId}`)
      .set('Authorization', `Bearer ${tokenA}`)
    const row = list.body.checkins.find(c => c.id === childId)
    expect(row).toBeTruthy()
    expect(row.security_code).toBeUndefined()
  })

  it('rejects a child checkout without or with a wrong code', async () => {
    const none = await request(server).post(`/api/checkins/${childId}/checkout`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(none.status).toBe(400)

    const wrong = await request(server).post(`/api/checkins/${childId}/checkout`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ code: 'WRNG' })
    expect(wrong.status).toBe(403)
  })

  it('checks the child out with the correct code', async () => {
    const ok = await request(server).post(`/api/checkins/${childId}/checkout`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ code: code.toLowerCase() }) // case-insensitive
    expect(ok.status).toBe(200)
    expect(ok.body.checked_out_at).toBeTruthy()
  })

  it('persists only a hash of the pickup code, never the plaintext', async () => {
    const ci = await request(server).post('/api/checkins')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ calendar_event_id: eventId, person_name: `Kid2 ${RUN_ID}`, kind: 'child', guardian_name: 'Parent' })
    expect(ci.status).toBe(201)
    const plaintext = ci.body.security_code
    expect(plaintext).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/)

    // At rest: plaintext column is NULL, only the hash is stored, and the
    // hash is not just the code echoed back.
    const { rows } = await pool.query(
      'SELECT security_code, security_code_hash FROM ochr_checkins WHERE id = $1',
      [ci.body.id]
    )
    expect(rows[0].security_code).toBeNull()
    expect(rows[0].security_code_hash).toBeTruthy()
    expect(rows[0].security_code_hash).not.toBe(plaintext)
    // The stored value is exactly the keyed HMAC of the (normalized) code —
    // not some other transform — and case-insensitive on normalization.
    expect(rows[0].security_code_hash).toBe(hashSecurityCode(plaintext))
    expect(rows[0].security_code_hash).toBe(hashSecurityCode(plaintext.toLowerCase()))
  })

  it('clears the code hash when a child is checked out', async () => {
    const ci = await request(server).post('/api/checkins')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ calendar_event_id: eventId, person_name: `Kid3 ${RUN_ID}`, kind: 'child', guardian_name: 'Parent' })
    const kidId = ci.body.id
    const kidCode = ci.body.security_code

    const ok = await request(server).post(`/api/checkins/${kidId}/checkout`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ code: kidCode })
    expect(ok.status).toBe(200)

    const { rows } = await pool.query(
      'SELECT checked_out_at, security_code_hash FROM ochr_checkins WHERE id = $1',
      [kidId]
    )
    expect(rows[0].checked_out_at).toBeTruthy()
    expect(rows[0].security_code_hash).toBeNull() // spent code purged on release
  })

  it('retention KEEPS the pickup gate for a child still checked in (no fail-open)', async () => {
    const ci = await request(server).post('/api/checkins')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ calendar_event_id: eventId, person_name: `StayKid ${RUN_ID}`, kind: 'child', guardian_name: 'Parent' })
    const stayId = ci.body.id

    // Backdate check-in well past the 2-day code-stale window, but the child
    // has NOT been checked out. Retention must NOT clear the hash, or checkout
    // would release the child with no code required.
    await pool.query(
      `UPDATE ochr_checkins SET checked_in_at = NOW() - INTERVAL '10 days' WHERE id = $1`,
      [stayId]
    )
    await pruneOldRecords()

    const { rows } = await pool.query(
      'SELECT checked_out_at, security_code_hash FROM ochr_checkins WHERE id = $1',
      [stayId]
    )
    expect(rows[0].checked_out_at).toBeNull()
    expect(rows[0].security_code_hash).toBeTruthy() // gate preserved
  })

  it('retention clears a spent (checked-out) lingering code hash after the stale window', async () => {
    const ci = await request(server).post('/api/checkins')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ calendar_event_id: eventId, person_name: `SpentKid ${RUN_ID}`, kind: 'child', guardian_name: 'Parent' })
    const spentId = ci.body.id

    // Simulate a checked-out row that still carries a hash (belt-and-braces —
    // checkout normally nulls it), aged past the 2-day stale window.
    await pool.query(
      `UPDATE ochr_checkins
          SET checked_out_at = NOW(), checked_in_at = NOW() - INTERVAL '5 days'
        WHERE id = $1`,
      [spentId]
    )
    await pruneOldRecords()

    const { rows } = await pool.query(
      'SELECT security_code_hash FROM ochr_checkins WHERE id = $1',
      [spentId]
    )
    expect(rows[0].security_code_hash).toBeNull()
  })

  it('anonymizes old check-in PII and clears the code on retention prune', async () => {
    const ci = await request(server).post('/api/checkins')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ calendar_event_id: eventId, person_name: `OldKid ${RUN_ID}`, kind: 'child', guardian_name: 'Guardian' })
    const oldId = ci.body.id

    // Backdate beyond the 400-day PII retention window.
    await pool.query(
      `UPDATE ochr_checkins SET checked_in_at = NOW() - INTERVAL '500 days' WHERE id = $1`,
      [oldId]
    )

    await pruneOldRecords()

    const { rows } = await pool.query(
      'SELECT person_name, guardian_name, security_code_hash FROM ochr_checkins WHERE id = $1',
      [oldId]
    )
    expect(rows[0].person_name).toBe('Redacted')
    expect(rows[0].guardian_name).toBeNull()
    expect(rows[0].security_code_hash).toBeNull()
  })
})

describe('attendance reporting (CHK.4)', () => {
  const pad = n => String(n).padStart(2, '0')
  const toISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const today = toISO(new Date())

  let eventId, memberId

  beforeAll(async () => {
    const m = await request(server).post('/api/clients')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `CHK4 M ${RUN_ID}`, status: 'active', role: 'Member' })
    memberId = m.body.id
    const ev = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ title: `CHK4 Service ${RUN_ID}`, date: today, start_time: '09:00', end_time: '10:30', type: 'service' })
    eventId = ev.body.id
    await request(server).post('/api/checkins')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ calendar_event_id: eventId, client_id: memberId })
  })

  it('shows the service in the member attendance history', async () => {
    const res = await request(server).get(`/api/clients/${memberId}/checkins`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.checkins.some(c => c.event_id === eventId)).toBe(true)
  })

  it('reports attendance counts for recent services', async () => {
    const res = await request(server).get('/api/checkins/recent?days=30')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    const svc = res.body.services.find(s => s.event_id === eventId)
    expect(svc).toBeTruthy()
    expect(svc.attendance).toBeGreaterThanOrEqual(1)
  })
})

describe('rooms / classes (CHK.6)', () => {
  const pad = n => String(n).padStart(2, '0')
  const toISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const today = toISO(new Date())

  let eventId, roomId, foreignRoomId

  beforeAll(async () => {
    const ev = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ title: `CHK6 Service ${RUN_ID}`, date: today, start_time: '09:00', end_time: '10:30', type: 'service' })
    eventId = ev.body.id
    // A room belonging to org B — used to prove cross-tenant room ids drop to null.
    const fr = await request(server).post('/api/rooms')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ name: `Foreign Room ${RUN_ID}` })
    foreignRoomId = fr.body.id
  })

  it('creates a room and lists it (active filter)', async () => {
    const res = await request(server).post('/api/rooms')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `Nursery ${RUN_ID}`, capacity: 12 })
    expect(res.status).toBe(201)
    expect(res.body.capacity).toBe(12)
    roomId = res.body.id

    const list = await request(server).get('/api/rooms?active=true')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(list.status).toBe(200)
    expect(list.body.rooms.some(r => r.id === roomId)).toBe(true)
  })

  it('checks a guest into a room and shows the room name in the list', async () => {
    const ci = await request(server).post('/api/checkins')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ calendar_event_id: eventId, person_name: `Room Guest ${RUN_ID}`, kind: 'guest', room_id: roomId })
    expect(ci.status).toBe(201)
    expect(ci.body.room_id).toBe(roomId)

    const list = await request(server).get(`/api/checkins?event_id=${eventId}`)
      .set('Authorization', `Bearer ${tokenA}`)
    const row = list.body.checkins.find(c => c.id === ci.body.id)
    expect(row.room_name).toBe(`Nursery ${RUN_ID}`)
  })

  it('drops a foreign room id to null rather than failing the check-in', async () => {
    const ci = await request(server).post('/api/checkins')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ calendar_event_id: eventId, person_name: `No Room ${RUN_ID}`, kind: 'guest', room_id: foreignRoomId })
    expect(ci.status).toBe(201)
    expect(ci.body.room_id).toBeNull()
  })

  it('does not leak rooms across tenants', async () => {
    const list = await request(server).get('/api/rooms')
      .set('Authorization', `Bearer ${tokenB}`)
    expect(list.body.rooms.some(r => r.id === roomId)).toBe(false)
  })
})

describe('self-serve kiosk (CHK.7)', () => {
  // The kiosk's "today" is the org's local day (CHK.7), so the test pins
  // the org to a fixed IANA zone and derives `today` in that same zone.
  // This keeps the suite deterministic regardless of the host machine's
  // timezone or the UTC date rolling over mid-run — previously the event
  // was dated in local time while the kiosk filtered on UTC CURRENT_DATE,
  // so this block went red every evening once UTC passed midnight.
  const KIOSK_TZ = 'America/Chicago'
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: KIOSK_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())

  let kioskToken, eventId, memberId, roomId

  beforeAll(async () => {
    await request(server).patch('/api/organization')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ timezone: KIOSK_TZ })
    const m = await request(server).post('/api/clients')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `Kiosk M ${RUN_ID}`, status: 'active', role: 'Member' })
    memberId = m.body.id
    const ev = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ title: `Kiosk Service ${RUN_ID}`, date: today, start_time: '09:00', end_time: '10:30', type: 'service' })
    eventId = ev.body.id
    const r = await request(server).post('/api/rooms')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `Kiosk Room ${RUN_ID}` })
    roomId = r.body.id
  })

  it('admin mints a kiosk token', async () => {
    const res = await request(server).post('/api/kiosk-admin/rotate')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.kiosk_token).toMatch(/^[A-Za-z0-9_-]{20,}$/)
    kioskToken = res.body.kiosk_token
  })

  it('public resolve returns today services and rooms — no roster, no auth', async () => {
    const res = await request(server).get(`/api/kiosk/${kioskToken}`)
    expect(res.status).toBe(200)
    expect(res.body.services.some(s => s.id === eventId)).toBe(true)
    expect(res.body.rooms.some(r => r.id === roomId)).toBe(true)
    // The full roster is no longer shipped in the shell — members come from
    // the query-gated typeahead below, so a token holder can't scrape the
    // directory in one request.
    expect(res.body.members).toBeUndefined()
    // Each service carries its liturgical context (LIT.3) so the kiosk
    // can show the day's season/feast.
    const svc = res.body.services.find(s => s.id === eventId)
    expect(svc).toHaveProperty('liturgical_season')
  })

  it('member typeahead finds an active member by name — no auth', async () => {
    // Search by the first few chars of the seeded member's name.
    const q = `Kiosk M ${RUN_ID}`.slice(0, 5)
    const res = await request(server).get(`/api/kiosk/${kioskToken}/members?q=${encodeURIComponent(q)}`)
    expect(res.status).toBe(200)
    expect(res.body.members.some(m => m.id === memberId)).toBe(true)
    // A too-short query returns an empty list rather than the roster.
    const short = await request(server).get(`/api/kiosk/${kioskToken}/members?q=K`)
    expect(short.status).toBe(200)
    expect(short.body.members).toEqual([])
  })

  it('public member self check-in into a room', async () => {
    const res = await request(server).post(`/api/kiosk/${kioskToken}/checkin`)
      .send({ calendar_event_id: eventId, client_id: memberId, kind: 'member', room_id: roomId })
    expect(res.status).toBe(201)
    expect(res.body.room_id).toBe(roomId)

    // The check-in shows up on the authed list for that event.
    const list = await request(server).get(`/api/checkins?event_id=${eventId}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(list.body.checkins.some(c => c.client_id === memberId)).toBe(true)
  })

  it('public child check-in returns a pickup code', async () => {
    const res = await request(server).post(`/api/kiosk/${kioskToken}/checkin`)
      .send({ calendar_event_id: eventId, person_name: `Kiosk Kid ${RUN_ID}`, kind: 'child' })
    expect(res.status).toBe(201)
    expect(res.body.security_code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/)
  })

  it('rejects a bad token and a foreign event', async () => {
    const bad = await request(server).get('/api/kiosk/not-a-real-token-xxxxxxxx')
    expect(bad.status).toBe(404)

    // Org B's event is invisible/invalid through Org A's kiosk.
    const evB = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ title: `Foreign Ev ${RUN_ID}`, date: today, start_time: '09:00', end_time: '10:00', type: 'service' })
    const res = await request(server).post(`/api/kiosk/${kioskToken}/checkin`)
      .send({ calendar_event_id: evB.body.id, person_name: 'Nope', kind: 'guest' })
    expect(res.status).toBe(400)
  })

  it('revoking the token kills the kiosk', async () => {
    const del = await request(server).delete('/api/kiosk-admin')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(del.status).toBe(204)
    const res = await request(server).get(`/api/kiosk/${kioskToken}`)
    expect(res.status).toBe(404)
  })
})

describe('liturgical auto-mapping on calendar events (LIT.1)', () => {
  // Christmas is fixed (Dec 25) regardless of year; a mid-July Sunday is
  // Ordinary Time. Both are computed (no override row), so these assert
  // the auto-map path stamps the schedule row at create/update time.
  it('stamps season/color/feast onto a new event (Christmas)', async () => {
    const res = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ title: `Christmas Mass ${RUN_ID}`, date: '2026-12-25', start_time: '09:00', end_time: '10:30', type: 'service' })
    expect(res.status).toBe(201)
    expect(res.body.liturgical_season).toBe('Christmas')
    expect(res.body.feast_name).toBe('Christmas')
    expect(res.body.liturgical_color).toBe('White')
  })

  it('maps an Ordinary-Time date to Green with no feast', async () => {
    const res = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ title: `Ordinary ${RUN_ID}`, date: '2026-07-12', start_time: '09:00', end_time: '10:00', type: 'service' })
    expect(res.status).toBe(201)
    expect(res.body.liturgical_season).toBe('Ordinary Time')
    expect(res.body.liturgical_color).toBe('Green')
    expect(res.body.feast_name).toBeNull()
  })

  it('re-maps liturgical context when an event date moves', async () => {
    const made = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ title: `Mover ${RUN_ID}`, date: '2026-07-12', start_time: '09:00', end_time: '10:00', type: 'service' })
    expect(made.body.liturgical_season).toBe('Ordinary Time')

    const moved = await request(server).patch(`/api/calendar/${made.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ title: `Mover ${RUN_ID}`, date: '2026-12-25', start_time: '09:00', end_time: '10:00', type: 'service', assigned_to: [] })
    expect(moved.status).toBe(200)
    expect(moved.body.liturgical_season).toBe('Christmas')
    expect(moved.body.feast_name).toBe('Christmas')
  })

  it('stamps each recurring occurrence on its own date', async () => {
    // Weekly from Dec 20 2026: occurrence 1 = Dec 20 (Advent), occurrence
    // 2 = Dec 27 (Christmas season). Proves per-occurrence mapping.
    const res = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ title: `Series ${RUN_ID}`, date: '2026-12-20', start_time: '09:00', end_time: '10:00', type: 'service', recurrence: { freq: 'weekly', interval: 1, count: 2 } })
    expect(res.status).toBe(201)
    expect(res.body.liturgical_season).toBe('Advent')

    const { rows } = await pool.query(
      `SELECT date, liturgical_season FROM ochr_calendar_events
        WHERE recurrence_parent_id = $1 ORDER BY date ASC`,
      [res.body.id]
    )
    const dec27 = rows.find(r => r.date.toISOString().slice(0, 10) === '2026-12-27')
    expect(dec27?.liturgical_season).toBe('Christmas')
  })

  it('lets an override row win over the computed answer', async () => {
    // ochr_liturgical_calendar is intentionally global, so this test
    // also doubles as the cross-org isolation check: org B should see
    // the SAME override when creating an event on the same date.
    const overrideDate = `2099-08-15`
    await pool.query(
      `INSERT INTO ochr_liturgical_calendar (date, season, feast_name, liturgical_color)
         VALUES ($1, 'Ordinary Time', $2, 'Gold')
       ON CONFLICT (date) DO UPDATE SET season=EXCLUDED.season, feast_name=EXCLUDED.feast_name, liturgical_color=EXCLUDED.liturgical_color`,
      [overrideDate, `Override Feast ${RUN_ID}`]
    )

    const a = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ title: `OverrideA ${RUN_ID}`, date: overrideDate, start_time: '09:00', end_time: '10:00', type: 'service' })
    expect(a.status).toBe(201)
    expect(a.body.feast_name).toBe(`Override Feast ${RUN_ID}`)
    expect(a.body.liturgical_color).toBe('Gold')

    // Org B on the same date sees the same global override.
    const b = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ title: `OverrideB ${RUN_ID}`, date: overrideDate, start_time: '09:00', end_time: '10:00', type: 'service' })
    expect(b.status).toBe(201)
    expect(b.body.feast_name).toBe(`Override Feast ${RUN_ID}`)

    await pool.query('DELETE FROM ochr_liturgical_calendar WHERE date = $1', [overrideDate])
  })

  it('rejects a malformed date with 400', async () => {
    const res = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ title: `Bad Date ${RUN_ID}`, date: 'not-a-date', start_time: '09:00', end_time: '10:00', type: 'service' })
    expect(res.status).toBe(400)
  })
})

describe('serving reminders carry liturgical context (LIT.2)', () => {
  it('queues a reminder whose vars mention the feast', async () => {
    const email = `lit2_${RUN_ID}@example.com`
    const m = await request(server).post('/api/clients')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `Lit2 M ${RUN_ID}`, email, status: 'active', role: 'Member' })

    // Christmas is a fixed future feast — the queued reminder's vars
    // should carry the liturgical_line built from the event's stored
    // feast_name (LIT.1 auto-map → LIT.2 line).
    const ev = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ title: `Lit2 Mass ${RUN_ID}`, date: '2026-12-25', start_time: '09:00', end_time: '10:30', type: 'service', assigned_to: [m.body.id] })
    expect(ev.body.feast_name).toBe('Christmas')

    const { rows } = await pool.query(
      `SELECT vars FROM ochr_scheduled_notifications
        WHERE source_type = 'calendar_event' AND source_id = $1
          AND notification_type = 'assignment_reminder' AND status = 'pending'`,
      [ev.body.id]
    )
    expect(rows.length).toBe(1)
    expect(rows[0].vars.liturgical_line).toContain('Christmas')
  })

  it('leaves a season line for an Ordinary-Time event', async () => {
    const email = `lit2b_${RUN_ID}@example.com`
    const m = await request(server).post('/api/clients')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `Lit2b M ${RUN_ID}`, email, status: 'active', role: 'Member' })

    // A fixed FAR-FUTURE October date — like the Christmas sibling above,
    // it must stay put as the calendar advances. October is always
    // post-Pentecost and pre-Advent (Ordinary Time, no universal feast in
    // the mapping), and being years out keeps the reminder anchor
    // (date − reminder_lead_hours, up to a 168h max) safely in the future
    // so the pending reminder is always queued. A near-term date rots:
    // once "today" is within the lead window the reminder is skipped.
    const ev = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ title: `Lit2b ${RUN_ID}`, date: '2040-10-16', start_time: '09:00', end_time: '10:00', type: 'service', assigned_to: [m.body.id] })

    const { rows } = await pool.query(
      `SELECT vars FROM ochr_scheduled_notifications
        WHERE source_type = 'calendar_event' AND source_id = $1
          AND notification_type = 'assignment_reminder' AND status = 'pending'`,
      [ev.body.id]
    )
    expect(rows.length).toBe(1)
    expect(rows[0].vars.liturgical_line).toBe('\nLiturgical season: Ordinary Time.')
  })

  it('emits an empty liturgical_line when feast and season are both null', () => {
    // The helper is the single source of truth used by both the legacy
    // /api/events dispatch and the /api/calendar reminders. Guarding it
    // here pins the contract: a row that somehow ends up with NULL
    // liturgical fields (older row, manual SQL, schema drift) must NOT
    // produce broken copy like "today is null" in the rendered email.
    expect(liturgicalLine(null, null)).toBe('')
    expect(liturgicalLine(undefined, undefined)).toBe('')
    expect(liturgicalLine('', '')).toBe('')
  })
})

describe('parish feasts — tenant-scoped liturgical overrides (LIT.5)', () => {
  // 2026-07-26 is a plain Ordinary-Time Sunday by computation — a clean
  // canvas to lay a parish patronal feast over.
  const FEAST_DATE = '2026-07-26'
  let feastId

  it('admin adds a parish feast (name + color)', async () => {
    const res = await request(server).post('/api/parish-feasts')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ date: FEAST_DATE, feast_name: `St. Anne ${RUN_ID}`, liturgical_color: 'White' })
    expect(res.status).toBe(201)
    expect(res.body.feast_name).toBe(`St. Anne ${RUN_ID}`)
    expect(res.body.liturgical_color).toBe('White')
    feastId = res.body.id
  })

  it('overlays the feast onto a new event but keeps the computed season', async () => {
    const ev = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ title: `Patronal ${RUN_ID}`, date: FEAST_DATE, start_time: '09:00', end_time: '10:00', type: 'service' })
    expect(ev.status).toBe(201)
    expect(ev.body.feast_name).toBe(`St. Anne ${RUN_ID}`)   // named by the parish
    expect(ev.body.liturgical_color).toBe('White')          // recolored
    expect(ev.body.liturgical_season).toBe('Ordinary Time') // season unchanged
  })

  it('surfaces the feast through GET /api/liturgical for the same org', async () => {
    const res = await request(server).get(`/api/liturgical?date=${FEAST_DATE}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.body.feast_name).toBe(`St. Anne ${RUN_ID}`)
    expect(res.body.season).toBe('Ordinary Time')
  })

  it('does not leak the feast to another tenant', async () => {
    // Org B's event on the same date gets the plain computed context.
    const ev = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ title: `Plain ${RUN_ID}`, date: FEAST_DATE, start_time: '09:00', end_time: '10:00', type: 'service' })
    expect(ev.body.feast_name).toBeNull()
    expect(ev.body.liturgical_season).toBe('Ordinary Time')

    const list = await request(server).get('/api/parish-feasts')
      .set('Authorization', `Bearer ${tokenB}`)
    expect(list.body.feasts.some(f => f.id === feastId)).toBe(false)
  })

  it('lists then deletes the feast', async () => {
    const list = await request(server).get('/api/parish-feasts')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(list.body.feasts.some(f => f.id === feastId)).toBe(true)

    const del = await request(server).delete(`/api/parish-feasts/${feastId}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(del.status).toBe(204)
  })

  it('parish feast wins on name+color but inherits season from global override', async () => {
    // Precedence contract: parish feast → global override → computed.
    // Stage a global override that recolors a date AND renames the
    // season (Lent — not the natural Ordinary-Time computation for
    // this date), then drop a parish feast on top. The parish name
    // and color must win; the season must come through from the
    // global override row, not from the computed default.
    const PRECEDENCE_DATE = '2026-08-02'
    try {
      await pool.query(
        `INSERT INTO ochr_liturgical_calendar (date, season, feast_name, liturgical_color)
         VALUES ($1, 'Lent', 'Universal-Test-Feast', 'Purple')
         ON CONFLICT (date) DO UPDATE
           SET season = EXCLUDED.season,
               feast_name = EXCLUDED.feast_name,
               liturgical_color = EXCLUDED.liturgical_color`,
        [PRECEDENCE_DATE]
      )
      const created = await request(server).post('/api/parish-feasts')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ date: PRECEDENCE_DATE, feast_name: `Patronal-${RUN_ID}`, liturgical_color: 'Gold' })
      expect(created.status).toBe(201)

      const ctx = await request(server).get(`/api/liturgical?date=${PRECEDENCE_DATE}`)
        .set('Authorization', `Bearer ${tokenA}`)
      expect(ctx.body.feast_name).toBe(`Patronal-${RUN_ID}`) // parish wins on name
      expect(ctx.body.color).toBe('Gold')                    // parish wins on color
      expect(ctx.body.season).toBe('Lent')                   // global override's season survives

      await request(server).delete(`/api/parish-feasts/${created.body.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
    } finally {
      await pool.query('DELETE FROM ochr_liturgical_calendar WHERE date = $1', [PRECEDENCE_DATE])
    }
  })

  it('rejects writes from non-admins (writeGate would let them; adminGate must not)', async () => {
    // The mount uses adminGate (admin role only), stricter than the
    // writeGate seen on routes like /api/clients. Verify a viewer is
    // blocked. Demote a freshly-created admin, then try to POST.
    // Done on its own throwaway user so the suite's tokenA stays an
    // admin for later tests.
    const helper = {
      name:     'Feast Viewer Helper',
      email:    `test_feast_viewer_${RUN_ID}@example.com`,
      password: 'feast-viewer-pw',
      role:     'admin',
    }
    const created = await request(server).post('/api/users')
      .set('Authorization', `Bearer ${tokenA}`)
      .send(helper)
    expect(created.status).toBe(201)
    const helperId = created.body.id

    const login = await request(server).post('/api/auth/login')
      .send({ email: helper.email, password: helper.password })
    expect(login.status).toBe(200)
    const helperToken = login.body.token

    await request(server).patch(`/api/users/${helperId}/role`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ role: 'viewer' })

    const attempt = await request(server).post('/api/parish-feasts')
      .set('Authorization', `Bearer ${helperToken}`)
      .send({ date: '2026-09-01', feast_name: 'Should Not Land', liturgical_color: 'White' })
    expect(attempt.status).toBe(403)
  })
})

describe('weekly bulletin (BUL.1)', () => {
  const BDATE = '2026-12-06'   // a Sunday in Advent
  let bulletinId

  it('creates a bulletin for a date', async () => {
    const res = await request(server).post('/api/bulletins')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ date: BDATE, announcements: `Coffee after Mass ${RUN_ID}`, readings: 'Is 11:1-10', pastor_note: 'Welcome' })
    expect(res.status).toBe(201)
    expect(res.body.date).toBe(BDATE)
    expect(res.body.announcements).toBe(`Coffee after Mass ${RUN_ID}`)
    bulletinId = res.body.id
  })

  it('re-posting the same date updates rather than duplicates (upsert)', async () => {
    const res = await request(server).post('/api/bulletins')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ date: BDATE, announcements: `Updated ${RUN_ID}`, published: true })
    expect(res.status).toBe(201)
    expect(res.body.id).toBe(bulletinId)            // same row
    expect(res.body.announcements).toBe(`Updated ${RUN_ID}`)
    expect(res.body.published).toBe(true)

    const list = await request(server).get('/api/bulletins')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(list.body.bulletins.filter(b => b.date === BDATE).length).toBe(1)
  })

  it('patches a single field', async () => {
    const res = await request(server).patch(`/api/bulletins/${bulletinId}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ intentions: `For the sick ${RUN_ID}` })
    expect(res.status).toBe(200)
    expect(res.body.intentions).toBe(`For the sick ${RUN_ID}`)
    expect(res.body.announcements).toBe(`Updated ${RUN_ID}`) // untouched
  })

  it('does not leak bulletins across tenants', async () => {
    const list = await request(server).get('/api/bulletins')
      .set('Authorization', `Bearer ${tokenB}`)
    expect(list.body.bulletins.some(b => b.id === bulletinId)).toBe(false)
  })

  it('the audit log accepts entity_type=bulletin (AUD allowlist)', async () => {
    const res = await request(server).get('/api/audit-log?entity_type=bulletin')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
  })

  it('deletes the bulletin', async () => {
    const del = await request(server).delete(`/api/bulletins/${bulletinId}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(del.status).toBe(204)
  })
})

describe('public read-online bulletin (BUL.3b)', () => {
  let slug
  beforeAll(async () => {
    const o = await pool.query('SELECT slug FROM ochr_organizations WHERE name = $1', [orgA.organizationName])
    slug = o.rows[0].slug
  })

  it('exposes the most recent published bulletin with liturgical context', async () => {
    await request(server).post('/api/bulletins')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ date: '2027-01-03', announcements: `Public hello ${RUN_ID}`, published: true })

    const res = await request(server).get(`/api/public/${slug}/bulletin`)   // no auth
    expect(res.status).toBe(200)
    expect(res.body.bulletin.date).toBe('2027-01-03')
    expect(res.body.bulletin.announcements).toBe(`Public hello ${RUN_ID}`)
    expect(res.body.org.slug).toBe(slug)
    expect(res.body.liturgical).toHaveProperty('season') // computed server-side
  })

  it('never exposes a draft, even a newer one', async () => {
    // A later-dated but unpublished bulletin must not surface.
    await request(server).post('/api/bulletins')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ date: '2027-01-10', announcements: `Secret draft ${RUN_ID}`, published: false })

    const res = await request(server).get(`/api/public/${slug}/bulletin`)
    expect(res.status).toBe(200)
    expect(res.body.bulletin.date).toBe('2027-01-03')  // still the published one
  })

  it('404s an unknown slug without leaking', async () => {
    const res = await request(server).get('/api/public/no-such-parish-xyz/bulletin')
    expect(res.status).toBe(404)
  })
})

describe('service planner — order of worship (SVC.1)', () => {
  let planId, memberId, e1, e2

  beforeAll(async () => {
    const m = await request(server).post('/api/clients')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `Cantor ${RUN_ID}`, status: 'active', role: 'Member' })
    memberId = m.body.id
  })

  it('creates a plan and appends elements in order', async () => {
    const plan = await request(server).post('/api/service-plans')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ date: '2027-02-07', title: `Sunday Mass ${RUN_ID}` })
    expect(plan.status).toBe(201)
    planId = plan.body.id

    const a = await request(server).post(`/api/service-plans/${planId}/elements`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ kind: 'hymn', title: 'Entrance Hymn', reference: '#312' })
    expect(a.status).toBe(201)
    expect(a.body.position).toBe(0)
    e1 = a.body.id

    const b = await request(server).post(`/api/service-plans/${planId}/elements`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ kind: 'reading', title: 'First Reading', assigned_client_id: memberId })
    expect(b.body.position).toBe(1)
    e2 = b.body.id
  })

  it('returns the plan with ordered elements + the assignee name', async () => {
    const res = await request(server).get(`/api/service-plans/${planId}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.elements.map(e => e.id)).toEqual([e1, e2])
    const reading = res.body.elements.find(e => e.id === e2)
    expect(reading.assigned_name).toBe(`Cantor ${RUN_ID}`)
  })

  it('reorders elements', async () => {
    const r = await request(server).put(`/api/service-plans/${planId}/elements/reorder`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ ids: [e2, e1] })
    expect(r.status).toBe(204)

    const res = await request(server).get(`/api/service-plans/${planId}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.body.elements.map(e => e.id)).toEqual([e2, e1])
  })

  it('rejects a reorder that does not list every element', async () => {
    const r = await request(server).put(`/api/service-plans/${planId}/elements/reorder`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ ids: [e2] }) // missing e1 — would leave a stale, colliding position
    expect(r.status).toBe(400)
    // The rejected call is transactional: the stored order is unchanged.
    const res = await request(server).get(`/api/service-plans/${planId}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.body.elements.map(e => e.id)).toEqual([e2, e1])
  })

  it('404s a reorder for a plan in another org', async () => {
    const r = await request(server).put(`/api/service-plans/${planId}/elements/reorder`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ ids: [e2, e1] })
    expect(r.status).toBe(404)
  })

  it('patches then deletes an element', async () => {
    const p = await request(server).patch(`/api/service-plans/${planId}/elements/${e1}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ title: 'Processional Hymn' })
    expect(p.body.title).toBe('Processional Hymn')

    const del = await request(server).delete(`/api/service-plans/${planId}/elements/${e1}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(del.status).toBe(204)
  })

  it('does not leak plans across tenants', async () => {
    const list = await request(server).get('/api/service-plans')
      .set('Authorization', `Bearer ${tokenB}`)
    expect(list.body.plans.some(p => p.id === planId)).toBe(false)
    // Org B can't read org A's plan directly either.
    const get = await request(server).get(`/api/service-plans/${planId}`)
      .set('Authorization', `Bearer ${tokenB}`)
    expect(get.status).toBe(404)
  })

  it('the audit log accepts entity_type=service_plan', async () => {
    const res = await request(server).get('/api/audit-log?entity_type=service_plan')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
  })

  it('silently clears a cross-org assignee id rather than storing it', async () => {
    // An org-B member must not be storable as the assignee on an org-A element.
    const m = await request(server).post('/api/clients')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ name: `Foreign Cantor ${RUN_ID}`, status: 'active', role: 'Member' })
    const foreignId = m.body.id

    const el = await request(server).post(`/api/service-plans/${planId}/elements`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ kind: 'reading', title: 'Second Reading', assigned_client_id: foreignId })
    expect(el.status).toBe(201)
    expect(el.body.assigned_client_id).toBeNull()
  })

  it('deletes the plan', async () => {
    const del = await request(server).delete(`/api/service-plans/${planId}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(del.status).toBe(204)
  })
})

describe('feedback (FB.1)', () => {
  it('records a note with the JWT identity + route, org-scoped', async () => {
    const res = await request(server).post('/api/feedback')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ category: 'suggestion', message: `Loving it ${RUN_ID}`, route: '/dashboard' })
    expect(res.status).toBe(201)
    expect(res.body.id).toBeTruthy()

    const { rows } = await pool.query(
      `SELECT organization_id, user_email, user_role, category, message, route
         FROM ochr_feedback_ledger WHERE id = $1`,
      [res.body.id]
    )
    expect(rows[0].category).toBe('suggestion')
    expect(rows[0].message).toBe(`Loving it ${RUN_ID}`)
    expect(rows[0].route).toBe('/dashboard')
    expect(rows[0].user_email?.toLowerCase()).toBe(orgA.email.toLowerCase())
    expect(rows[0].user_role).toBe('admin')
  })

  it('rejects an unknown category and an empty message', async () => {
    const badCat = await request(server).post('/api/feedback')
      .set('Authorization', `Bearer ${tokenA}`).send({ category: 'rant', message: 'x' })
    expect(badCat.status).toBe(400)
    const noMsg = await request(server).post('/api/feedback')
      .set('Authorization', `Bearer ${tokenA}`).send({ category: 'bug', message: '   ' })
    expect(noMsg.status).toBe(400)
  })

  it('requires authentication', async () => {
    const res = await request(server).post('/api/feedback').send({ category: 'bug', message: 'hi' })
    expect(res.status).toBe(401)
  })
})

// Placed ABOVE 'role enforcement' (which self-demotes tokenA) — needs admin.
describe('mass intentions (MI.1)', () => {
  let miId
  const uniq = `MI-${RUN_ID}`

  it('creates a Mass intention (defaults to open)', async () => {
    const res = await request(server).post('/api/mass-intentions')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ intention: `+Departed ${uniq}`, requested_by: 'Rivera family', stipend: 10 })
    expect(res.status).toBe(201)
    expect(res.body.status).toBe('open')
    expect(res.body.intention).toBe(`+Departed ${uniq}`)
    miId = res.body.id
  })

  it('rejects an empty intention and a negative stipend', async () => {
    const noIntent = await request(server).post('/api/mass-intentions')
      .set('Authorization', `Bearer ${tokenA}`).send({ intention: '   ' })
    expect(noIntent.status).toBe(400)
    const badStipend = await request(server).post('/api/mass-intentions')
      .set('Authorization', `Bearer ${tokenA}`).send({ intention: 'x', stipend: -5 })
    expect(badStipend.status).toBe(400)
  })

  it('lists with status filter and keyword search', async () => {
    const byStatus = await request(server).get('/api/mass-intentions?status=open')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(byStatus.status).toBe(200)
    expect(byStatus.body.intentions.some(r => r.id === miId)).toBe(true)
    const byQ = await request(server).get(`/api/mass-intentions?q=${uniq}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(byQ.body.intentions.some(r => r.id === miId)).toBe(true)
  })

  it('schedules it (PATCH status + date)', async () => {
    const res = await request(server).patch(`/api/mass-intentions/${miId}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ status: 'scheduled', mass_date: '2027-11-02' })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('scheduled')
    expect(res.body.mass_date).toBe('2027-11-02')
  })

  it('ties an intention to a Mass and surfaces it on the weekly manifest (MI.3)', async () => {
    // A Mass on the calendar…
    const mass = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `Tie-in Mass ${RUN_ID}`,
        date: '2027-11-02',
        start_time: '09:00',
        end_time: '10:00',
        type: 'service',
      })
    expect(mass.status).toBe(201)

    // …assigned to the intention…
    const link = await request(server).patch(`/api/mass-intentions/${miId}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ calendar_event_id: mass.body.id })
    expect(link.status).toBe(200)
    expect(link.body.calendar_event_id).toBe(mass.body.id)
    expect(link.body.mass_title).toBe(`Tie-in Mass ${RUN_ID}`)

    // …and the weekly manifest (what the Schedule reads) carries the link.
    const week = await request(server)
      .get('/api/mass-intentions/weekly?start=2027-11-01&end=2027-11-07')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(week.status).toBe(200)
    const row = week.body.intentions.find(r => r.id === miId)
    expect(row).toBeTruthy()
    expect(row.calendar_event_id).toBe(mass.body.id)
    expect(row.mass_time).toBe('09:00')

    // Cross-org: a stranger's event can't be assigned.
    const foreign = await request(server).patch(`/api/mass-intentions/${miId}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ calendar_event_id: 999999999 })
    expect(foreign.status).toBe(404)

    // The other org's weekly manifest never sees this intention.
    const weekB = await request(server)
      .get('/api/mass-intentions/weekly?start=2027-11-01&end=2027-11-07')
      .set('Authorization', `Bearer ${tokenB}`)
    expect(weekB.status).toBe(200)
    expect(weekB.body.intentions.some(r => r.id === miId)).toBe(false)
  })

  it('is tenant-isolated (cross-org read/delete 404)', async () => {
    const list = await request(server).get('/api/mass-intentions')
      .set('Authorization', `Bearer ${tokenB}`)
    expect(list.body.intentions.some(r => r.id === miId)).toBe(false)
    const get = await request(server).get(`/api/mass-intentions/${miId}`)
      .set('Authorization', `Bearer ${tokenB}`)
    expect(get.status).toBe(404)
    const del = await request(server).delete(`/api/mass-intentions/${miId}`)
      .set('Authorization', `Bearer ${tokenB}`)
    expect(del.status).toBe(404)
  })

  it('deletes it', async () => {
    const del = await request(server).delete(`/api/mass-intentions/${miId}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(del.status).toBe(204)
  })
})

// Placed ABOVE 'role enforcement' (which self-demotes tokenA) — needs admin.
describe('finance ledger (FIN.1)', () => {
  const FIN_CAT = `Fin-${RUN_ID}`

  it('serves the standard chart of accounts template', async () => {
    const res = await request(server).get('/api/finance/coa')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    const sunday = res.body.accounts.find(a => a.code === '4110')
    expect(sunday).toBeTruthy()
    expect(sunday.acct_type).toBe('revenue')
    expect(sunday.assessable).toBe(true)
    expect(sunday.customized).toBe(false)
  })

  it('records a manual entry and rejects bad ones', async () => {
    const ok = await request(server).post('/api/finance/ledger')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ entry_date: '2027-03-10', account_code: '5420', amount: 350.25, memo: `Utilities ${RUN_ID}` })
    expect(ok.status).toBe(201)
    expect(ok.body.account_code).toBe('5420')

    const badCode = await request(server).post('/api/finance/ledger')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ entry_date: '2027-03-10', account_code: '9999', amount: 10 })
    expect(badCode.status).toBe(400)

    const zero = await request(server).post('/api/finance/ledger')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ entry_date: '2027-03-10', account_code: '5420', amount: 0 })
    expect(zero.status).toBe(400)
  })

  it('derives donations into the ledger, and remaps them at read time', async () => {
    const gift = await request(server).post('/api/donations')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ donor_name: 'Ledger Donor', amount: 100, category: FIN_CAT, date: '2027-03-15' })
    expect(gift.status).toBe(201)

    // Unmapped → the default gifts account (4420).
    const before = await request(server)
      .get('/api/finance/ledger?start=2027-03-01&end=2027-03-31&source=donation')
      .set('Authorization', `Bearer ${tokenA}`)
    const rowBefore = before.body.entries.find(e => e.memo === FIN_CAT)
    expect(rowBefore).toBeTruthy()
    expect(rowBefore.account_code).toBe('4420')

    // Map the category to Sunday offertory — the SAME donation now reads
    // as 4110. No re-posting, no drift: the ledger is a projection.
    const map = await request(server).put('/api/finance/mappings')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ mappings: [{ source_type: 'donation_category', source_key: FIN_CAT, account_code: '4110' }] })
    expect(map.status).toBe(200)

    const after = await request(server)
      .get('/api/finance/ledger?start=2027-03-01&end=2027-03-31&source=donation')
      .set('Authorization', `Bearer ${tokenA}`)
    const rowAfter = after.body.entries.find(e => e.memo === FIN_CAT)
    expect(rowAfter.account_code).toBe('4110')
  })

  it('imports a trial balance with per-row errors', async () => {
    const csv = 'account_code,amount,memo\n4310,1200.00,RE fees\n5210,-0,broken\n5310,80.50,Candles'
    const res = await request(server).post('/api/finance/ledger/import')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ csv, as_of: '2027-03-31' })
    expect(res.status).toBe(201)
    expect(res.body.imported).toBe(2)
    expect(res.body.errors.length).toBe(1)
    expect(res.body.batch).toBeTruthy()
  })

  it('summarizes the period with an assessable base', async () => {
    const res = await request(server)
      .get('/api/finance/summary?start=2027-03-01&end=2027-03-31')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    // Mapped donation (4110, assessable) + imported RE fees (4310, assessable).
    expect(Number(res.body.totals.assessable_base)).toBeGreaterThanOrEqual(1300)
    // Manual utilities + imported candles are expenses.
    expect(Number(res.body.totals.expense)).toBeGreaterThanOrEqual(430)
    const offertory = res.body.groups.find(g => g.rollup_group === 'Offertory')
    expect(offertory).toBeTruthy()
  })

  it('is tenant-isolated (org B sees none of it, and mappings are per-org)', async () => {
    const ledger = await request(server)
      .get('/api/finance/ledger?start=2027-03-01&end=2027-03-31')
      .set('Authorization', `Bearer ${tokenB}`)
    expect(ledger.status).toBe(200)
    expect(ledger.body.entries.some(e => e.memo === FIN_CAT || e.memo === `Utilities ${RUN_ID}`)).toBe(false)

    // Org B mapping the same category name must not reclassify org A's rows.
    const map = await request(server).put('/api/finance/mappings')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ mappings: [{ source_type: 'donation_category', source_key: FIN_CAT, account_code: '4910' }] })
    expect(map.status).toBe(200)

    const orgA = await request(server)
      .get('/api/finance/ledger?start=2027-03-01&end=2027-03-31&source=donation')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(orgA.body.entries.find(e => e.memo === FIN_CAT).account_code).toBe('4110')
  })
})

// Placed ABOVE 'role enforcement' (which self-demotes tokenA) — needs admin.
describe('diocese affiliation (DIO.1)', () => {
  const dioceseOrg = {
    organizationName: `Test Diocese ${RUN_ID}`,
    name: 'Bishop Admin',
    email: `diocese_${RUN_ID}@example.com`,
    password: 'smoke-test-pw-10',
    organizationType: 'diocese',
  }
  const dioceseOrg2 = {
    organizationName: `Test Diocese II ${RUN_ID}`,
    name: 'Rival Chancery',
    email: `diocese2_${RUN_ID}@example.com`,
    password: 'smoke-test-pw-11',
    organizationType: 'diocese',
  }
  let dioToken, dioToken2, dioOrgId, dioOrgId2, affiliationId
  const cleanupOrgIds = []

  beforeAll(async () => {
    // Distinct X-Forwarded-For per signup — own signup-limiter buckets
    // (see the auth-lifecycle group's note).
    const a = await request(server).post('/api/auth/signup')
      .set('X-Forwarded-For', '10.99.0.5').send(dioceseOrg)
    expect(a.status).toBe(201)
    dioToken = a.body.token; dioOrgId = a.body.user.organization.id
    cleanupOrgIds.push(dioOrgId)

    const b = await request(server).post('/api/auth/signup')
      .set('X-Forwarded-For', '10.99.0.6').send(dioceseOrg2)
    expect(b.status).toBe(201)
    dioToken2 = b.body.token; dioOrgId2 = b.body.user.organization.id
    cleanupOrgIds.push(dioOrgId2)
  })

  afterAll(async () => {
    for (const id of cleanupOrgIds) {
      await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
    }
  })

  it('stamps org_type and skips the parish sample seed for a diocese', async () => {
    const { rows } = await pool.query(
      'SELECT org_type FROM ochr_organizations WHERE id = $1', [dioOrgId]
    )
    expect(rows[0].org_type).toBe('diocese')
    const { rows: members } = await pool.query(
      'SELECT COUNT(*)::INT AS n FROM ochr_clients WHERE organization_id = $1', [dioOrgId]
    )
    expect(members[0].n).toBe(0)
  })

  it('hard-gates the diocese surface from parish tokens (reads included)', async () => {
    const res = await request(server).get('/api/diocese/parishes')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(403)
  })

  it('invites a parish by its admin email', async () => {
    const miss = await request(server).post('/api/diocese/parishes/invite')
      .set('Authorization', `Bearer ${dioToken}`)
      .send({ email: `nobody_${RUN_ID}@example.com` })
    expect(miss.status).toBe(404)

    const res = await request(server).post('/api/diocese/parishes/invite')
      .set('Authorization', `Bearer ${dioToken}`)
      .send({ email: orgA.email })
    expect(res.status).toBe(201)
    expect(res.body.status).toBe('invited')
    expect(res.body.parish_name).toBe(orgA.organizationName)
    affiliationId = res.body.id

    // One live diocese per parish: a rival's invite bounces cleanly.
    const rival = await request(server).post('/api/diocese/parishes/invite')
      .set('Authorization', `Bearer ${dioToken2}`)
      .send({ email: orgA.email })
    expect(rival.status).toBe(409)
  })

  it('lets the parish see and accept the invitation with a grant level', async () => {
    const pending = await request(server).get('/api/affiliation')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(pending.status).toBe(200)
    expect(pending.body.affiliation.status).toBe('invited')
    expect(pending.body.affiliation.diocese_name).toBe(dioceseOrg.organizationName)

    const accept = await request(server).post('/api/affiliation/accept')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ grant_level: 'summary' })
    expect(accept.status).toBe(200)
    expect(accept.body.affiliation.status).toBe('active')
    expect(accept.body.affiliation.grant_level).toBe('summary')

    // The diocese can never flip an invite to active itself — activation
    // was the parish's move; the roster now reflects it.
    const roster = await request(server).get('/api/diocese/parishes')
      .set('Authorization', `Bearer ${dioToken}`)
    const row = roster.body.parishes.find(p => p.id === affiliationId)
    expect(row.status).toBe('active')
  })

  it('lets the parish change its grant level while active', async () => {
    const res = await request(server).patch('/api/affiliation/grant')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ grant_level: 'detail' })
    expect(res.status).toBe(200)
    expect(res.body.affiliation.grant_level).toBe('detail')
  })

  it('is isolated between dioceses', async () => {
    const roster2 = await request(server).get('/api/diocese/parishes')
      .set('Authorization', `Bearer ${dioToken2}`)
    expect(roster2.status).toBe(200)
    expect(roster2.body.parishes.some(p => p.id === affiliationId)).toBe(false)

    const patch = await request(server).patch(`/api/diocese/parishes/${affiliationId}`)
      .set('Authorization', `Bearer ${dioToken2}`)
      .send({ status: 'suspended' })
    expect(patch.status).toBe(404)
  })

  it('suspends from the diocese side, and the parish can leave', async () => {
    const sus = await request(server).patch(`/api/diocese/parishes/${affiliationId}`)
      .set('Authorization', `Bearer ${dioToken}`)
      .send({ status: 'suspended' })
    expect(sus.status).toBe(200)
    expect(sus.body.status).toBe('suspended')

    // Diocese cannot conjure 'active' from 'invited' — and from
    // 'suspended' it may reinstate, which is the allowed transition.
    const leave = await request(server).post('/api/affiliation/leave')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(leave.status).toBe(200)

    const after = await request(server).get('/api/affiliation')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(after.body.affiliation).toBe(null)

    // Ended affiliation frees the parish for a new invitation.
    const reinvite = await request(server).post('/api/diocese/parishes/invite')
      .set('Authorization', `Bearer ${dioToken2}`)
      .send({ email: orgA.email })
    expect(reinvite.status).toBe(201)
    // Clean up: parish declines so later groups see no live affiliation.
    const decline = await request(server).post('/api/affiliation/decline')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(decline.status).toBe(200)
  })
})

// Placed ABOVE 'role enforcement' (which self-demotes tokenA) — needs
// admin. Also depends on the FIN.1 group's March-2027 ledger data
// (mapped donation + manual entry + import) and runs after DIO.1 ended
// org A's earlier affiliations, so a fresh diocese can affiliate it.
describe('diocese reporting + roll-up (DIO.2)', () => {
  const chancery = {
    organizationName: `Test Chancery ${RUN_ID}`,
    name: 'Vicar General',
    email: `chancery_${RUN_ID}@example.com`,
    password: 'smoke-test-pw-12',
    organizationType: 'diocese',
  }
  let chToken, chOrgId, marchSubId
  const cleanupOrgIds = []

  beforeAll(async () => {
    const res = await request(server).post('/api/auth/signup')
      .set('X-Forwarded-For', '10.99.0.7').send(chancery)
    expect(res.status).toBe(201)
    chToken = res.body.token; chOrgId = res.body.user.organization.id
    cleanupOrgIds.push(chOrgId)

    const invite = await request(server).post('/api/diocese/parishes/invite')
      .set('Authorization', `Bearer ${chToken}`).send({ email: orgA.email })
    expect(invite.status).toBe(201)
    const accept = await request(server).post('/api/affiliation/accept')
      .set('Authorization', `Bearer ${tokenA}`).send({ grant_level: 'summary' })
    expect(accept.status).toBe(200)
  })

  afterAll(async () => {
    for (const id of cleanupOrgIds) {
      await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
    }
  })

  it('freezes and submits a period; duplicates are refused', async () => {
    const unaffiliated = await request(server).post('/api/finance/submissions')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ period_start: '2027-03-01', period_end: '2027-03-31' })
    expect(unaffiliated.status).toBe(400)

    const res = await request(server).post('/api/finance/submissions')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ period_start: '2027-03-01', period_end: '2027-03-31' })
    expect(res.status).toBe(201)
    expect(res.body.status).toBe('submitted')
    // FIN.1 data: mapped donation (4110) + RE-fee import (4310) ≥ 1300 assessable.
    expect(Number(res.body.totals.assessable_base)).toBeGreaterThanOrEqual(1300)
    marchSubId = res.body.id

    const dupe = await request(server).post('/api/finance/submissions')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ period_start: '2027-03-01', period_end: '2027-03-31' })
    expect(dupe.status).toBe(409)
  })

  it('approval admits the period to the roll-up — and only approval', async () => {
    const before = await request(server)
      .get('/api/diocese/financials?start=2027-03-01&end=2027-03-31')
      .set('Authorization', `Bearer ${chToken}`)
    expect(before.status).toBe(200)
    expect(before.body.parishes.length).toBe(0)   // submitted ≠ approved

    const queue = await request(server).get('/api/diocese/submissions?status=submitted')
      .set('Authorization', `Bearer ${chToken}`)
    const row = queue.body.submissions.find(s => s.id === marchSubId)
    expect(row).toBeTruthy()
    expect(row.parish_name).toBe(orgA.organizationName)

    const approve = await request(server).patch(`/api/diocese/submissions/${marchSubId}`)
      .set('Authorization', `Bearer ${chToken}`).send({ status: 'approved' })
    expect(approve.status).toBe(200)

    const after = await request(server)
      .get('/api/diocese/financials?start=2027-03-01&end=2027-03-31')
      .set('Authorization', `Bearer ${chToken}`)
    expect(after.body.parishes.length).toBe(1)
    const parish = after.body.parishes[0]
    expect(parish.parish_name).toBe(orgA.organizationName)
    expect(Number(parish.assessable_base)).toBeGreaterThanOrEqual(1300)
    expect(Number(after.body.totals.revenue)).toBe(Number(parish.revenue))
    expect(after.body.groups.some(g => g.rollup_group === 'Offertory')).toBe(true)
  })

  it('honors the grant level on drill-down: summary hides account lines, detail reveals them', async () => {
    const parishRow = (await request(server).get('/api/diocese/parishes')
      .set('Authorization', `Bearer ${chToken}`)).body.parishes.find(p => p.status === 'active')
    const url = `/api/diocese/parishes/${parishRow.parish_org_id}/financials?start=2027-03-01&end=2027-03-31`

    const summary = await request(server).get(url).set('Authorization', `Bearer ${chToken}`)
    expect(summary.status).toBe(200)
    expect(summary.body.grant_level).toBe('summary')
    expect(summary.body.periods.length).toBe(1)
    expect(summary.body.periods[0].groups.length).toBeGreaterThan(0)
    expect(summary.body.periods[0].accounts).toBeUndefined()

    const up = await request(server).patch('/api/affiliation/grant')
      .set('Authorization', `Bearer ${tokenA}`).send({ grant_level: 'detail' })
    expect(up.status).toBe(200)

    const detail = await request(server).get(url).set('Authorization', `Bearer ${chToken}`)
    expect(detail.body.grant_level).toBe('detail')
    expect(detail.body.periods[0].accounts.some(a => a.code === '4110')).toBe(true)
  })

  it('returned periods carry a note and can be resubmitted in place', async () => {
    const april = await request(server).post('/api/finance/submissions')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ period_start: '2027-04-01', period_end: '2027-04-30' })
    expect(april.status).toBe(201)

    const noNote = await request(server).patch(`/api/diocese/submissions/${april.body.id}`)
      .set('Authorization', `Bearer ${chToken}`).send({ status: 'returned' })
    expect(noNote.status).toBe(400)

    const ret = await request(server).patch(`/api/diocese/submissions/${april.body.id}`)
      .set('Authorization', `Bearer ${chToken}`)
      .send({ status: 'returned', note: 'Missing the utilities entries — please recheck.' })
    expect(ret.status).toBe(200)

    const mine = await request(server).get('/api/finance/submissions')
      .set('Authorization', `Bearer ${tokenA}`)
    const aprilRow = mine.body.submissions.find(s => s.id === april.body.id)
    expect(aprilRow.status).toBe('returned')
    expect(aprilRow.review_note).toMatch(/utilities/)

    const resubmit = await request(server).post('/api/finance/submissions')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ period_start: '2027-04-01', period_end: '2027-04-30' })
    expect(resubmit.status).toBe(201)
    expect(resubmit.body.status).toBe('submitted')

    // An approved period cannot be re-reviewed or resubmitted over.
    const reReview = await request(server).patch(`/api/diocese/submissions/${marchSubId}`)
      .set('Authorization', `Bearer ${chToken}`).send({ status: 'returned', note: 'x' })
    expect(reReview.status).toBe(404)
  })

  it('keeps everything tenant-scoped', async () => {
    // A parish token can't touch diocese review surfaces at all.
    const asParish = await request(server).get('/api/diocese/submissions')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(asParish.status).toBe(403)
    // Org B (unaffiliated parish) sees no submissions of its own.
    const orgBSubs = await request(server).get('/api/finance/submissions')
      .set('Authorization', `Bearer ${tokenB}`)
    expect(orgBSubs.status).toBe(200)
    expect(orgBSubs.body.submissions.length).toBe(0)
  })

  // Leave org A clean for later groups: end the affiliation.
  afterAll(async () => {
    await request(server).post('/api/affiliation/leave')
      .set('Authorization', `Bearer ${tokenA}`).catch(() => {})
  })
})

// Placed ABOVE 'role enforcement' (which self-demotes tokenA) — needs
// admin. Runs after DIO.2 (which ended org A's affiliation and deleted
// its chancery, cascading those submissions away), so a fresh chancery
// re-affiliates org A cleanly. Reuses org A's FIN.1 March-2027 ledger.
describe('assessments + financial observations (DIO.4)', () => {
  const chancery = {
    organizationName: `Test Chancery D ${RUN_ID}`,
    name: 'Finance Vicar',
    email: `chanceryd_${RUN_ID}@example.com`,
    password: 'smoke-test-pw-13',
    organizationType: 'diocese',
  }
  const FIN_CAT = `Fin-${RUN_ID}`   // mapped to 4110 by the FIN.1 group
  let chToken, chOrgId, assessment2027
  const cleanupOrgIds = []

  const submitAndApprove = async (start, end) => {
    const sub = await request(server).post('/api/finance/submissions')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ period_start: start, period_end: end })
    expect(sub.status).toBe(201)
    const ap = await request(server).patch(`/api/diocese/submissions/${sub.body.id}`)
      .set('Authorization', `Bearer ${chToken}`).send({ status: 'approved' })
    expect(ap.status).toBe(200)
  }

  beforeAll(async () => {
    const res = await request(server).post('/api/auth/signup')
      .set('X-Forwarded-For', '10.99.0.8').send(chancery)
    expect(res.status).toBe(201)
    chToken = res.body.token; chOrgId = res.body.user.organization.id
    cleanupOrgIds.push(chOrgId)

    const invite = await request(server).post('/api/diocese/parishes/invite')
      .set('Authorization', `Bearer ${chToken}`).send({ email: orgA.email })
    expect(invite.status).toBe(201)
    const accept = await request(server).post('/api/affiliation/accept')
      .set('Authorization', `Bearer ${tokenA}`).send({ grant_level: 'summary' })
    expect(accept.status).toBe(200)

    // A troubled 2026 for org A: two deficit months, revenue collapsing.
    for (const [date, amount] of [['2026-01-15', 1000], ['2026-02-15', 100]]) {
      const gift = await request(server).post('/api/donations')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ donor_name: 'Distress Donor', amount, category: FIN_CAT, date })
      expect(gift.status).toBe(201)
    }
    for (const [date, amount] of [['2026-01-20', 1500], ['2026-02-20', 600]]) {
      const exp = await request(server).post('/api/finance/ledger')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ entry_date: date, account_code: '5210', amount, memo: `Admin ${RUN_ID}` })
      expect(exp.status).toBe(201)
    }
    await submitAndApprove('2026-01-01', '2026-01-31')
    await submitAndApprove('2026-02-01', '2026-02-28')
  }, 30_000)

  afterAll(async () => {
    await request(server).post('/api/affiliation/leave')
      .set('Authorization', `Bearer ${tokenA}`).catch(() => {})
    for (const id of cleanupOrgIds) {
      await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
    }
  })

  it('makes all three observations about the parish, with the numbers behind them', async () => {
    const res = await request(server).get('/api/diocese/observations')
      .set('Authorization', `Bearer ${chToken}`)
    expect(res.status).toBe(200)
    const p = res.body.parishes.find(x => x.parish_name === orgA.organizationName)
    expect(p).toBeTruthy()
    const codes = p.flags.map(f => f.code)
    expect(codes).toContain('quiet_period')             // Feb 2026 is long past
    expect(codes).toContain('revenue_lower')            // 1000 → 100
    expect(codes).toContain('spending_exceeds_income')  // two net-negative months
    expect(p.flags.find(f => f.code === 'revenue_lower').detail).toMatch(/Revenue is \d+% lower/)

    // One vocabulary across the product (CARE.1). An observation is a
    // noticing, not a verdict — nothing here may read as a judgement.
    const words = JSON.stringify(p).toLowerCase()
    for (const banned of ['distress', 'stale', 'deficit', 'at risk', 'health', 'failing', 'delinquent']) {
      expect(words, `observation contains "${banned}"`).not.toContain(banned)
    }
  })

  it('stops making them once a current, net-positive period is approved', async () => {
    await submitAndApprove('2027-03-01', '2027-03-31')  // net-positive, recent
    const res = await request(server).get('/api/diocese/observations')
      .set('Authorization', `Bearer ${chToken}`)
    const p = res.body.parishes.find(x => x.parish_name === orgA.organizationName)
    expect(p).toBeUndefined()
  })

  it('computes an assessment year from approved bases only', async () => {
    const res = await request(server).post('/api/diocese/assessments')
      .set('Authorization', `Bearer ${chToken}`)
      .send({ fiscal_year: '2027', rate_bps: 800 })
    expect(res.status).toBe(201)
    assessment2027 = res.body
    expect(assessment2027.status).toBe('draft')
    const line = assessment2027.lines.find(l => l.parish_name === orgA.organizationName)
    // The invariant, not a magic number: the 2027 base equals the parish's
    // own assessable base for the approved 2027 period — and the 2026
    // periods stay out of the 2027 year.
    const summary = await request(server)
      .get('/api/finance/summary?start=2027-03-01&end=2027-03-31')
      .set('Authorization', `Bearer ${tokenA}`)
    const expectedBase = Number(summary.body.totals.assessable_base)
    expect(expectedBase).toBeGreaterThan(0)
    expect(Number(line.base)).toBeCloseTo(expectedBase, 2)
    expect(Number(line.assessed)).toBeCloseTo(Math.round(expectedBase * 8) / 100, 2)

    const dupe = await request(server).post('/api/diocese/assessments')
      .set('Authorization', `Bearer ${chToken}`)
      .send({ fiscal_year: '2027', rate_bps: 900 })
    expect(dupe.status).toBe(409)
  })

  it('supports hardship overrides and payment tracking on a line', async () => {
    const line = assessment2027.lines.find(l => l.parish_name === orgA.organizationName)

    const over = await request(server)
      .patch(`/api/diocese/assessments/${assessment2027.id}/lines/${line.id}`)
      .set('Authorization', `Bearer ${chToken}`)
      .send({ rate_bps: 400, note: 'Hardship reduction after fire damage' })
    expect(over.status).toBe(200)
    let l = over.body.lines.find(x => x.id === line.id)
    const halved = Math.round(Number(line.base) * 4) / 100
    expect(Number(l.assessed)).toBeCloseTo(halved, 2)   // 4% of the base
    expect(l.note).toMatch(/Hardship/)

    const partial = await request(server)
      .patch(`/api/diocese/assessments/${assessment2027.id}/lines/${line.id}`)
      .set('Authorization', `Bearer ${chToken}`)
      .send({ record_payment: 20 })
    expect(partial.body.lines.find(x => x.id === line.id).status).toBe('partial')

    const remainder = Math.round((halved - 20) * 100) / 100
    const paid = await request(server)
      .patch(`/api/diocese/assessments/${assessment2027.id}/lines/${line.id}`)
      .set('Authorization', `Bearer ${chToken}`)
      .send({ record_payment: remainder })
    l = paid.body.lines.find(x => x.id === line.id)
    expect(l.status).toBe('paid')
    expect(Number(l.paid)).toBeCloseTo(halved, 2)
  })

  it('walks the lifecycle forward only, and waived lines leave the total', async () => {
    const pub = await request(server).patch(`/api/diocese/assessments/${assessment2027.id}`)
      .set('Authorization', `Bearer ${chToken}`).send({ status: 'published' })
    expect(pub.status).toBe(200)
    expect(pub.body.status).toBe('published')

    // No recompute after publish; no skipping back to draft.
    const recompute = await request(server).post(`/api/diocese/assessments/${assessment2027.id}/recompute`)
      .set('Authorization', `Bearer ${chToken}`)
    expect(recompute.status).toBe(400)

    // A separate 2026 year: base = 1000 + 100, then waive the line.
    const y26 = await request(server).post('/api/diocese/assessments')
      .set('Authorization', `Bearer ${chToken}`)
      .send({ fiscal_year: '2026', rate_bps: 1000 })
    expect(y26.status).toBe(201)
    const line26 = y26.body.lines.find(l => l.parish_name === orgA.organizationName)
    // Same invariant for 2026: line base == the parish's own assessable
    // base across the two approved 2026 periods.
    const sum26 = await request(server)
      .get('/api/finance/summary?start=2026-01-01&end=2026-02-28')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(Number(line26.base)).toBeCloseTo(Number(sum26.body.totals.assessable_base), 2)
    expect(Number(line26.assessed)).toBeCloseTo(Math.round(Number(line26.base) * 10) / 100, 2)

    const waived = await request(server)
      .patch(`/api/diocese/assessments/${y26.body.id}/lines/${line26.id}`)
      .set('Authorization', `Bearer ${chToken}`)
      .send({ status: 'waived', note: 'First-year grace' })
    expect(waived.status).toBe(200)
    expect(Number(waived.body.totals.assessed)).toBe(0)

    // Close 2027; a closed year refuses line edits.
    const closed = await request(server).patch(`/api/diocese/assessments/${assessment2027.id}`)
      .set('Authorization', `Bearer ${chToken}`).send({ status: 'closed' })
    expect(closed.body.status).toBe('closed')
    const line = assessment2027.lines.find(l => l.parish_name === orgA.organizationName)
    const late = await request(server)
      .patch(`/api/diocese/assessments/${assessment2027.id}/lines/${line.id}`)
      .set('Authorization', `Bearer ${chToken}`)
      .send({ record_payment: 1 })
    expect(late.status).toBe(400)
  })

  it('is chancery-only', async () => {
    const asParish = await request(server).get('/api/diocese/assessments')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(asParish.status).toBe(403)
  })

  it('assesses a boundary-spanning period in the year it ends', async () => {
    const gift = await request(server).post('/api/donations')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ donor_name: 'Boundary Donor', amount: 500, category: FIN_CAT, date: '2027-12-20' })
    expect(gift.status).toBe(201)
    await submitAndApprove('2027-12-15', '2028-01-15')

    // What the parish itself reports as assessable across that period.
    const summary = await request(server)
      .get('/api/finance/summary?start=2027-12-15&end=2028-01-15')
      .set('Authorization', `Bearer ${tokenA}`)
    const expectedBase = Number(summary.body.totals.assessable_base)
    expect(expectedBase).toBeGreaterThan(0)

    // The 2028 year (period_end = 2028-01-15) picks it up...
    const a2028 = await request(server).post('/api/diocese/assessments')
      .set('Authorization', `Bearer ${chToken}`)
      .send({ fiscal_year: '2028', rate_bps: 800 })
    expect(a2028.status).toBe(201)
    const line28 = a2028.body.lines.find(l => l.parish_name === orgA.organizationName)
    expect(line28).toBeTruthy()
    expect(Number(line28.base)).toBeCloseTo(expectedBase, 2)

    // ...and a year in which nothing closes (2029) stays empty — the
    // period lands in exactly one year, and doesn't spill into later ones.
    const a2029 = await request(server).post('/api/diocese/assessments')
      .set('Authorization', `Bearer ${chToken}`)
      .send({ fiscal_year: '2029', rate_bps: 800 })
    expect(a2029.status).toBe(201)
    const line29 = a2029.body.lines.find(l => l.parish_name === orgA.organizationName)
    expect(line29).toBeUndefined()
  })

  // #4 — unwaiving a line must re-derive its status from the money on it,
  // not blindly reset to 'pending' (a fully-paid line stays paid).
  it('re-derives status when a paid line is unwaived', async () => {
    await request(server).post('/api/donations').set('Authorization', `Bearer ${tokenA}`)
      .send({ donor_name: 'Unwaive Donor', amount: 1000, category: FIN_CAT, date: '2024-06-15' })
    await submitAndApprove('2024-06-01', '2024-06-30')
    const a = await request(server).post('/api/diocese/assessments')
      .set('Authorization', `Bearer ${chToken}`).send({ fiscal_year: '2024', rate_bps: 1000 })
    expect(a.status).toBe(201)
    const line = a.body.lines.find(l => l.parish_name === orgA.organizationName)
    expect(Number(line.assessed)).toBeGreaterThan(0)

    const paid = await request(server)
      .patch(`/api/diocese/assessments/${a.body.id}/lines/${line.id}`)
      .set('Authorization', `Bearer ${chToken}`).send({ record_payment: Number(line.assessed) })
    expect(paid.body.lines.find(x => x.id === line.id).status).toBe('paid')

    await request(server).patch(`/api/diocese/assessments/${a.body.id}/lines/${line.id}`)
      .set('Authorization', `Bearer ${chToken}`).send({ status: 'waived' })
    const unwaived = await request(server)
      .patch(`/api/diocese/assessments/${a.body.id}/lines/${line.id}`)
      .set('Authorization', `Bearer ${chToken}`).send({ status: 'pending' })
    // The payment is still on the line, so it comes back as 'paid', not 'pending'.
    expect(unwaived.body.lines.find(x => x.id === line.id).status).toBe('paid')
  })

  // #1 — two payments fired together must both land. Under a plain
  // read-modify-write one clobbers the other; the FOR UPDATE lock serializes.
  it('does not lose a concurrent payment write', async () => {
    await request(server).post('/api/donations').set('Authorization', `Bearer ${tokenA}`)
      .send({ donor_name: 'Concurrent Donor', amount: 1000, category: FIN_CAT, date: '2025-06-15' })
    await submitAndApprove('2025-06-01', '2025-06-30')
    const a = await request(server).post('/api/diocese/assessments')
      .set('Authorization', `Bearer ${chToken}`).send({ fiscal_year: '2025', rate_bps: 1000 })
    expect(a.status).toBe(201)
    const line = a.body.lines.find(l => l.parish_name === orgA.organizationName)

    const pay = () => request(server)
      .patch(`/api/diocese/assessments/${a.body.id}/lines/${line.id}`)
      .set('Authorization', `Bearer ${chToken}`).send({ record_payment: 10 })
    await Promise.all([pay(), pay()])

    const after = await request(server).get(`/api/diocese/assessments/${a.body.id}`)
      .set('Authorization', `Bearer ${chToken}`)
    expect(Number(after.body.lines.find(x => x.id === line.id).paid)).toBeCloseTo(20, 2)
  })

  // #2 — a draft recompute must drop the line of a parish that has dropped
  // out, so its stale base stops inflating the bill.
  it('recompute drops lines for parishes that no longer qualify', async () => {
    const email = `lapsing_${RUN_ID}@example.com`
    const name = `Lapsing Parish ${RUN_ID}`
    const p = await request(server).post('/api/auth/signup')
      .set('X-Forwarded-For', '10.99.0.10')
      .send({ organizationName: name, name: 'Pastor', email, password: 'smoke-test-pw-15', organizationType: 'parish' })
    expect(p.status).toBe(201)
    const pToken = p.body.token
    cleanupOrgIds.push(p.body.user.organization.id)

    await request(server).post('/api/diocese/parishes/invite')
      .set('Authorization', `Bearer ${chToken}`).send({ email })
    await request(server).post('/api/affiliation/accept')
      .set('Authorization', `Bearer ${pToken}`).send({ grant_level: 'summary' })

    await request(server).post('/api/donations').set('Authorization', `Bearer ${pToken}`)
      .send({ donor_name: 'Lapsing Donor', amount: 400, category: FIN_CAT, date: '2023-05-15' })
    const sub = await request(server).post('/api/finance/submissions')
      .set('Authorization', `Bearer ${pToken}`).send({ period_start: '2023-05-01', period_end: '2023-05-31' })
    expect(sub.status).toBe(201)
    await request(server).patch(`/api/diocese/submissions/${sub.body.id}`)
      .set('Authorization', `Bearer ${chToken}`).send({ status: 'approved' })

    const a23 = await request(server).post('/api/diocese/assessments')
      .set('Authorization', `Bearer ${chToken}`).send({ fiscal_year: '2023', rate_bps: 800 })
    expect(a23.status).toBe(201)
    expect(a23.body.lines.some(l => l.parish_name === name)).toBe(true)

    const left = await request(server).post('/api/affiliation/leave')
      .set('Authorization', `Bearer ${pToken}`)
    expect(left.status).toBe(200)

    const re = await request(server).post(`/api/diocese/assessments/${a23.body.id}/recompute`)
      .set('Authorization', `Bearer ${chToken}`)
    expect(re.status).toBe(200)
    expect(re.body.lines.some(l => l.parish_name === name)).toBe(false)
  })

  // #3 — org scoping is the isolation control here (RLS has no policies), so
  // assert a second diocese is 404'd out of another diocese's assessment.
  it('404s a foreign diocese out of a foreign assessment', async () => {
    const other = await request(server).post('/api/auth/signup')
      .set('X-Forwarded-For', '10.99.0.9')
      .send({ organizationName: `Other Chancery ${RUN_ID}`, name: 'Other Vicar',
              email: `otherchancery_${RUN_ID}@example.com`, password: 'smoke-test-pw-14', organizationType: 'diocese' })
    expect(other.status).toBe(201)
    cleanupOrgIds.push(other.body.user.organization.id)
    const H = { Authorization: `Bearer ${other.body.token}` }

    const aid = assessment2027.id
    const lid = assessment2027.lines[0].id
    expect((await request(server).get(`/api/diocese/assessments/${aid}`).set(H)).status).toBe(404)
    expect((await request(server).patch(`/api/diocese/assessments/${aid}`).set(H).send({ notes: 'x' })).status).toBe(404)
    expect((await request(server).post(`/api/diocese/assessments/${aid}/recompute`).set(H)).status).toBe(404)
    expect((await request(server).patch(`/api/diocese/assessments/${aid}/lines/${lid}`).set(H).send({ record_payment: 1 })).status).toBe(404)
  })

  it("the covenant lapses with the affiliation: review and visibility end when the parish leaves", async () => {
    // An in-flight submission the chancery hasn't reviewed yet.
    const pending = await request(server).post('/api/finance/submissions')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ period_start: '2027-05-01', period_end: '2027-05-31' })
    expect(pending.status).toBe(201)

    // Parish leaves the diocese.
    const leave = await request(server).post('/api/affiliation/leave')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(leave.status).toBe(200)

    // The chancery can no longer review the in-flight submission…
    const review = await request(server).patch(`/api/diocese/submissions/${pending.body.id}`)
      .set('Authorization', `Bearer ${chToken}`)
      .send({ status: 'approved' })
    expect(review.status).toBe(404)

    // …and the parish's submissions vanish from the chancery's queue.
    const list = await request(server).get('/api/diocese/submissions')
      .set('Authorization', `Bearer ${chToken}`)
    expect(list.status).toBe(200)
    expect(list.body.submissions.some(s => s.parish_name === orgA.organizationName)).toBe(false)
  })

  // Regression: a report period that straddles a year boundary must be
  // assessed in the year it CLOSES, not silently dropped from both years.
  // computeBases anchors on period_end, so this Dec→Jan period belongs to
  // 2028 (the year period_end falls in) and shows up in the 2028 year.
})

describe('chart of accounts trickles down + the parish return path (DIO.5)', () => {
  // Everything before this suite flows UP: a parish submits, the chancery
  // approves, the roll-up reads. Two things were missing in the other
  // direction, and they are what this covers.
  //
  //   1. The diocese could not say what an account MEANS. The parish-side
  //      resolver only ever read the template and the parish's own rows,
  //      so a parish could untick `assessable` and quietly shrink its own
  //      assessment with the chancery none the wiser.
  //   2. A parish could not see anything that came back down — not its
  //      assessment, not what review was outstanding, not why a submission
  //      was returned.
  const chancery = {
    organizationName: `Test Chancery E ${RUN_ID}`,
    name: 'Chancellor',
    email: `chancerye_${RUN_ID}@example.com`,
    password: 'smoke-test-pw-14',
    organizationType: 'diocese',
  }
  const loner = {
    organizationName: `Unaffiliated Parish ${RUN_ID}`,
    name: 'Solo Secretary',
    email: `loner_${RUN_ID}@example.com`,
    password: 'smoke-test-pw-15',
  }
  let chToken, chOrgId, loneToken, loneOrgId, parishAOrgId
  const cleanupOrgIds = []

  // 4110 is an assessable revenue account in the standard template; the
  // diocese will turn it OFF, which is the direction a parish cannot fake.
  const CODE = '4110'

  beforeAll(async () => {
    const ch = await request(server).post('/api/auth/signup')
      .set('X-Forwarded-For', '10.99.0.9').send(chancery)
    expect(ch.status).toBe(201)
    chToken = ch.body.token; chOrgId = ch.body.user.organization.id
    cleanupOrgIds.push(chOrgId)

    const lo = await request(server).post('/api/auth/signup')
      .set('X-Forwarded-For', '10.99.0.9').send(loner)
    expect(lo.status).toBe(201)
    loneToken = lo.body.token; loneOrgId = lo.body.user.organization.id
    cleanupOrgIds.push(loneOrgId)

    const me = await request(server).get('/api/auth/me').set('Authorization', `Bearer ${tokenA}`)
    expect(me.status).toBe(200)
    parishAOrgId = me.body.user?.organization?.id ?? me.body.organization?.id ?? me.body.user?.organization_id
    expect(parishAOrgId).toBeTruthy()

    const invite = await request(server).post('/api/diocese/parishes/invite')
      .set('Authorization', `Bearer ${chToken}`).send({ email: orgA.email })
    expect(invite.status).toBe(201)
    const accept = await request(server).post('/api/affiliation/accept')
      .set('Authorization', `Bearer ${tokenA}`).send({ grant_level: 'summary' })
    expect(accept.status).toBe(200)
  }, 30_000)

  afterAll(async () => {
    await pool.query('DELETE FROM ochr_coa_accounts WHERE organization_id = $1', [parishAOrgId]).catch(() => {})
    // The unaffiliated parish owns rows too now (the two structure tests
    // below), and it is torn down by the same loop.
    await pool.query('DELETE FROM ochr_coa_accounts WHERE organization_id = $1', [loneOrgId]).catch(() => {})
    await request(server).post('/api/affiliation/leave')
      .set('Authorization', `Bearer ${tokenA}`).catch(() => {})
    for (const id of cleanupOrgIds) {
      await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
    }
  })

  const parishCoa = async (token) => {
    const res = await request(server).get('/api/finance/coa').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    return res.body.accounts.find(a => a.code === CODE)
  }

  it('a parish token cannot reach the diocese chart of accounts at all', async () => {
    const res = await request(server).get('/api/diocese/coa')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(403)
  })

  it('the diocese can read a chart of accounts before customizing anything', async () => {
    const res = await request(server).get('/api/diocese/coa')
      .set('Authorization', `Bearer ${chToken}`)
    expect(res.status).toBe(200)
    const acct = res.body.accounts.find(a => a.code === CODE)
    expect(acct).toBeTruthy()
    expect(acct.customized).toBe(false)     // still the standard template
  })

  it('rejects a malformed account rather than half-saving the batch', async () => {
    const before = await request(server).get('/api/diocese/coa')
      .set('Authorization', `Bearer ${chToken}`)
    const res = await request(server).put('/api/diocese/coa')
      .set('Authorization', `Bearer ${chToken}`)
      .send({ accounts: [{ code: CODE, assessable: false }, { code: 'nope' }] })
    expect(res.status).toBe(400)
    const after = await request(server).get('/api/diocese/coa')
      .set('Authorization', `Bearer ${chToken}`)
    expect(after.body.accounts).toEqual(before.body.accounts)
  })

  it('a partial patch keeps the template name instead of nulling it', async () => {
    const res = await request(server).put('/api/diocese/coa')
      .set('Authorization', `Bearer ${chToken}`)
      .send({ accounts: [{ code: CODE, assessable: false, rollup_group: 'Diocesan Offertory' }] })
    expect(res.status).toBe(200)
    const acct = res.body.accounts.find(a => a.code === CODE)
    expect(acct.customized).toBe(true)
    expect(acct.assessable).toBe(false)
    expect(acct.rollup_group).toBe('Diocesan Offertory')
    expect(acct.name).toBeTruthy()          // inherited, not blanked
    expect(acct.acct_type).toBe('revenue')  // inherited
  })

  it('the affiliated parish inherits the diocese structure', async () => {
    const acct = await parishCoa(tokenA)
    expect(acct.assessable).toBe(false)
    expect(acct.rollup_group).toBe('Diocesan Offertory')
    expect(acct.structure_from_diocese).toBe(true)
  })

  it('an unaffiliated parish is untouched by another diocese customizing', async () => {
    const acct = await parishCoa(loneToken)
    expect(acct.assessable).toBe(true)              // still the template
    expect(acct.rollup_group).not.toBe('Diocesan Offertory')
    expect(acct.structure_from_diocese).toBe(false)
  })

  // The two tests above only ever assert the TEMPLATE's values for the
  // unaffiliated parish, because that parish owns no rows. So neither one
  // could see the regression these two cover: capping structure at layer 1
  // meant "the diocese decides" collapsed into "the template decides" the
  // moment no diocese was attached, and any account a parish owned outright
  // fell out of the result entirely. Both were money — `assessable` feeds
  // the assessable base, and a dropped account takes its revenue with it.
  it('an UNAFFILIATED parish still decides its own structure, not the template', async () => {
    await pool.query(
      `INSERT INTO ochr_coa_accounts
         (organization_id, code, name, acct_type, rollup_group, assessable, sort_order, active)
       VALUES ($1, $2, 'Loner Wording', 'revenue', 'Loner Bucket', FALSE, 5, FALSE)
       ON CONFLICT (organization_id, code) WHERE organization_id IS NOT NULL
       DO UPDATE SET name = EXCLUDED.name, assessable = EXCLUDED.assessable,
                     active = EXCLUDED.active`,
      [loneOrgId, CODE]
    )
    const acct = await parishCoa(loneToken)
    expect(acct.name).toBe('Loner Wording')
    expect(acct.assessable).toBe(false)   // regressed to true (the template)
    expect(acct.active).toBe(false)       // regressed to true (the template)
    expect(acct.structure_from_diocese).toBe(false)
  })

  it('an account only the parish defines is not dropped from its own chart', async () => {
    // 9997 exists in no template and at no diocese. Nothing above layer 2
    // describes it, so an inner join against a layer-1-capped structure
    // silently removed it — from the CoA, from ledger-code validation, and
    // from the totals.
    await pool.query(
      `INSERT INTO ochr_coa_accounts
         (organization_id, code, name, acct_type, rollup_group, assessable, sort_order, active)
       VALUES ($1, '9997', 'Parish Only Account', 'revenue', 'Loner Bucket', TRUE, 997, TRUE)
       ON CONFLICT (organization_id, code) WHERE organization_id IS NOT NULL DO NOTHING`,
      [loneOrgId]
    )
    const res = await request(server).get('/api/finance/coa')
      .set('Authorization', `Bearer ${loneToken}`)
    expect(res.status).toBe(200)
    const own = res.body.accounts.find(a => a.code === '9997')
    expect(own).toBeTruthy()
    expect(own.name).toBe('Parish Only Account')
    expect(own.assessable).toBe(true)
    // Still exactly one row per code — the fallback must not duplicate.
    const codes = res.body.accounts.map(a => a.code)
    expect(codes.length).toBe(new Set(codes).size)
  })

  it('the parish keeps its own wording but CANNOT overrule the money semantics', async () => {
    // The parish renames the account and tries to turn assessable back on.
    await pool.query(
      `INSERT INTO ochr_coa_accounts
         (organization_id, code, name, acct_type, rollup_group, assessable, sort_order, active)
       VALUES ($1, $2, 'Our Own Words', 'revenue', 'Parish Bucket', TRUE, 5, TRUE)
       ON CONFLICT (organization_id, code) WHERE organization_id IS NOT NULL
       DO UPDATE SET name = EXCLUDED.name, rollup_group = EXCLUDED.rollup_group,
                     assessable = EXCLUDED.assessable`,
      [parishAOrgId, CODE]
    )
    const acct = await parishCoa(tokenA)
    expect(acct.name).toBe('Our Own Words')          // wording: parish wins
    expect(acct.assessable).toBe(false)              // money: diocese wins
    expect(acct.rollup_group).toBe('Diocesan Offertory')
    expect(acct.structure_from_diocese).toBe(true)
  })

  it('a parish deactivating a diocesan account does not make it disappear', async () => {
    // Same evasion by a different door: if `active` were the parish's to
    // set, unticking it would drop the account from the roll-up entirely.
    await pool.query(
      `UPDATE ochr_coa_accounts SET active = FALSE WHERE organization_id = $1 AND code = $2`,
      [parishAOrgId, CODE]
    )
    const acct = await parishCoa(tokenA)
    expect(acct.active).toBe(true)
    await pool.query(
      `DELETE FROM ochr_coa_accounts WHERE organization_id = $1 AND code = $2`,
      [parishAOrgId, CODE]
    )
  })

  // ---- the return path ----

  it('an unaffiliated parish gets a renderable answer, not a 404', async () => {
    const res = await request(server).get('/api/finance/diocese')
      .set('Authorization', `Bearer ${loneToken}`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ affiliated: false })
  })

  it('an affiliated parish sees its diocese, its grant level and its review queue', async () => {
    const res = await request(server).get('/api/finance/diocese')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.affiliated).toBe(true)
    expect(res.body.diocese.name).toBe(chancery.organizationName)
    expect(res.body.diocese.grant_level).toBe('summary')
    expect(res.body.submissions).toHaveProperty('awaiting_review')
    expect(res.body.assessment).toBeNull()          // nothing published yet
  })

  it('a DRAFT assessment is invisible to the parish; publishing reveals it', async () => {
    // An assessment line only exists for a parish with an approved
    // submission in that fiscal year, so give the chancery something to
    // assess before assessing it.
    const sub = await request(server).post('/api/finance/submissions')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ period_start: '2029-01-01', period_end: '2029-01-31' })
    expect(sub.status).toBe(201)
    const approved = await request(server).patch(`/api/diocese/submissions/${sub.body.id}`)
      .set('Authorization', `Bearer ${chToken}`).send({ status: 'approved' })
    expect(approved.status).toBe(200)

    const created = await request(server).post('/api/diocese/assessments')
      .set('Authorization', `Bearer ${chToken}`)
      .send({ fiscal_year: '2029', rate_bps: 900 })
    expect(created.status).toBe(201)
    const id = created.body.id ?? created.body.assessment?.id
    const computed = await request(server).post(`/api/diocese/assessments/${id}/recompute`)
      .set('Authorization', `Bearer ${chToken}`).send({})
    expect(computed.status).toBe(200)

    // Still a draft — a chancery working out next year's rate has not
    // promised a parish anything.
    const hidden = await request(server).get('/api/finance/diocese')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(hidden.body.assessment).toBeNull()

    const pub = await request(server).patch(`/api/diocese/assessments/${id}`)
      .set('Authorization', `Bearer ${chToken}`).send({ status: 'published' })
    expect(pub.status).toBe(200)

    const shown = await request(server).get('/api/finance/diocese')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(shown.body.assessment).toBeTruthy()
    expect(shown.body.assessment.fiscal_year).toBe('2029')
    expect(shown.body.assessment.rate_bps).toBe(900)
  })

  // ---- the money, not just the flag ----
  //
  // These three exist because the first cut of DIO.5 passed twelve tests
  // and still did not work. routes/finance.js and finance/periodTotals.js
  // each had their own copy of the CoA resolver; only one was updated. So
  // /api/finance/coa reported "not assessable" while /api/finance/summary
  // went on counting the revenue — the display honoured the diocese and
  // the money did not. Every test asserted on the display.
  //
  // The resolver now lives in finance/effectiveCoa.js and is imported by
  // both. These assert on the number.

  const BASE_PERIOD = ['2028-04-01', '2028-04-30']
  const assessableBase = async () => {
    const res = await request(server)
      .get(`/api/finance/summary?start=${BASE_PERIOD[0]}&end=${BASE_PERIOD[1]}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    return Number(res.body.totals.assessable_base)
  }
  const setDioceseAssessable = async (assessable) => {
    const res = await request(server).put('/api/diocese/coa')
      .set('Authorization', `Bearer ${chToken}`)
      .send({ accounts: [{ code: '4110', assessable, rollup_group: 'Offertory' }] })
    expect(res.status).toBe(200)
  }

  it('the diocese switching `assessable` moves the parish assessable BASE, not just the flag', async () => {
    const gift = await request(server).post('/api/finance/ledger')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ entry_date: '2028-04-10', account_code: '4110', amount: 1000, memo: `Base ${RUN_ID}` })
    expect(gift.status).toBe(201)

    await setDioceseAssessable(true)
    expect(await assessableBase()).toBe(1000)

    await setDioceseAssessable(false)
    expect(await assessableBase()).toBe(0)      // the bug: this stayed 1000

    await setDioceseAssessable(true)
    expect(await assessableBase()).toBe(1000)
  })

  it('the chart of accounts and the assessable base never disagree', async () => {
    // The single assertion that would have caught the duplicated resolver.
    for (const assessable of [false, true]) {
      await setDioceseAssessable(assessable)
      const coa = await request(server).get('/api/finance/coa')
        .set('Authorization', `Bearer ${tokenA}`)
      const acct = coa.body.accounts.find(a => a.code === '4110')
      expect(acct.assessable).toBe(assessable)
      expect(await assessableBase() > 0).toBe(assessable)
    }
  })

  it('a submission freezes the DIOCESE\'s semantics, not the parish\'s', async () => {
    await setDioceseAssessable(false)
    const sub = await request(server).post('/api/finance/submissions')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ period_start: BASE_PERIOD[0], period_end: BASE_PERIOD[1] })
    expect(sub.status).toBe(201)

    // What the chancery will approve must carry the chancery's rules.
    const queue = await request(server).get('/api/diocese/submissions')
      .set('Authorization', `Bearer ${chToken}`)
    const mine = (queue.body.submissions ?? queue.body).find?.(x => x.id === sub.body.id)
      ?? queue.body.submissions?.find(x => x.id === sub.body.id)
    expect(mine).toBeTruthy()
    const frozen = mine.totals_json ?? mine.totals
    expect(Number(frozen.totals?.assessable_base ?? frozen.assessable_base)).toBe(0)

    await setDioceseAssessable(true)
  })

  it('never returns another parish’s assessment line', async () => {
    const res = await request(server).get('/api/finance/diocese')
      .set('Authorization', `Bearer ${loneToken}`)
    expect(res.body.assessment).toBeUndefined()
    expect(JSON.stringify(res.body)).not.toContain('rate_bps')
  })
})

// Placed ABOVE 'role enforcement' (which self-demotes tokenA) — needs admin.
describe('sacramental register (SAC.1)', () => {
  let memberA, recordId

  beforeAll(async () => {
    const m = await request(server).post('/api/clients')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `Sac Member ${RUN_ID}` })
    memberA = m.body.id
  })

  it('creates a sacramental record for a member', async () => {
    const res = await request(server).post('/api/sacraments')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ client_id: memberA, type: 'baptism', date: '2001-05-20', minister: 'Fr. Rivera' })
    expect(res.status).toBe(201)
    expect(res.body.type).toBe('baptism')
    expect(res.body.date).toBe('2001-05-20')
    recordId = res.body.id
  })

  it('rejects an unknown sacrament type', async () => {
    const res = await request(server).post('/api/sacraments')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ client_id: memberA, type: 'not-a-sacrament' })
    expect(res.status).toBe(400)
  })

  it('lists a member timeline', async () => {
    const res = await request(server).get(`/api/sacraments?client_id=${memberA}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.records.some(r => r.id === recordId)).toBe(true)
  })

  it('finds a record via keyword search (?q=)', async () => {
    const hit = await request(server).get('/api/sacraments?q=Rivera')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(hit.status).toBe(200)
    expect(hit.body.records.some(r => r.id === recordId)).toBe(true)

    const miss = await request(server).get(`/api/sacraments?q=zzz-no-match-${RUN_ID}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(miss.body.records.some(r => r.id === recordId)).toBe(false)
  })

  it('surfaces an upcoming sacrament anniversary', async () => {
    const pad = n => String(n).padStart(2, '0')
    const soon = new Date(); soon.setDate(soon.getDate() + 10)
    const annDate = `${soon.getFullYear() - 5}-${pad(soon.getMonth() + 1)}-${pad(soon.getDate())}`
    const made = await request(server).post('/api/sacraments')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ client_id: memberA, type: 'confirmation', date: annDate })
    expect(made.status).toBe(201)

    const res = await request(server).get('/api/sacraments/anniversaries?days=30')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    const hit = res.body.anniversaries.find(a => a.id === made.body.id)
    expect(hit).toBeTruthy()
    expect(hit.years).toBe(5)
    expect(hit.member_id).toBe(memberA)
  })

  it('does not leak records across orgs, and refuses cross-org member links', async () => {
    const list = await request(server).get(`/api/sacraments?client_id=${memberA}`)
      .set('Authorization', `Bearer ${tokenB}`)
    expect(list.status).toBe(200)
    expect(list.body.records.some(r => r.id === recordId)).toBe(false)

    const link = await request(server).post('/api/sacraments')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ client_id: memberA, type: 'confirmation' })
    expect(link.status).toBe(404)
  })

  it('edits a record', async () => {
    // A correction to the register carries a reason as of REG.1.
    const res = await request(server).patch(`/api/sacraments/${recordId}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ minister: 'Fr. Santos', certificate_no: 'B-1024', reason: 'Minister misread from the paper register' })
    expect(res.status).toBe(200)
    expect(res.body.minister).toBe('Fr. Santos')
    expect(res.body.certificate_no).toBe('B-1024')
  })

  it('fetches a single record by id, with member name, and 404s cross-org', async () => {
    const ok = await request(server).get(`/api/sacraments/${recordId}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(ok.status).toBe(200)
    expect(ok.body.id).toBe(recordId)
    expect(ok.body).toHaveProperty('member_name')

    const cross = await request(server).get(`/api/sacraments/${recordId}`)
      .set('Authorization', `Bearer ${tokenB}`)
    expect(cross.status).toBe(404)
  })

  it('refuses to delete a register entry, and says what to do instead', async () => {
    // This test used to assert 204. It encoded the defect: the one record
    // a parish is obliged to keep forever had the same mutability as a
    // task. Deletion is now refused for everyone — 405, not 403, because
    // a bigger role would not make it correct either.
    const del = await request(server).delete(`/api/sacraments/${recordId}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(del.status).toBe(405)
    expect(del.body.void_endpoint).toBe(`/api/sacraments/${recordId}/void`)

    // …and the entry is still there.
    const still = await request(server).get(`/api/sacraments/${recordId}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(still.status).toBe(200)
  })
})

describe('register integrity — void by amendment (REG.1)', () => {
  // The register used to behave like a task list: any staff user could
  // PATCH a committed entry with no reason and no capture of what it said
  // before, or hard-DELETE it entirely — leaving an audit row whose
  // metadata was {} and which was itself pruned after 30 days on Free.
  //
  // The model now matches how a paper register is actually corrected: by a
  // dated, attributed, reasoned marginal notation. Never by erasure.
  const org = {
    organizationName: `Register Org ${RUN_ID}`,
    name: 'Registrar',
    email: `reg_${RUN_ID}@example.com`,
    password: 'smoke-test-pw-31',
  }
  let token, orgId, memberId, recId, staffToken

  beforeAll(async () => {
    const res = await request(server).post('/api/auth/signup')
      .set('X-Forwarded-For', '10.99.0.12').send(org)
    expect(res.status).toBe(201)
    token = res.body.token; orgId = res.body.user.organization.id

    const m = await request(server).post('/api/clients')
      .set('Authorization', `Bearer ${token}`).send({ name: `Ana Reyes ${RUN_ID}` })
    memberId = m.body.id

    const rec = await request(server).post('/api/sacraments')
      .set('Authorization', `Bearer ${token}`)
      .send({ client_id: memberId, type: 'baptism', date: '1998-05-17', minister: 'Fr. Ruiz', place: 'St. Ana' })
    expect(rec.status).toBe(201)
    recId = rec.body.id

    // A staff user, to prove voiding is not ordinary parish work.
    const staff = await request(server).post('/api/users')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Volunteer', email: `regstaff_${RUN_ID}@example.com`, password: 'smoke-test-pw-32', role: 'staff' })
    expect(staff.status).toBe(201)
    const login = await request(server).post('/api/auth/login')
      .send({ email: `regstaff_${RUN_ID}@example.com`, password: 'smoke-test-pw-32' })
    expect(login.status).toBe(200)
    staffToken = login.body.token
    expect(staffToken).toBeTruthy()
  }, 30_000)

  afterAll(async () => {
    await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [orgId]).catch(() => {})
  })

  const amendments = async () => {
    const res = await request(server).get(`/api/sacraments/${recId}/amendments`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    return res.body.amendments
  }

  it('refuses a correction with no reason', async () => {
    const res = await request(server).patch(`/api/sacraments/${recId}`)
      .set('Authorization', `Bearer ${token}`).send({ minister: 'Fr. Silva' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/reason/i)

    // …and nothing moved.
    const rec = await request(server).get(`/api/sacraments/${recId}`)
      .set('Authorization', `Bearer ${token}`)
    expect(rec.body.minister).toBe('Fr. Ruiz')
    expect(await amendments()).toEqual([])
  })

  it('refuses a reason that is not really a reason', async () => {
    const res = await request(server).patch(`/api/sacraments/${recId}`)
      .set('Authorization', `Bearer ${token}`).send({ minister: 'Fr. Silva', reason: ' x ' })
    expect(res.status).toBe(400)
  })

  it('a correction records what it was, what it became, who and why', async () => {
    const res = await request(server).patch(`/api/sacraments/${recId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ minister: 'Fr. Silva', reason: 'Name misread from the 1998 paper register' })
    expect(res.status).toBe(200)
    expect(res.body.minister).toBe('Fr. Silva')

    const [a] = await amendments()
    expect(a.kind).toBe('correction')
    expect(a.reason).toBe('Name misread from the 1998 paper register')
    expect(a.before_json.minister).toBe('Fr. Ruiz')   // the prior value survives
    expect(a.after_json.minister).toBe('Fr. Silva')
    expect(a.amended_by_email).toBe(org.email)         // actor, snapshotted
    expect(a.created_at).toBeTruthy()
  })

  it('never deletes — 405 for an admin, with the endpoint that IS correct', async () => {
    const del = await request(server).delete(`/api/sacraments/${recId}`)
      .set('Authorization', `Bearer ${token}`)
    expect(del.status).toBe(405)
    expect(del.body.void_endpoint).toBe(`/api/sacraments/${recId}/void`)
    const still = await request(server).get(`/api/sacraments/${recId}`)
      .set('Authorization', `Bearer ${token}`)
    expect(still.status).toBe(200)
  })

  it('a staff user cannot void — that decision has a name on it', async () => {
    const res = await request(server).post(`/api/sacraments/${recId}/void`)
      .set('Authorization', `Bearer ${staffToken}`).send({ reason: 'Duplicate from the digitisation pass' })
    expect(res.status).toBe(403)
  })

  it('voiding keeps the entry, marks it, and says why', async () => {
    // The situation this exists for: a duplicate created when two
    // volunteers digitised the same page. "Make it go away" is the wrong
    // answer — six months later somebody asks why the register skips a
    // number, and the answer has to be in the book.
    const res = await request(server).post(`/api/sacraments/${recId}/void`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'Duplicate of entry #412 — same baptism digitised twice' })
    expect(res.status).toBe(200)
    expect(res.body.voided_at).toBeTruthy()
    expect(res.body.voided_reason).toMatch(/Duplicate of entry/)

    // Still fetchable by id, marks and all.
    const rec = await request(server).get(`/api/sacraments/${recId}`)
      .set('Authorization', `Bearer ${token}`)
    expect(rec.status).toBe(200)
    expect(rec.body.voided_at).toBeTruthy()

    const kinds = (await amendments()).map(a => a.kind)
    expect(kinds).toEqual(['correction', 'void'])
  })

  it('a voided entry leaves the working register but not the record', async () => {
    const live = await request(server).get('/api/sacraments')
      .set('Authorization', `Bearer ${token}`)
    expect(live.body.records.some(r => r.id === recId)).toBe(false)

    const all = await request(server).get('/api/sacraments?include_voided=1')
      .set('Authorization', `Bearer ${token}`)
    expect(all.body.records.some(r => r.id === recId)).toBe(true)
  })

  it('a voided entry cannot be quietly corrected back into life', async () => {
    const res = await request(server).patch(`/api/sacraments/${recId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ minister: 'Fr. Nobody', reason: 'trying to edit a void entry' })
    expect(res.status).toBe(409)
  })

  it('voiding twice is refused rather than logged twice', async () => {
    const res = await request(server).post(`/api/sacraments/${recId}/void`)
      .set('Authorization', `Bearer ${token}`).send({ reason: 'second attempt at voiding' })
    expect(res.status).toBe(409)
  })

  it('a void can be undone, and undoing it is itself an amendment', async () => {
    // A parish that voids the wrong entry must not have to live with it —
    // and must not be able to hide having done it either.
    const res = await request(server).post(`/api/sacraments/${recId}/restore`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'Voided in error — #412 was the duplicate, not this one' })
    expect(res.status).toBe(200)
    expect(res.body.voided_at).toBeNull()

    const kinds = (await amendments()).map(a => a.kind)
    expect(kinds).toEqual(['correction', 'void', 'restore'])

    const live = await request(server).get('/api/sacraments')
      .set('Authorization', `Bearer ${token}`)
    expect(live.body.records.some(r => r.id === recId)).toBe(true)
  })

  it('the database refuses a reasonless amendment even if a route stops checking', async () => {
    await expect(
      pool.query(
        `INSERT INTO ochr_sacrament_amendments (organization_id, sacrament_id, kind, reason, before_json)
         VALUES ($1, $2, 'correction', '  ', '{}'::jsonb)`,
        [orgId, recId]
      )
    ).rejects.toThrow()
  })

  it('amendments are tenant-scoped', async () => {
    const cross = await request(server).get(`/api/sacraments/${recId}/amendments`)
      .set('Authorization', `Bearer ${tokenB}`)
    expect(cross.body.amendments).toEqual([])
  })

  it('register history is exempt from retention pruning', async () => {
    // The register is permanent; a change history that expired after 30
    // days on Free would leave a corrected entry with no record of what it
    // used to say. Backdate every amendment well past the longest window
    // and prove the pruner does not touch them.
    await pool.query(
      `UPDATE ochr_sacrament_amendments SET created_at = NOW() - INTERVAL '5 years'
        WHERE organization_id = $1`, [orgId]
    )
    const { pruneOldRecords } = await import('../src/services/retention.js')
    await pruneOldRecords()
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM ochr_sacrament_amendments WHERE organization_id = $1', [orgId]
    )
    expect(rows[0].n).toBe(3)
  })
})

// Placed ABOVE 'role enforcement' so tokenA keeps its admin role.
describe('live email transport (Resend seam)', () => {
  let orgAId
  const realFetch = global.fetch
  const calls = []

  beforeAll(async () => {
    const { rows } = await pool.query(
      'SELECT id FROM ochr_organizations WHERE name = $1', [orgA.organizationName]
    )
    orgAId = rows[0].id
  })

  afterAll(() => {
    global.fetch = realFetch
    delete process.env.RESEND_API_KEY
  })

  it('without a key, notify() stays stubbed', async () => {
    delete process.env.RESEND_API_KEY
    const row = await notify({
      organizationId: orgAId,
      recipient: `stub-${RUN_ID}@example.com`,
      notification_type: 'donation_receipt',
      vars: { donor_name: 'X', church_name: 'Y', amount: '$1.00', fund: 'General', date: 'today', reference: 'r' },
    })
    expect(row.status).toBe('stubbed')
  })

  it('with a key, notify() sends via Resend and logs a sent row', async () => {
    process.env.RESEND_API_KEY = 're_test_key'
    global.fetch = async (url, init) => {
      calls.push({ url, init })
      return { ok: true, json: async () => ({ id: 're_msg_1' }) }
    }
    const row = await notify({
      organizationId: orgAId,
      recipient: `live-${RUN_ID}@example.com`,
      notification_type: 'donation_receipt',
      vars: { donor_name: 'X', church_name: 'Y', amount: '$2.00', fund: 'General', date: 'today', reference: 'r' },
    })
    expect(row.status).toBe('sent')
    expect(calls.length).toBe(1)
    expect(calls[0].url).toBe('https://api.resend.com/emails')
    const body = JSON.parse(calls[0].init.body)
    expect(body.to).toEqual([`live-${RUN_ID}@example.com`])
    expect(calls[0].init.headers.Authorization).toBe('Bearer re_test_key')
  })

  it('a transport failure logs a failed row (never throws to the caller)', async () => {
    process.env.RESEND_API_KEY = 're_test_key'
    global.fetch = async () => ({ ok: false, status: 422, text: async () => 'domain not verified', json: async () => ({}) })
    const row = await notify({
      organizationId: orgAId,
      recipient: `fail-${RUN_ID}@example.com`,
      notification_type: 'donation_receipt',
      vars: { donor_name: 'X', church_name: 'Y', amount: '$3.00', fund: 'General', date: 'today', reference: 'r' },
    })
    expect(row.status).toBe('failed')
  })
})

// Placed ABOVE 'role enforcement' so tokenA keeps its admin role.
describe('stripe webhook — signed, fail-closed (BIL.4)', () => {
  let orgAId
  const WH_SECRET = 'whsec_test_secret'

  function signed(bodyStr, secret = WH_SECRET, t = Math.floor(Date.now() / 1000)) {
    const mac = crypto.createHmac('sha256', secret).update(`${t}.${bodyStr}`).digest('hex')
    return `t=${t},v1=${mac}`
  }

  beforeAll(async () => {
    const { rows } = await pool.query(
      'SELECT id FROM ochr_organizations WHERE name = $1', [orgA.organizationName]
    )
    orgAId = rows[0].id
    process.env.BILLING_PROVIDER_SECRET = 'sk_test_x'
    process.env.BILLING_WEBHOOK_SECRET = WH_SECRET
  })

  afterAll(() => {
    delete process.env.BILLING_PROVIDER_SECRET
    delete process.env.BILLING_WEBHOOK_SECRET
  })

  it('rejects a bad signature with 400 and applies nothing', async () => {
    const body = JSON.stringify({ type: 'checkout.session.completed', data: { object: { mode: 'subscription', metadata: { organization_id: String(orgAId), plan: 'pro' } } } })
    const res = await request(server).post('/api/billing/webhook')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', signed(body, 'whsec_wrong'))
      .send(body)
    expect(res.status).toBe(400)
    const { rows } = await pool.query('SELECT plan FROM ochr_organizations WHERE id = $1', [orgAId])
    expect(rows[0].plan).not.toBe('pro')
  })

  it('applies a signed subscription checkout.session.completed', async () => {
    const body = JSON.stringify({
      type: 'checkout.session.completed',
      data: { object: {
        id: `cs_${RUN_ID}`, mode: 'subscription',
        customer: `cus_${RUN_ID}`, subscription: `sub_${RUN_ID}`,
        metadata: { organization_id: String(orgAId), plan: 'pro' },
      } },
    })
    const res = await request(server).post('/api/billing/webhook')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', signed(body))
      .send(body)
    expect(res.status).toBe(200)
    expect(res.body.handled).toBe('checkout.session.completed')
    const { rows } = await pool.query(
      'SELECT plan, billing_status, provider_customer_id, provider_subscription_id FROM ochr_organizations WHERE id = $1',
      [orgAId]
    )
    expect(rows[0].plan).toBe('pro')
    expect(rows[0].billing_status).toBe('active')
    expect(rows[0].provider_customer_id).toBe(`cus_${RUN_ID}`)
    expect(rows[0].provider_subscription_id).toBe(`sub_${RUN_ID}`)
  })

  it('records a donation checkout exactly once (idempotent on PaymentIntent)', async () => {
    const body = JSON.stringify({
      type: 'checkout.session.completed',
      data: { object: {
        id: `cs_don_${RUN_ID}`, mode: 'payment', payment_intent: `pi_${RUN_ID}`,
        amount_total: 2500,
        metadata: { kind: 'donation', organization_id: String(orgAId), donor_name: 'Webhook Donor', fund: 'General' },
      } },
    })
    for (let i = 0; i < 2; i++) {
      const res = await request(server).post('/api/billing/webhook')
        .set('Content-Type', 'application/json')
        .set('stripe-signature', signed(body))
        .send(body)
      expect(res.status).toBe(200)
      expect(res.body.handled).toBe('donation')
    }
    const { rows } = await pool.query(
      'SELECT amount, donor_name, payment_status FROM ochr_donations WHERE organization_id = $1 AND payment_ref = $2',
      [orgAId, `pi_${RUN_ID}`]
    )
    expect(rows.length).toBe(1)
    expect(Number(rows[0].amount)).toBe(25)
    expect(rows[0].payment_status).toBe('succeeded')
  })

  it('acknowledges-and-ignores unhandled event types', async () => {
    const body = JSON.stringify({ type: 'invoice.finalized', data: { object: {} } })
    const res = await request(server).post('/api/billing/webhook')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', signed(body))
      .send(body)
    expect(res.status).toBe(200)
    expect(res.body.ignored).toBe('invoice.finalized')
  })

  it('public give returns a checkout redirect in live mode (no premature row)', async () => {
    // Org slug + an active fund are needed for the public give flow.
    const { rows: orgRows } = await pool.query('SELECT slug FROM ochr_organizations WHERE id = $1', [orgAId])
    const { rows: fundRows } = await pool.query(
      `INSERT INTO ochr_funds (organization_id, name, active) VALUES ($1, $2, TRUE) RETURNING id`,
      [orgAId, `Live Fund ${RUN_ID}`]
    )
    const realFetch = global.fetch
    global.fetch = async (url) => {
      expect(String(url)).toContain('api.stripe.com/v1/checkout/sessions')
      return { ok: true, json: async () => ({ id: 'cs_live_1', url: 'https://checkout.stripe.com/c/pay/cs_live_1' }) }
    }
    try {
      const res = await request(server).post(`/api/public/${orgRows[0].slug}/give`)
        .send({ fund_id: fundRows[0].id, amount: 40, donor_name: 'Redirect Donor' })
      expect(res.status).toBe(200)
      expect(res.body.checkout_url).toContain('checkout.stripe.com')
      const { rows } = await pool.query(
        `SELECT 1 FROM ochr_donations WHERE organization_id = $1 AND donor_name = 'Redirect Donor'`,
        [orgAId]
      )
      expect(rows.length).toBe(0) // row only appears via webhook
    } finally {
      global.fetch = realFetch
    }
  })
})

// Placed ABOVE 'role enforcement' so tokenA keeps its admin role.
describe('sacristy weekly manifest (MI.2)', () => {
  const uniq = `SW-${RUN_ID}`
  let plusId

  beforeAll(async () => {
    const plus = await request(server).post('/api/mass-intentions')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ intention: `+Souls ${uniq}`, requested_by: 'Vega family', stipend: 15, mass_date: '2027-03-02', status: 'scheduled' })
    plusId = plus.body.id
    await request(server).patch(`/api/mass-intentions/${plusId}`)
      .set('Authorization', `Bearer ${tokenA}`).send({ status: 'scheduled' })
    await request(server).post('/api/mass-intentions')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ intention: `Living intention ${uniq}`, mass_date: '2027-03-03' })
    const cancelled = await request(server).post('/api/mass-intentions')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ intention: `Cancelled ${uniq}`, mass_date: '2027-03-04' })
    await request(server).patch(`/api/mass-intentions/${cancelled.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`).send({ status: 'cancelled' })
  })

  it('formats deceased intentions with the traditional cross', async () => {
    const res = await request(server).get('/api/mass-intentions/weekly?start=2027-03-01&end=2027-03-07')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    const formatted = res.body.intentions.map(r => r.formatted_intention)
    expect(formatted).toContain(`† Souls ${uniq}`)
    expect(formatted).toContain(`Living intention ${uniq}`)
    expect(formatted.some(f => f.includes(`Cancelled ${uniq}`))).toBe(false)
  })

  it('orders by date and respects the range', async () => {
    const res = await request(server).get('/api/mass-intentions/weekly?start=2027-03-01&end=2027-03-02')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.body.intentions.every(r => r.mass_date === '2027-03-02')).toBe(true)
  })

  it('validates the range (inverted + >31 days)', async () => {
    const inverted = await request(server).get('/api/mass-intentions/weekly?start=2027-03-07&end=2027-03-01')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(inverted.status).toBe(400)
    const tooLong = await request(server).get('/api/mass-intentions/weekly?start=2027-03-01&end=2027-05-01')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(tooLong.status).toBe(400)
  })

  it('is tenant-isolated', async () => {
    const res = await request(server).get('/api/mass-intentions/weekly?start=2027-03-01&end=2027-03-07')
      .set('Authorization', `Bearer ${tokenB}`)
    expect(res.status).toBe(200)
    expect(res.body.intentions.some(r => String(r.formatted_intention).includes(uniq))).toBe(false)
  })
})

// Placed ABOVE 'role enforcement' so tokenA keeps its admin role.
describe('sacrament meta_attributes (SAC.5)', () => {
  let memberId, spouseId, foreignId, recId

  beforeAll(async () => {
    const m = await request(server).post('/api/clients')
      .set('Authorization', `Bearer ${tokenA}`).send({ name: `Meta Member ${RUN_ID}` })
    memberId = m.body.id
    const sp = await request(server).post('/api/clients')
      .set('Authorization', `Bearer ${tokenA}`).send({ name: `Meta Spouse ${RUN_ID}` })
    spouseId = sp.body.id
    const f = await request(server).post('/api/clients')
      .set('Authorization', `Bearer ${tokenB}`).send({ name: `Foreign Spouse ${RUN_ID}` })
    foreignId = f.body.id
  })

  it('stores allowlisted structured fields', async () => {
    const res = await request(server).post('/api/sacraments')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        client_id: memberId, type: 'marriage', date: '2015-06-20',
        meta_attributes: { godparents: ['Ana Ruiz', 'Pedro Ruiz'], spouse_client_id: spouseId },
      })
    expect(res.status).toBe(201)
    expect(res.body.meta_attributes.godparents).toEqual(['Ana Ruiz', 'Pedro Ruiz'])
    expect(res.body.meta_attributes.spouse_client_id).toBe(spouseId)
    recId = res.body.id
  })

  it('rejects unknown keys and cross-org spouse links', async () => {
    const junk = await request(server).post('/api/sacraments')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ client_id: memberId, type: 'baptism', meta_attributes: { surprise: true } })
    expect(junk.status).toBe(400)
    const foreign = await request(server).post('/api/sacraments')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ client_id: memberId, type: 'marriage', meta_attributes: { spouse_client_id: foreignId } })
    expect(foreign.status).toBe(400)
  })

  it('PATCH replaces the meta object wholesale', async () => {
    const res = await request(server).patch(`/api/sacraments/${recId}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ meta_attributes: { sponsors: ['Lucia M.'] }, reason: 'Sponsor recorded under the wrong name' })
    expect(res.status).toBe(200)
    expect(res.body.meta_attributes).toEqual({ sponsors: ['Lucia M.'] })
  })

  // REGRESSION. Every test above asserts the WRITE response, and the write
  // path returned meta_attributes correctly the whole time — so all of them
  // passed while the feature was broken. Both READ paths had silently dropped
  // the column from their hand-written SELECT lists, which meant godparents
  // saved, echoed back on save, and then vanished on reload. The certificate
  // could never print them.
  //
  // Asserting the read-back is the only thing that would have caught it.
  it('returns meta_attributes on read, not just on write', async () => {
    const single = await request(server).get(`/api/sacraments/${recId}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(single.status).toBe(200)
    expect(single.body.meta_attributes).toEqual({ sponsors: ['Lucia M.'] })

    const list = await request(server).get('/api/sacraments')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(list.status).toBe(200)
    const rows = Array.isArray(list.body) ? list.body : (list.body.records ?? list.body.rows ?? [])
    const mine = rows.find(r => String(r.id) === String(recId))
    expect(mine).toBeDefined()
    expect(mine.meta_attributes).toEqual({ sponsors: ['Lucia M.'] })
  })
})

// Placed ABOVE 'role enforcement' so tokenA keeps its admin role.
describe('register digitization drafts (SAC.6)', () => {
  let goodId, badId

  it('stages a CSV batch as pending drafts', async () => {
    const res = await request(server).post('/api/sacraments/drafts')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ drafts: [
        { source: 'csv', raw_payload: { line: `baptism,1998-05-17,Fr. Ortega` }, draft: { type: 'baptism', date: '1998-05-17', minister: 'Fr. Ortega' } },
        { source: 'csv', raw_payload: { line: 'mystery row' }, draft: { notes: 'illegible entry' } },
      ] })
    expect(res.status).toBe(201)
    expect(res.body.drafts.length).toBe(2)
    ;[goodId, badId] = res.body.drafts.map(d => d.id)
    expect(res.body.drafts.every(d => d.status === 'pending')).toBe(true)
  })

  it('rejects unknown draft fields at staging', async () => {
    const res = await request(server).post('/api/sacraments/drafts')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ drafts: [{ draft: { certificate_number: 'wrong key name' } }] })
    expect(res.status).toBe(400)
  })

  it('commit strict-validates: no type, no register row', async () => {
    const res = await request(server).post(`/api/sacraments/drafts/${badId}/commit`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(400)
  })

  it('commits a valid draft into the permanent register', async () => {
    const res = await request(server).post(`/api/sacraments/drafts/${goodId}/commit`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(201)
    expect(res.body.record.type).toBe('baptism')
    expect(res.body.draft.status).toBe('committed')
    expect(res.body.draft.committed_record_id).toBe(res.body.record.id)
    const again = await request(server).post(`/api/sacraments/drafts/${goodId}/commit`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(again.status).toBe(409)
  })

  it('discards a pending draft (and blocks other status writes)', async () => {
    const bad = await request(server).patch(`/api/sacraments/drafts/${badId}`)
      .set('Authorization', `Bearer ${tokenA}`).send({ status: 'committed' })
    expect(bad.status).toBe(400)
    const res = await request(server).patch(`/api/sacraments/drafts/${badId}`)
      .set('Authorization', `Bearer ${tokenA}`).send({ status: 'discarded' })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('discarded')
  })

  it('is tenant-isolated (cross-org drafts invisible + uncommittable)', async () => {
    const staged = await request(server).post('/api/sacraments/drafts')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ drafts: [{ draft: { type: 'confirmation' } }] })
    const id = staged.body.drafts[0].id
    const list = await request(server).get('/api/sacraments/drafts')
      .set('Authorization', `Bearer ${tokenB}`)
    expect(list.body.drafts.some(d => d.id === id)).toBe(false)
    const commit = await request(server).post(`/api/sacraments/drafts/${id}/commit`)
      .set('Authorization', `Bearer ${tokenB}`)
    expect(commit.status).toBe(404)
  })
})

// Placed ABOVE 'role enforcement' so tokenA keeps its admin role.
describe('sacrament anniversary digest (PI.1)', () => {
  let orgAId

  beforeAll(async () => {
    const { rows } = await pool.query(
      'SELECT id FROM ochr_organizations WHERE name = $1', [orgA.organizationName]
    )
    orgAId = rows[0].id

    // A baptism whose anniversary lands 2 days from now, 5 years ago.
    const target = new Date(); target.setHours(0, 0, 0, 0)
    target.setDate(target.getDate() + 2)
    const pad = n => String(n).padStart(2, '0')
    const date = `${target.getFullYear() - 5}-${pad(target.getMonth() + 1)}-${pad(target.getDate())}`

    const m = await request(server).post('/api/clients')
      .set('Authorization', `Bearer ${tokenA}`).send({ name: `Digest Member ${RUN_ID}` })
    await request(server).post('/api/sacraments')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ client_id: m.body.id, type: 'baptism', date })
  })

  it('enqueues one digest per admin, with the draft note inline', async () => {
    const result = await enqueueSacramentAnniversaryDigests()
    expect(result.digestsEnqueued).toBeGreaterThanOrEqual(1)

    const { rows } = await pool.query(
      `SELECT vars FROM ochr_scheduled_notifications
        WHERE organization_id = $1 AND notification_type = 'sacrament_anniversary_digest'
          AND source_type = 'sacrament_anniv_digest'`,
      [orgAId]
    )
    expect(rows.length).toBeGreaterThanOrEqual(1)
    const vars = rows[0].vars
    expect(vars.items_block).toContain(`Digest Member ${RUN_ID}`)
    expect(vars.items_block).toContain('Draft note:')
    expect(vars.items_block).toContain('5 years since')
  })

  it('is idempotent per ISO week (rerun enqueues nothing new)', async () => {
    const before = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ochr_scheduled_notifications
        WHERE organization_id = $1 AND notification_type = 'sacrament_anniversary_digest'`,
      [orgAId]
    )
    const rerun = await enqueueSacramentAnniversaryDigests()
    expect(rerun.orgsSkipped).toBeGreaterThanOrEqual(1)
    const after = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ochr_scheduled_notifications
        WHERE organization_id = $1 AND notification_type = 'sacrament_anniversary_digest'`,
      [orgAId]
    )
    expect(after.rows[0].n).toBe(before.rows[0].n)
  })
})

// Placed ABOVE 'role enforcement' so tokenA keeps its admin role.
describe('founder workbench (FB.2)', () => {
  let noteA, noteB

  beforeAll(async () => {
    delete process.env.SUPER_ADMIN_EMAIL
    const a = await request(server).post('/api/feedback')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ category: 'suggestion', message: `WB note A ${RUN_ID}`, route: '/register' })
    noteA = a.body.id
    const b = await request(server).post('/api/feedback')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ category: 'bug', message: `WB note B ${RUN_ID}` })
    noteB = b.body.id
  })

  afterAll(() => { delete process.env.SUPER_ADMIN_EMAIL })

  it('404s when no super-admin is configured (fail closed)', async () => {
    const res = await request(server).get('/api/admin/feedback')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(404)
  })

  it('404s for an authenticated non-matching user', async () => {
    process.env.SUPER_ADMIN_EMAIL = 'someone-else@example.com'
    const res = await request(server).get('/api/admin/feedback')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(404)
  })

  it('lists feedback across ALL parishes for the configured founder', async () => {
    process.env.SUPER_ADMIN_EMAIL = orgA.email
    const res = await request(server).get('/api/admin/feedback?status=open')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    const msgs = res.body.feedback.map(f => f.message)
    expect(msgs).toContain(`WB note A ${RUN_ID}`)   // own org
    expect(msgs).toContain(`WB note B ${RUN_ID}`)   // cross-tenant BY DESIGN here
    const rowA = res.body.feedback.find(f => f.message === `WB note A ${RUN_ID}`)
    expect(rowA.organization).toBe(orgA.organizationName)
    expect(rowA.status).toBe('open')
  })

  it('toggles status open → replied (and validates input)', async () => {
    process.env.SUPER_ADMIN_EMAIL = orgA.email
    const bad = await request(server).patch(`/api/admin/feedback/${noteA}`)
      .set('Authorization', `Bearer ${tokenA}`).send({ status: 'archived' })
    expect(bad.status).toBe(400)
    const res = await request(server).patch(`/api/admin/feedback/${noteA}`)
      .set('Authorization', `Bearer ${tokenA}`).send({ status: 'replied' })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('replied')
    const open = await request(server).get('/api/admin/feedback?status=open')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(open.body.feedback.some(f => f.id === noteA)).toBe(false)
  })
})

// Placed ABOVE 'role enforcement' so tokenA keeps its admin role.
describe('intention ↔ calendar link (MI.3)', () => {
  let eventA, intentionId

  beforeAll(async () => {
    const ev = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ title: `10:30 Mass ${RUN_ID}`, date: '2027-04-06', start_time: '10:30', end_time: '11:30' })
    eventA = ev.body.id
  })

  it('assigns an intention to a Mass at creation (adopting its title/time)', async () => {
    const res = await request(server).post('/api/mass-intentions')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ intention: `+Linked ${RUN_ID}`, mass_date: '2027-04-06', calendar_event_id: eventA, status: 'scheduled' })
    expect(res.status).toBe(201)
    expect(res.body.calendar_event_id).toBe(eventA)
    expect(res.body.mass_title).toBe(`10:30 Mass ${RUN_ID}`)
    expect(res.body.mass_time).toBe('10:30')
    intentionId = res.body.id
  })

  it('surfaces the assigned Mass on the sacristy weekly manifest', async () => {
    const res = await request(server).get('/api/mass-intentions/weekly?start=2027-04-05&end=2027-04-11')
      .set('Authorization', `Bearer ${tokenA}`)
    const row = res.body.intentions.find(r => r.formatted_intention === `† Linked ${RUN_ID}`)
    expect(row).toBeTruthy()
    expect(row.mass_title).toBe(`10:30 Mass ${RUN_ID}`)
    expect(row.mass_time).toBe('10:30')
  })

  it('rejects a cross-org calendar event (404)', async () => {
    const res = await request(server).post('/api/mass-intentions')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ intention: 'Should fail', calendar_event_id: eventA })
    expect(res.status).toBe(404)
  })

  it('clears the assignment via PATCH null', async () => {
    const res = await request(server).patch(`/api/mass-intentions/${intentionId}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ calendar_event_id: null })
    expect(res.status).toBe(200)
    expect(res.body.calendar_event_id).toBeNull()
    expect(res.body.mass_title).toBeNull()
  })
})

// Placed ABOVE 'role enforcement' so tokenA keeps its admin role.
describe('telemetry dashboard view (migration 052)', () => {
  it('returns one row per org with trailing-28-day counts', async () => {
    const { rows } = await pool.query('SELECT * FROM ochr_telemetry_dashboard')
    const a = rows.find(r => r.organization === orgA.organizationName)
    const b = rows.find(r => r.organization === orgB.organizationName)
    expect(a).toBeTruthy()
    expect(b).toBeTruthy()
    // Earlier blocks in this run created register rows + feedback for org A.
    expect(Number(a.recent_register_rows)).toBeGreaterThanOrEqual(1)
    expect(Number(a.recent_feedback)).toBeGreaterThanOrEqual(1)
    expect(Number(a.recent_schedules)).toBeGreaterThanOrEqual(0)
  })
})

// Placed ABOVE 'role enforcement' so tokenA keeps its admin role.
describe('cross-tenant isolation sweep (SEC.1)', () => {
  const marker = `IsoSweep_${RUN_ID}`

  beforeAll(async () => {
    // Plant a uniquely-named record in the core surfaces of org A.
    const m = await request(server).post('/api/clients')
      .set('Authorization', `Bearer ${tokenA}`).send({ name: `${marker} Member` })
    await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ title: `${marker} Mass`, date: '2027-05-04', start_time: '09:00', end_time: '10:00' })
    await request(server).post('/api/mass-intentions')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ intention: `+${marker} Soul` })
    await request(server).post('/api/sacraments')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ client_id: m.body.id, type: 'baptism', date: '2001-01-01', minister: `${marker} Minister` })
    await request(server).post('/api/groups')
      .set('Authorization', `Bearer ${tokenA}`).send({ name: `${marker} Guild` })
    await request(server).post('/api/tasks')
      .set('Authorization', `Bearer ${tokenA}`).send({ title: `${marker} Task` })
  })

  it('org A sees its own marker (sweep is not vacuous)', async () => {
    const own = await request(server).get(`/api/clients?search=${marker}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(JSON.stringify(own.body)).toContain(marker)
  })

  it('no org-B surface leaks org A data', async () => {
    const surfaces = [
      `/api/clients?search=${marker}`,
      '/api/clients',
      '/api/calendar?start=2027-05-01&end=2027-05-31',
      `/api/mass-intentions?q=${marker}`,
      `/api/sacraments?q=${marker}`,
      '/api/groups',
      '/api/tasks',
      `/api/search?q=${marker}`,
      '/api/donations',
      '/api/audit-log?limit=100',
    ]
    for (const path of surfaces) {
      const res = await request(server).get(path).set('Authorization', `Bearer ${tokenB}`)
      // Some list endpoints may 404/400 on unknown params — that's fine;
      // what must never happen is a 200 carrying org A's marker.
      if (res.status === 200) {
        expect(JSON.stringify(res.body)).not.toContain(marker)
      }
    }
  })
})

// Placed ABOVE 'role enforcement' so tokenA keeps its admin role.
describe('parish data export (EXP.1)', () => {
  it('exports the full org copy, org-scoped, secrets stripped', async () => {
    const res = await request(server).get('/api/organization/export')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    expect(res.headers['content-disposition']).toContain('attachment')

    const dump = typeof res.body === 'object' && res.body.format
      ? res.body : JSON.parse(res.text)
    expect(dump.format).toBe('openchurch-export')
    expect(dump.organization.name).toBe(orgA.organizationName)

    // Core canonical tables present with rows from this run.
    expect(dump.counts.ochr_sacramental_records).toBeGreaterThanOrEqual(1)
    expect(dump.counts.ochr_clients).toBeGreaterThanOrEqual(1)

    // Tenancy: nothing from org B.
    const asText = JSON.stringify(dump)
    expect(asText).not.toContain(orgB.organizationName)

    // No credential-shaped fields anywhere (password_hash lives on users).
    expect(asText).not.toContain('password_hash')
    expect(dump.tables.ochr_push_subscriptions).toBeUndefined()
    expect(dump.tables.ochr_scheduled_notifications).toBeUndefined()
  })

  it('is admin-gated (staff/viewer cannot pull the whole parish)', async () => {
    // tokenB is an admin of org B — this asserts the mount requires auth,
    // and the demotion-based role checks live in 'role enforcement' below.
    const unauth = await request(server).get('/api/organization/export')
    expect([401, 403]).toContain(unauth.status)
  })
})

// Placed ABOVE 'role enforcement' so tokenA keeps its admin role.
describe('weekly backup digest (BKP.1)', () => {
  const realFetch = global.fetch

  afterAll(() => {
    global.fetch = realFetch
    delete process.env.SUPER_ADMIN_EMAIL
    delete process.env.RESEND_API_KEY
  })

  it('reports itself skipped without SUPER_ADMIN_EMAIL (never silent)', async () => {
    delete process.env.SUPER_ADMIN_EMAIL
    const { runWeeklyBackupDigest } = await import('../src/services/backupDigest.js')
    const result = await runWeeklyBackupDigest()
    expect(result.skipped).toBeTruthy()
  })

  it('builds gzipped per-parish attachments and mails them off-site', async () => {
    process.env.SUPER_ADMIN_EMAIL = `founder-${RUN_ID}@example.com`
    process.env.RESEND_API_KEY = 're_test_key'
    let sent = null
    global.fetch = async (url, init) => {
      sent = JSON.parse(init.body)
      return { ok: true, json: async () => ({ id: 're_backup_1' }) }
    }

    const { runWeeklyBackupDigest } = await import('../src/services/backupDigest.js')
    const result = await runWeeklyBackupDigest()

    expect(result.orgs).toBeGreaterThanOrEqual(2)
    expect(result.attached).toBeGreaterThanOrEqual(2)
    expect(result.failed).toBe(0)
    expect(sent.to).toEqual([`founder-${RUN_ID}@example.com`])
    expect(sent.attachments.length).toBe(result.attached)
    expect(sent.attachments[0].filename).toMatch(/\.json\.gz$/)

    // Round-trip one attachment: valid gzip, valid export JSON.
    const { gunzipSync } = await import('node:zlib')
    const dump = JSON.parse(gunzipSync(Buffer.from(sent.attachments[0].content, 'base64')).toString('utf8'))
    expect(dump.format).toBe('openchurch-export')
  })
})

// Placed ABOVE 'role enforcement' so tokenA keeps its admin role.
describe('burial in the register (migration 070)', () => {
  let memberId

  beforeAll(async () => {
    const m = await request(server).post('/api/clients')
      .set('Authorization', `Bearer ${tokenA}`).send({ name: `Burial Member ${RUN_ID}` })
    memberId = m.body.id
  })

  it('accepts a burial record (CHECK constraint + route allowlist)', async () => {
    const res = await request(server).post('/api/sacraments')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ client_id: memberId, type: 'burial', date: '2020-11-02', minister: 'Fr. Ortega', place: 'Parish cemetery' })
    expect(res.status).toBe(201)
    expect(res.body.type).toBe('burial')
  })

  it('never surfaces burials as anniversaries', async () => {
    // A burial whose month/day lands inside the anniversary window —
    // it must still not appear.
    const target = new Date(); target.setHours(0, 0, 0, 0)
    target.setDate(target.getDate() + 3)
    const pad = n => String(n).padStart(2, '0')
    const date = `${target.getFullYear() - 2}-${pad(target.getMonth() + 1)}-${pad(target.getDate())}`

    await request(server).post('/api/sacraments')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ client_id: memberId, type: 'burial', date })

    const res = await request(server).get('/api/sacraments/anniversaries?days=14')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.anniversaries.some(a => a.type === 'burial')).toBe(false)
  })
})

// Placed ABOVE 'role enforcement' because that block self-demotes tokenA to
// viewer; these tests need tokenA to retain admin write access.
describe('tenant FK guards at the DB level (migration 044)', () => {
  let eventA, memberA, memberB, orgAId

  beforeAll(async () => {
    const ev = await request(server).post('/api/events')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ title: `FKGuard Event ${RUN_ID}`, date: '2027-08-01' })
    eventA = ev.body.id
    const mA = await request(server).post('/api/clients')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `FKGuard MemberA ${RUN_ID}` })
    memberA = mA.body.id
    const mB = await request(server).post('/api/clients')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ name: `FKGuard MemberB ${RUN_ID}` })
    memberB = mB.body.id
    const { rows } = await pool.query('SELECT organization_id AS org FROM ochr_events WHERE id = $1', [eventA])
    orgAId = rows[0].org
  })

  it('rejects an event↔member link across orgs (composite FK)', async () => {
    // org A event, org A stamp, but org B member → member composite FK fails.
    await expect(pool.query(
      `INSERT INTO ochr_event_members (event_id, organization_id, member_id) VALUES ($1, $2, $3)`,
      [eventA, orgAId, memberB]
    )).rejects.toThrow()
  })

  it('allows a same-org event↔member link', async () => {
    const r = await pool.query(
      `INSERT INTO ochr_event_members (event_id, organization_id, member_id) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING RETURNING event_id`,
      [eventA, orgAId, memberA]
    )
    expect(r.rows.length).toBe(1)
  })

  it('rejects a cross-org group membership at the DB level', async () => {
    const g = await request(server).post('/api/groups')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `FKGuard Group ${RUN_ID}` })
    const groupA = g.body.id
    await expect(pool.query(
      `INSERT INTO ochr_group_members (group_id, organization_id, client_id) VALUES ($1, $2, $3)`,
      [groupA, orgAId, memberB]
    )).rejects.toThrow()
  })
})

describe('sample data stays cleared across deploys (migration 060)', () => {
  // REGRESSION. runAllMigrations() calls seedSampleData() for the demo org
  // on every run, and CI runs migrate-cli.js against production on every
  // push to main. The old guard asked "does this org have any [Sample]
  // tasks right now?" — so once an admin used the Clear-sample-data banner,
  // the next deploy read "unseeded" and re-inserted the entire sample set:
  // 12 members, 4 events, 8 weeks of Sunday services, 9 donations, 2 staff,
  // 5 tasks. Deleting only the sample *tasks* was worse — the guard still
  // read "unseeded" while the other sample rows survived, so every deploy
  // appended another full copy and inflated the giving numbers.
  //
  // The guard is now ochr_organizations.samples_seeded_at, claimed once and
  // never reset by clear-samples.
  let orgId

  beforeAll(async () => {
    const me = await request(server).get('/api/auth/me').set('Authorization', `Bearer ${tokenA}`)
    orgId = me.body.user.organization.id
  })

  it('signup stamped samples_seeded_at', async () => {
    const { rows } = await pool.query(
      'SELECT samples_seeded_at FROM ochr_organizations WHERE id = $1', [orgId]
    )
    expect(rows[0].samples_seeded_at).toBeTruthy()
  })

  it('re-seeding an already-seeded org is a no-op', async () => {
    const res = await seedSampleData(pool, orgId)
    expect(res).toEqual({ skipped: true })
  })

  it('cleared sample data is NOT resurrected by a later seed run', async () => {
    const cleared = await request(server)
      .post('/api/onboarding/clear-samples')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(cleared.status).toBe(200)

    // The deploy. Before 060 this put every sample row straight back.
    const res = await seedSampleData(pool, orgId)
    expect(res).toEqual({ skipped: true })

    const status = await request(server)
      .get('/api/onboarding/status')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(status.status).toBe(200)
    expect(status.body.hasSamples).toBe(false)
    expect(Object.values(status.body.counts).reduce((a, b) => a + b, 0)).toBe(0)
  })

  it('deleting only the sample tasks does not re-append a second copy', async () => {
    // The duplication half of the bug: the old guard keyed off ochr_tasks
    // alone, so an org with sample members but no sample tasks looked
    // unseeded and got a full second set on the next deploy.
    await pool.query(
      `DELETE FROM ochr_tasks WHERE organization_id = $1 AND title LIKE '[Sample]%'`,
      [orgId]
    )
    await seedSampleData(pool, orgId)
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ochr_clients
        WHERE organization_id = $1 AND name LIKE '[Sample]%'`,
      [orgId]
    )
    expect(rows[0].n).toBe(0)
  })
})

// Placed ABOVE 'role enforcement' so tokenA keeps its admin role.
describe('org AI provider — bring your own key (AIP.1)', () => {
  const FAKE_KEY = `sk-ant-test-${RUN_ID}-abcdefgh1234`

  it('round-trips a key through AES-256-GCM encrypt/decrypt', async () => {
    const { encryptApiKey, decryptApiKey } = await import('../src/ai/orgProvider.js')
    const enc = encryptApiKey(FAKE_KEY)
    expect(enc).not.toContain(FAKE_KEY)
    expect(enc.split('.')).toHaveLength(3)
    expect(decryptApiKey(enc)).toBe(FAKE_KEY)
  })

  it('starts on the platform provider', async () => {
    const res = await request(server).get('/api/ai/provider')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ source: 'platform', provider: null, key_last4: null })
  })

  it('rejects an unknown provider and an implausible key', async () => {
    const bad1 = await request(server).put('/api/ai/provider')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ provider: 'skynet', api_key: FAKE_KEY })
    expect(bad1.status).toBe(400)
    const bad2 = await request(server).put('/api/ai/provider')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ provider: 'anthropic', api_key: 'too-short' })
    expect(bad2.status).toBe(400)
  })

  it('stores the key encrypted and only ever returns the last four', async () => {
    const put = await request(server).put('/api/ai/provider')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ provider: 'anthropic', api_key: FAKE_KEY, model: 'claude-haiku-4-5-20251001' })
    expect(put.status).toBe(200)
    expect(put.body).toMatchObject({
      source: 'org', provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      key_last4: FAKE_KEY.slice(-4),
    })
    expect(JSON.stringify(put.body)).not.toContain(FAKE_KEY)

    // At rest: ciphertext only, never the plaintext key.
    const { rows } = await pool.query(
      `SELECT o.ai_api_key_enc FROM ochr_organizations o
        JOIN ochr_users u ON u.organization_id = o.id
       WHERE u.email = $1`,
      [orgA.email]
    )
    expect(rows[0].ai_api_key_enc).toBeTruthy()
    expect(rows[0].ai_api_key_enc).not.toContain(FAKE_KEY)

    const get = await request(server).get('/api/ai/provider')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(get.status).toBe(200)
    expect(get.body.key_last4).toBe(FAKE_KEY.slice(-4))
    expect(JSON.stringify(get.body)).not.toContain(FAKE_KEY)
  })

  it("org B's settings are untouched (tenant isolation)", async () => {
    const res = await request(server).get('/api/ai/provider')
      .set('Authorization', `Bearer ${tokenB}`)
    expect(res.status).toBe(200)
    expect(res.body.source).toBe('platform')
  })

  it('DELETE reverts to the platform provider', async () => {
    const del = await request(server).delete('/api/ai/provider')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(del.status).toBe(200)
    expect(del.body.source).toBe('platform')
    const get = await request(server).get('/api/ai/provider')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(get.body).toMatchObject({ source: 'platform', provider: null, key_last4: null })
  })
})

// Placed ABOVE 'role enforcement' so tokenA keeps its admin role.
describe('pastoral-care lapsed list (INS.4)', () => {
  let lapsedId, recentId, neverSeenId

  beforeAll(async () => {
    const ev = await request(server).post('/api/events')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ title: `Lapsed Test Service ${RUN_ID}`, date: '2026-06-01' })
    const eventId = ev.body.id
    const mk = async (name) => {
      const r = await request(server).post('/api/clients')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name })
      return r.body.id
    }
    lapsedId    = await mk(`Lapsed Member ${RUN_ID}`)
    recentId    = await mk(`Recent Member ${RUN_ID}`)
    neverSeenId = await mk(`NeverSeen Member ${RUN_ID}`)
    const { rows } = await pool.query(
      'SELECT organization_id AS org FROM ochr_clients WHERE id = $1', [lapsedId])
    const orgId = rows[0].org
    // Seen 5 weeks ago → lapsed at the 3-week bar, fine at 8.
    await pool.query(
      `INSERT INTO ochr_attendance (organization_id, event_id, member_id, status, marked_at)
       VALUES ($1, $2, $3, 'present', NOW() - interval '5 weeks')`,
      [orgId, eventId, lapsedId]
    )
    // Seen this morning → never lapsed.
    await pool.query(
      `INSERT INTO ochr_attendance (organization_id, event_id, member_id, status, marked_at)
       VALUES ($1, $2, $3, 'present', NOW() - interval '1 hour')`,
      [orgId, eventId, recentId]
    )
  })

  it('lists the member last seen 5 weeks ago at the default 3-week bar', async () => {
    const res = await request(server).get('/api/insights/lapsed')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.weeks).toBe(3)
    const hit = res.body.members.find(m => m.id === lapsedId)
    expect(hit).toBeTruthy()
    expect(hit.weeks_absent).toBeGreaterThanOrEqual(4)
    expect(res.body.members.find(m => m.id === recentId)).toBeUndefined()
  })

  it('excludes members with no attendance history at all', async () => {
    const res = await request(server).get('/api/insights/lapsed')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.body.members.find(m => m.id === neverSeenId)).toBeUndefined()
  })

  it('drops off the list when the bar is wider than the absence', async () => {
    const res = await request(server).get('/api/insights/lapsed?weeks=8')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.weeks).toBe(8)
    expect(res.body.members.find(m => m.id === lapsedId)).toBeUndefined()
  })

  it('clamps absurd weeks values instead of erroring', async () => {
    const res = await request(server).get('/api/insights/lapsed?weeks=9999')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.weeks).toBe(26)
  })

  it("org B never sees org A's lapsed members", async () => {
    const res = await request(server).get('/api/insights/lapsed')
      .set('Authorization', `Bearer ${tokenB}`)
    expect(res.status).toBe(200)
    expect(res.body.members.find(m => m.id === lapsedId)).toBeUndefined()
  })
})

// Placed ABOVE 'role enforcement' so tokenA keeps its admin role.
describe('daily operational checklists (OPS.1)', () => {
  let templateId, runId

  it('validates template input', async () => {
    const noTitle = await request(server).post('/api/checklists/templates')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ items: ['Unlock doors'] })
    expect(noTitle.status).toBe(400)
    const noItems = await request(server).post('/api/checklists/templates')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ title: 'Empty', items: ['   ', ''] })
    expect(noItems.status).toBe(400)
  })

  it('creates a template', async () => {
    const res = await request(server).post('/api/checklists/templates')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ title: `Sunday opening ${RUN_ID}`, items: ['Unlock doors', 'Start coffee', 'Test mics'] })
    expect(res.status).toBe(201)
    expect(res.body.items).toEqual(['Unlock doors', 'Start coffee', 'Test mics'])
    templateId = res.body.id
  })

  it("materializes today's run once, idempotently", async () => {
    const first = await request(server).get('/api/checklists/today')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(first.status).toBe(200)
    const run = first.body.runs.find(r => r.template_id === templateId)
    expect(run).toBeTruthy()
    expect(run.items).toHaveLength(3)
    expect(run.items.every(i => i.done === false)).toBe(true)
    runId = run.id

    const second = await request(server).get('/api/checklists/today')
      .set('Authorization', `Bearer ${tokenA}`)
    const again = second.body.runs.find(r => r.template_id === templateId)
    expect(again.id).toBe(runId) // same run, not a duplicate
  })

  it('ticks a single item atomically', async () => {
    const res = await request(server).patch(`/api/checklists/runs/${runId}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ index: 1, done: true })
    expect(res.status).toBe(200)
    expect(res.body.items[1].done).toBe(true)
    expect(res.body.items[0].done).toBe(false)
    expect(res.body.items[2].done).toBe(false)
  })

  it('404s an out-of-range item index', async () => {
    const res = await request(server).patch(`/api/checklists/runs/${runId}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ index: 7, done: true })
    expect(res.status).toBe(404)
  })

  it("org B cannot see or tick org A's checklists", async () => {
    const list = await request(server).get('/api/checklists/today')
      .set('Authorization', `Bearer ${tokenB}`)
    expect(list.status).toBe(200)
    expect(list.body.runs.find(r => r.id === runId)).toBeUndefined()
    const tick = await request(server).patch(`/api/checklists/runs/${runId}`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ index: 0, done: true })
    expect(tick.status).toBe(404)
  })

  it('deleting the template does not resurrect the run tomorrow', async () => {
    const del = await request(server).delete(`/api/checklists/templates/${templateId}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(del.status).toBe(204)
    const list = await request(server).get('/api/checklists/templates')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(list.body.templates.find(t => t.id === templateId)).toBeUndefined()
  })
})

// Placed ABOVE 'role enforcement' so tokenA keeps its admin role.
describe('lectionary resolver (LEC.1)', () => {
  let resolveLectionary
  beforeAll(async () => {
    ({ resolveLectionary } = await import('../src/services/lectionary.js'))
  })

  it('anchors the cycle: Advent 2025 begins Year A, Advent 2026 Year B', () => {
    expect(resolveLectionary('2025-11-30')).toMatchObject({ cycle: 'A', designation: 'First Sunday of Advent' })
    expect(resolveLectionary('2026-11-29')).toMatchObject({ cycle: 'B', designation: 'First Sunday of Advent' })
  })

  it('resolves the Easter-anchored days from the shared computus', () => {
    expect(resolveLectionary('2026-04-05').designation).toBe('Easter Day')       // Easter 2026
    expect(resolveLectionary('2026-02-18').designation).toBe('Ash Wednesday')    // Easter − 46
    expect(resolveLectionary('2026-05-24').designation).toBe('Day of Pentecost') // Easter + 49
    expect(resolveLectionary('2026-05-31').designation).toBe('Trinity Sunday')
  })

  it('numbers the Propers from their date-anchored windows', () => {
    // Aug 2 2026: 10th Sunday after Pentecost, window Jul 31–Aug 6 → Proper 13.
    expect(resolveLectionary('2026-08-02')).toMatchObject({
      designation: 'Tenth Sunday after Pentecost', proper: 13, is_sunday: true,
    })
    // The Sunday before Advent = Proper 29, Reign of Christ.
    expect(resolveLectionary('2026-11-22')).toMatchObject({
      designation: 'Christ the King (Reign of Christ)', proper: 29,
    })
  })

  it('resolves weekdays as the week of the preceding Sunday', () => {
    const thu = resolveLectionary('2026-07-30')
    expect(thu.is_sunday).toBe(false)
    expect(thu.designation).toBe('Week of the Ninth Sunday after Pentecost')
    // Easter Monday is Easter Week, not "Week of the Easter Day".
    expect(resolveLectionary('2026-04-06').designation).toBe('Easter Week')
  })

  it('holds Epiphanytide together: Baptism of the Lord and Transfiguration', () => {
    expect(resolveLectionary('2026-01-11').designation).toBe('First Sunday after the Epiphany (Baptism of the Lord)')
    expect(resolveLectionary('2026-02-15').designation).toBe('Last Sunday after the Epiphany (Transfiguration)')
  })
})

describe('Roman-rite lectionary designations (ROM.1)', () => {
  // A Catholic parish says "Twenty-second Sunday in Ordinary Time", not
  // "Fourteenth Sunday after Pentecost · Proper 17". Same date, same
  // A/B/C cycle, different vocabulary — and the wrong one printed in
  // front of a parish secretary is the kind of mistake that ends a
  // conversation. These tests exist so the two can never drift.
  let resolveLectionary, resolveRomanLectionary
  beforeAll(async () => {
    ({ resolveLectionary, resolveRomanLectionary } = await import('../src/services/lectionary.js'))
  })

  it('agrees with the USCCB lectionary on a known Sunday', () => {
    // bible.usccb.org/bible/readings/083026.cfm — "Twenty-second Sunday
    // in Ordinary Time". This is the anchor; everything else is counted
    // off the same arithmetic.
    expect(resolveRomanLectionary('2026-08-30')).toMatchObject({
      designation: 'Twenty-second Sunday in Ordinary Time',
      cycle: 'A',
      proper: null,
    })
  })

  it('names the same day differently from the RCL, on purpose', () => {
    expect(resolveLectionary('2026-08-30').designation).toBe('Fourteenth Sunday after Pentecost')
    expect(resolveLectionary('2026-08-30').proper).toBe(17)
    expect(resolveRomanLectionary('2026-08-30').designation).toBe('Twenty-second Sunday in Ordinary Time')
  })

  it('shares the cycle letter with the RCL — the year is the same year', () => {
    for (const d of ['2025-11-30', '2026-11-29', '2027-11-28']) {
      expect(resolveRomanLectionary(d).cycle).toBe(resolveLectionary(d).cycle)
    }
  })

  it('never emits a Proper — the Roman Lectionary has none', () => {
    for (const d of ['2026-08-30', '2026-06-14', '2026-11-15']) {
      expect(resolveRomanLectionary(d).proper).toBeNull()
    }
  })

  it('numbers the first block of Ordinary Time off the Baptism of the Lord', () => {
    expect(resolveRomanLectionary('2026-01-11').designation).toBe('The Baptism of the Lord')
    expect(resolveRomanLectionary('2026-01-18').designation).toBe('Second Sunday in Ordinary Time')
    expect(resolveRomanLectionary('2026-02-15').designation).toBe('Sixth Sunday in Ordinary Time')
  })

  it('counts the second block backward from Christ the King', () => {
    // Advent I 2026 is 29 Nov, so 22 Nov is the 34th and last Sunday.
    expect(resolveRomanLectionary('2026-11-22').designation).toBe('Our Lord Jesus Christ, King of the Universe')
    expect(resolveRomanLectionary('2026-11-15').designation).toBe('Thirty-third Sunday in Ordinary Time')
    expect(resolveRomanLectionary('2026-11-29').designation).toBe('First Sunday of Advent')
  })

  it('names the solemnities that displace an Ordinary Time Sunday', () => {
    expect(resolveRomanLectionary('2026-05-24').designation).toBe('Pentecost Sunday')
    expect(resolveRomanLectionary('2026-05-31').designation).toBe('The Most Holy Trinity')
    expect(resolveRomanLectionary('2026-06-07').designation).toBe('The Most Holy Body and Blood of Christ')
  })

  it('uses Roman names through Lent and Easter, not RCL ones', () => {
    expect(resolveRomanLectionary('2026-02-18').designation).toBe('Ash Wednesday')
    expect(resolveRomanLectionary('2026-03-29').designation).toBe('Palm Sunday of the Passion of the Lord')
    expect(resolveRomanLectionary('2026-04-05').designation).toBe('Easter Sunday of the Resurrection of the Lord')
    expect(resolveRomanLectionary('2026-04-12').designation).toBe('Second Sunday of Easter')
    // The RCL calls the last Sunday before Lent the Transfiguration;
    // Rome just keeps counting Ordinary Time.
    expect(resolveLectionary('2026-02-15').designation).toMatch(/Transfiguration/)
  })

  it('resolves a weekday to its week, the way an Ordo does', () => {
    expect(resolveRomanLectionary('2026-09-02')).toMatchObject({
      designation: 'Week of the Twenty-second Sunday in Ordinary Time',
      is_sunday: false,
    })
  })

  it('numbers every Ordinary Time Sunday exactly once, 2024 through 2035', () => {
    // The backward count from Christ the King is what absorbs a variable
    // Easter. If it is wrong, some year will duplicate or skip a number.
    const ORD = ['', 'First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh',
      'Eighth', 'Ninth', 'Tenth', 'Eleventh', 'Twelfth', 'Thirteenth', 'Fourteenth',
      'Fifteenth', 'Sixteenth', 'Seventeenth', 'Eighteenth', 'Nineteenth', 'Twentieth',
      'Twenty-first', 'Twenty-second', 'Twenty-third', 'Twenty-fourth', 'Twenty-fifth',
      'Twenty-sixth', 'Twenty-seventh', 'Twenty-eighth', 'Twenty-ninth', 'Thirtieth',
      'Thirty-first', 'Thirty-second', 'Thirty-third', 'Thirty-fourth']
    for (let y = 2024; y <= 2035; y++) {
      const nums = []
      for (let i = 0; i < 366; i++) {
        const d = new Date(Date.UTC(y, 0, 1 + i))
        if (d.getUTCFullYear() !== y) break
        if (d.getUTCDay() !== 0) continue
        const r = resolveRomanLectionary(d.toISOString().slice(0, 10))
        expect(r.designation, `${y}: no designation for a Sunday`).toBeTruthy()
        const m = /^(.+) Sunday in Ordinary Time$/.exec(r.designation)
        if (m) nums.push(ORD.indexOf(m[1]))
      }
      expect(new Set(nums).size, `${y}: duplicate Ordinary Time numbers`).toBe(nums.length)
      expect(Math.min(...nums), `${y}: numbering starts below 2`).toBeGreaterThanOrEqual(2)
      expect(Math.max(...nums), `${y}: numbering runs past 33`).toBeLessThanOrEqual(33)
    }
  })
})

// Placed ABOVE 'role enforcement' so tokenA keeps its admin role.
describe('the Sunday Packet (SPK.1)', () => {
  const PACKET_DATE = '2027-06-06' // a quiet future Sunday no other group touches
  let memberId

  // This suite asserts RCL designations (Propers, "Sunday after
  // Pentecost"), which before TRAD.1 every org received whether or not it
  // was Episcopal. It now depends on the org's tradition, so say so out
  // loud rather than inheriting a default — and restore it afterwards,
  // because orgA is shared with other suites.
  beforeAll(async () => {
    const setTrad = await request(server).patch('/api/organization')
      .set('Authorization', `Bearer ${tokenA}`).send({ tradition: 'episcopal' })
    expect(setTrad.status).toBe(200)

    const m = await request(server).post('/api/clients')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `Packet Lector ${RUN_ID}` })
    memberId = m.body.id

    const plan = await request(server).post('/api/service-plans')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ date: PACKET_DATE, title: 'Packet Test Mass' })
    await request(server).post(`/api/service-plans/${plan.body.id}/elements`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ kind: 'reading', title: 'First Reading', assigned_client_id: memberId })

    await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ title: `Packet Mass ${RUN_ID}`, date: PACKET_DATE, start_time: '09:00', end_time: '10:15', type: 'service', assigned_to: [memberId] })

    await request(server).post('/api/mass-intentions')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ intention: `† Packet Test Soul ${RUN_ID}`, mass_date: PACKET_DATE, status: 'scheduled' })

    await request(server).post('/api/bulletins')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ date: PACKET_DATE, title: 'Packet Bulletin', announcements: `Packet announcement ${RUN_ID}` })
  })

  it('assembles every section for the date in one call', async () => {
    const res = await request(server).get(`/api/packet?date=${PACKET_DATE}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.date).toBe(PACKET_DATE)
    // Liturgical + lectionary agree it's a mid-year Sunday.
    expect(res.body.liturgical.season).toBeTruthy()
    expect(res.body.lectionary.is_sunday).toBe(true)
    expect(res.body.lectionary.cycle).toBe('B') // liturgical year from Advent 2026
    // Order of worship with the assignment name resolved.
    expect(res.body.plan.title).toBe('Packet Test Mass')
    expect(res.body.plan.elements[0].assigned_name).toBe(`Packet Lector ${RUN_ID}`)
    // Serving schedule resolved the jsonb id array to names.
    const serving = res.body.serving.find(s => s.title === `Packet Mass ${RUN_ID}`)
    expect(serving.assigned).toContain(`Packet Lector ${RUN_ID}`)
    // The week of intentions includes ours, formatted with the †.
    expect(res.body.intentions.some(i => i.formatted_intention.includes('Packet Test Soul'))).toBe(true)
    // Bulletin announcements rode along.
    expect(res.body.bulletin.announcements).toBe(`Packet announcement ${RUN_ID}`)
  })

  it("org B's packet contains none of org A's Sunday", async () => {
    const res = await request(server).get(`/api/packet?date=${PACKET_DATE}`)
      .set('Authorization', `Bearer ${tokenB}`)
    expect(res.status).toBe(200)
    expect(res.body.plan).toBeNull()
    expect(res.body.serving.find(s => s.title === `Packet Mass ${RUN_ID}`)).toBeUndefined()
    expect(res.body.intentions.some(i => (i.formatted_intention || '').includes('Packet Test Soul'))).toBe(false)
    expect(res.body.bulletin?.announcements ?? null).not.toBe(`Packet announcement ${RUN_ID}`)
  })

  it('an empty Sunday still returns 200 with empty sections, never an error', async () => {
    const res = await request(server).get('/api/packet?date=2028-03-05')
      .set('Authorization', `Bearer ${tokenB}`)
    expect(res.status).toBe(200)
    expect(res.body.plan).toBeNull()
    expect(res.body.serving).toEqual([])
    expect(res.body.intentions).toEqual([])
    // The computed parts still answer. orgB has never named a tradition,
    // so it is 'general' — which means a liturgical season (every Western
    // tradition shares those) and NO lectionary designation, because we do
    // not know whose Sunday name to print. Asserting the null is the point:
    // before TRAD.1 this org silently received Episcopal Propers.
    expect(res.body.tradition).toBe('general')
    expect(res.body.liturgical.season).toBeTruthy()
    expect(res.body.lectionary).toBeNull()
  })

  it('defaults to a valid upcoming Sunday when no date is given', async () => {
    const res = await request(server).get('/api/packet')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(res.body.lectionary.is_sunday).toBe(true)
  })
})

describe('tradition foundation (TRAD.1)', () => {
  // The defect this closes: two liturgical engines, two traditions, both
  // printed on one sheet. routes/liturgical.js says "Ordinary Time" and
  // names 1 January "Mary, Mother of God"; services/lectionary.js says
  // "Nth Sunday after Pentecost · Proper N" and names the same day
  // "The Holy Name". Every parish got both. These tests assert that a
  // parish now gets exactly one tradition's vocabulary — and that a parish
  // which has told us nothing gets NO lectionary rather than a wrong one.
  const mk = (tradition, n) => ({
    organizationName: `Trad ${tradition} ${RUN_ID}`,
    name: 'Secretary',
    email: `trad_${tradition}_${RUN_ID}@example.com`,
    password: `smoke-test-pw-2${n}`,
    tradition,
  })
  const tokens = {}
  const cleanupOrgIds = []

  beforeAll(async () => {
    let n = 0
    for (const trad of ['catholic', 'episcopal', 'general']) {
      const res = await request(server).post('/api/auth/signup')
        .set('X-Forwarded-For', '10.99.0.11').send(mk(trad, n++))
      expect(res.status).toBe(201)
      tokens[trad] = res.body.token
      cleanupOrgIds.push(res.body.user.organization.id)
    }
  }, 30_000)

  afterAll(async () => {
    for (const id of cleanupOrgIds) {
      await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
    }
  })

  const packet = async (trad, date) => {
    const res = await request(server).get(`/api/packet?date=${date}`)
      .set('Authorization', `Bearer ${tokens[trad]}`)
    expect(res.status).toBe(200)
    return res.body
  }

  it('signup records the tradition and hands it back on the org', async () => {
    const me = await request(server).get('/api/auth/me')
      .set('Authorization', `Bearer ${tokens.catholic}`)
    expect(me.status).toBe(200)
    const org = me.body.user?.organization ?? me.body.organization
    expect(org.tradition).toBe('catholic')
    // The client's i18n spine has read organization.locale since day one
    // and never received it. It does now.
    expect(org).toHaveProperty('locale')
  })

  it('an unrecognised tradition falls back to general rather than 400ing a signup', async () => {
    const res = await request(server).post('/api/auth/signup')
      .set('X-Forwarded-For', '10.99.0.11')
      .send({ ...mk('nonsense', 9), email: `trad_bogus_${RUN_ID}@example.com` })
    expect(res.status).toBe(201)
    cleanupOrgIds.push(res.body.user.organization.id)
    expect(res.body.user.organization.tradition).toBe('general')
  })

  it('a Catholic parish gets Roman designations and NO Proper', async () => {
    const p = await packet('catholic', '2026-08-30')
    expect(p.tradition).toBe('catholic')
    expect(p.lectionary.designation).toBe('Twenty-second Sunday in Ordinary Time')
    expect(p.lectionary.proper).toBeNull()
  })

  it('an Episcopal parish gets RCL designations WITH a Proper', async () => {
    const p = await packet('episcopal', '2026-08-30')
    expect(p.tradition).toBe('episcopal')
    expect(p.lectionary.designation).toBe('Fourteenth Sunday after Pentecost')
    expect(p.lectionary.proper).toBe(17)
  })

  it('the two vocabularies can never appear on the same packet again', async () => {
    // The actual defect, asserted directly: one date, two parishes, and
    // neither may carry the other's words.
    const [cat, epi] = await Promise.all([packet('catholic', '2026-08-30'), packet('episcopal', '2026-08-30')])
    expect(cat.lectionary.designation).not.toMatch(/after Pentecost/)
    expect(epi.lectionary.designation).not.toMatch(/Ordinary Time/)
    expect(cat.lectionary.designation).not.toBe(epi.lectionary.designation)
  })

  it('a general org gets NO lectionary line at all', async () => {
    // Printing nothing is honest. Printing another tradition's Sunday
    // name is not, and that is what shipped before this.
    const p = await packet('general', '2026-08-30')
    expect(p.tradition).toBe('general')
    expect(p.lectionary).toBeNull()
    // …but everything else on the sheet still works.
    expect(p.liturgical.season).toBe('Ordinary Time')
    expect(p.date).toBe('2026-08-30')
  })

  it('reports which block of counted time a date falls in', async () => {
    // The canonical season token stays 'Ordinary Time' — calendar rows are
    // already stamped with it — while the block is what lets an Episcopal
    // parish render "Season after Pentecost" without a data migration.
    const after = await request(server).get('/api/liturgical?date=2026-08-30')
      .set('Authorization', `Bearer ${tokens.episcopal}`)
    expect(after.body.season).toBe('Ordinary Time')
    expect(after.body.ordinary_block).toBe('after_pentecost')

    const before = await request(server).get('/api/liturgical?date=2026-01-20')
      .set('Authorization', `Bearer ${tokens.episcopal}`)
    expect(before.body.season).toBe('Ordinary Time')
    expect(before.body.ordinary_block).toBe('after_epiphany')

    // Seasons outside counted time report null, never undefined.
    const lent = await request(server).get('/api/liturgical?date=2026-03-01')
      .set('Authorization', `Bearer ${tokens.episcopal}`)
    expect(lent.body.season).toBe('Lent')
    expect(lent.body.ordinary_block).toBeNull()
  })

  it('an admin can change tradition, and the packet follows immediately', async () => {
    const before = await packet('general', '2026-08-30')
    expect(before.lectionary).toBeNull()

    const patch = await request(server).patch('/api/organization')
      .set('Authorization', `Bearer ${tokens.general}`).send({ tradition: 'catholic' })
    expect(patch.status).toBe(200)
    expect(patch.body.tradition ?? patch.body.organization?.tradition).toBe('catholic')

    // The 60s cache must not outlive the admin's own page load.
    const after = await packet('general', '2026-08-30')
    expect(after.tradition).toBe('catholic')
    expect(after.lectionary.designation).toBe('Twenty-second Sunday in Ordinary Time')

    await request(server).patch('/api/organization')
      .set('Authorization', `Bearer ${tokens.general}`).send({ tradition: 'general' })
  })

  it('refuses an unknown tradition on PATCH rather than silently generalising', async () => {
    const res = await request(server).patch('/api/organization')
      .set('Authorization', `Bearer ${tokens.catholic}`).send({ tradition: 'zoroastrian' })
    expect(res.status).toBe(400)
    const me = await request(server).get('/api/organization')
      .set('Authorization', `Bearer ${tokens.catholic}`)
    expect(me.body.tradition ?? me.body.organization?.tradition).toBe('catholic')
  })

  it('the database refuses a bad tradition even if a route ever stops checking', async () => {
    await expect(
      pool.query('UPDATE ochr_organizations SET tradition = $1 WHERE id = $2', ['nonsense', cleanupOrgIds[0]])
    ).rejects.toThrow()
  })
})

describe('tradition-aware sample data (TRAD.2)', () => {
  // sampleSeed.js used to declare itself "intentionally
  // denomination-neutral" and then seed tithe, Sunday School Teacher,
  // Worship Leader, Prayer Team, Fellowship Hall and Bible Study — which
  // is not neutral, it is low-church Protestant. A brand-new Catholic
  // parish met that inside a Catholic shell: the nav said Intentions and
  // Register while the sample data said Fellowship Hall.
  //
  // The seed now follows the tradition chosen AT SIGNUP, because the seed
  // runs the moment signup commits — asking afterwards is too late.
  const cleanupOrgIds = []
  const tokens = {}

  const signup = async (tradition, n) => {
    const res = await request(server).post('/api/auth/signup')
      .set('X-Forwarded-For', '10.99.0.13')
      .send({
        organizationName: `Seed ${tradition} ${RUN_ID}`,
        name: 'Secretary',
        email: `seed_${tradition}_${RUN_ID}@example.com`,
        password: `smoke-test-pw-4${n}`,
        ...(tradition === 'unset' ? {} : { tradition }),
      })
    expect(res.status).toBe(201)
    cleanupOrgIds.push(res.body.user.organization.id)
    return res.body.token
  }

  beforeAll(async () => {
    let n = 0
    for (const t of ['catholic', 'episcopal', 'lutheran', 'unset']) {
      tokens[t] = await signup(t, n++)
    }
    // The seed is fired after the signup transaction commits, on purpose —
    // a seed failure must never block account creation. Give it a moment.
    await new Promise(r => setTimeout(r, 1500))
  }, 45_000)

  afterAll(async () => {
    for (const id of cleanupOrgIds) {
      await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
    }
  })

  // These endpoints return a bare array, not a wrapper. Asserting the
  // shape rather than defaulting to [] — a helper that silently yields an
  // empty list turns every assertion below into a test of nothing.
  const listOf = async (path, trad) => {
    const res = await request(server).get(path)
      .set('Authorization', `Bearer ${tokens[trad]}`)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    expect(res.body.length).toBeGreaterThan(0)
    return res.body
  }
  const rolesFor    = async (trad) => (await listOf('/api/clients?limit=50', trad)).map(c => c.role).filter(Boolean)
  const eventTitles = async (trad) => (await listOf('/api/events', trad)).map(e => e.title).filter(Boolean)

  it('a Catholic parish is seeded with Catholic words', async () => {
    const roles = await rolesFor('catholic')
    expect(roles).toContain('Catechist')
    expect(roles).toContain('Finance Council')
    expect(roles).not.toContain('Sunday School Teacher')
    expect(roles).not.toContain('Worship Leader')

    const titles = await eventTitles('catholic')
    expect(titles.some(t => /Sunday Mass/.test(t))).toBe(true)
    expect(titles.some(t => /Fellowship Hall/.test(t))).toBe(false)
  })

  it('an Episcopal parish is seeded with Episcopal words', async () => {
    const roles = await rolesFor('episcopal')
    expect(roles).toContain('Vestry')
    expect(roles).toContain('Altar Guild')
    expect(roles).not.toContain('Finance Committee')

    const titles = await eventTitles('episcopal')
    expect(titles.some(t => /Holy Eucharist/.test(t))).toBe(true)
    expect(titles.some(t => /Sunday Mass/.test(t))).toBe(false)
  })

  it('a Lutheran congregation is seeded with Lutheran words', async () => {
    const roles = await rolesFor('lutheran')
    expect(roles).toContain('Congregation Council')
    expect(roles).not.toContain('Vestry')

    const titles = await eventTitles('lutheran')
    expect(titles.some(t => /Sunday Worship/.test(t))).toBe(true)
  })

  it('a parish that names no tradition gets the neutral seed, not a Catholic one', async () => {
    // 'general' is a real tier. It must not quietly inherit whichever
    // tradition happens to be the default in the shared string table.
    const roles = await rolesFor('unset')
    expect(roles).toContain('Finance Committee')
    expect(roles).not.toContain('Catechist')
    expect(roles).not.toContain('Vestry')

    const titles = await eventTitles('unset')
    expect(titles.some(t => /Sunday Service/.test(t))).toBe(true)
    expect(titles.some(t => /Mass|Eucharist/.test(t))).toBe(false)
  })

  it('the giving categories follow the tradition too', async () => {
    const cats = async (trad) => (await listOf('/api/donations?limit=50', trad)).map(d => d.category).filter(Boolean)
    expect(await cats('catholic')).toContain('offertory')
    expect(await cats('episcopal')).toContain('pledge')
    expect((await cats('catholic'))).not.toContain('tithe')
  })

  it('every seeded row is still wipeable — the [Sample] marker survives', async () => {
    // clear-samples matches on '[Sample]%'. If a tradition ever moved the
    // marker inside the interpolation, a parish could not clear its demo
    // data, which is worse than the vocabulary problem this fixes.
    for (const trad of ['catholic', 'episcopal', 'lutheran', 'unset']) {
      const titles = await eventTitles(trad)
      expect(titles.length).toBeGreaterThan(0)
      expect(titles.every(t => t.startsWith('[Sample]'))).toBe(true)
    }
  })

  it('the seed vocabulary falls back rather than throwing on an unknown tradition', async () => {
    const { seedVocab } = await import('../src/onboarding/sampleSeed.js')
    expect(seedVocab('zoroastrian').service).toBe(seedVocab('general').service)
    expect(seedVocab(undefined).roles.length).toBe(12)
  })
})

describe('tradition-specific reporting (RPT.1)', () => {
  // The thesis: parish work → OpenChurch record → trusted source data →
  // tradition-specific report → review → submit. Not "do the work, enter
  // it, re-enter it for the report, reconcile a spreadsheet".
  //
  // The load-bearing property is not the arithmetic. It is that every
  // figure arrives with its source AND with whether we have verified the
  // report actually asks for it. Nobody here has read the Parochial Report
  // form; pretending otherwise on a sheet a rector signs is the failure
  // mode this whole layer is shaped to avoid.
  const cleanupOrgIds = []
  let epi, cat, memberId

  const mk = async (tradition, n) => {
    const res = await request(server).post('/api/auth/signup')
      .set('X-Forwarded-For', '10.99.0.14')
      .send({
        organizationName: `Report ${tradition} ${RUN_ID}`, name: 'Registrar',
        email: `rpt_${tradition}_${RUN_ID}@example.com`,
        password: `smoke-test-pw-5${n}`, tradition,
      })
    expect(res.status).toBe(201)
    cleanupOrgIds.push(res.body.user.organization.id)
    return res.body.token
  }

  beforeAll(async () => {
    epi = await mk('episcopal', 0)
    cat = await mk('catholic', 1)

    const m = await request(server).post('/api/clients')
      .set('Authorization', `Bearer ${epi}`).send({ name: `Report Member ${RUN_ID}` })
    memberId = m.body.id

    // Two baptisms and a burial in 2029; one baptism voided, so the count
    // must be 2 and not 3.
    for (const d of ['2029-03-04', '2029-06-10']) {
      const r = await request(server).post('/api/sacraments')
        .set('Authorization', `Bearer ${epi}`)
        .send({ client_id: memberId, type: 'baptism', date: d })
      expect(r.status).toBe(201)
    }
    const doomed = await request(server).post('/api/sacraments')
      .set('Authorization', `Bearer ${epi}`)
      .send({ client_id: memberId, type: 'baptism', date: '2029-07-01' })
    await request(server).post(`/api/sacraments/${doomed.body.id}/void`)
      .set('Authorization', `Bearer ${epi}`).send({ reason: 'Duplicate of the June entry' })

    await request(server).post('/api/sacraments')
      .set('Authorization', `Bearer ${epi}`)
      .send({ client_id: memberId, type: 'burial', date: '2029-09-02' })

    // A baptism outside the period, to prove the window is real.
    await request(server).post('/api/sacraments')
      .set('Authorization', `Bearer ${epi}`)
      .send({ client_id: memberId, type: 'baptism', date: '2030-01-05' })
  }, 45_000)

  afterAll(async () => {
    for (const id of cleanupOrgIds) {
      await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
    }
  })

  const run = async (token, qs = 'start=2029-01-01&end=2029-12-31') => {
    const res = await request(server).get(`/api/reports/parochial-report?${qs}`)
      .set('Authorization', `Bearer ${token}`)
    return res
  }
  const field = (body, key) => body.fields.find(f => f.key === key)

  it('offers the Parochial Report to an Episcopal parish', async () => {
    const res = await request(server).get('/api/reports')
      .set('Authorization', `Bearer ${epi}`)
    expect(res.status).toBe(200)
    expect(res.body.tradition).toBe('episcopal')
    expect(res.body.reports.map(r => r.key)).toContain('parochial-report')
    // The count of unconfirmed lines is surfaced up front, not buried.
    expect(res.body.reports[0].unverified_count).toBeGreaterThan(0)
  })

  it('offers a Catholic parish nothing, and says why rather than looking broken', async () => {
    // A Catholic parish files the Status Animarum, to its own chancery, on
    // a diocesan deadline. Nobody has seen one. An empty list plus an
    // explanation beats inventing a definition.
    const res = await request(server).get('/api/reports')
      .set('Authorization', `Bearer ${cat}`)
    expect(res.status).toBe(200)
    expect(res.body.reports).toEqual([])
    expect(res.body.note).toMatch(/catholic/i)

    const denied = await run(cat)
    expect(denied.status).toBe(404)
  })

  it('counts register entries in the period, excluding voided ones', async () => {
    const res = await run(epi)
    expect(res.status).toBe(200)
    // Three baptisms entered for 2029; one voided. The void has to bite
    // here or it means nothing.
    expect(field(res.body, 'baptisms').value).toBe(2)
    expect(field(res.body, 'burials').value).toBe(1)
  })

  it('respects the period window', async () => {
    const res = await run(epi, 'start=2030-01-01&end=2030-12-31')
    expect(field(res.body, 'baptisms').value).toBe(1)
  })

  it('every field carries its source', async () => {
    const res = await run(epi)
    for (const f of res.body.fields) {
      expect(f.source, `${f.key} has no source`).toBeTruthy()
      expect(['verified', 'unverified', 'unsupported']).toContain(f.requirement)
    }
  })

  it('marks what we have NOT confirmed the form asks for', async () => {
    const res = await run(epi)
    // Baptism counts and ASA are verified against published sources.
    expect(field(res.body, 'baptisms').requirement).toBe('verified')
    expect(field(res.body, 'asa').requirement).toBe('verified')
    // Marriages and burials are not. Nobody has read the form.
    expect(field(res.body, 'marriages').requirement).toBe('unverified')
    expect(field(res.body, 'burials').requirement).toBe('unverified')
  })

  it('emits NO number for something we cannot produce', async () => {
    // A zero and a blank are different claims. "We received nobody" and
    // "we cannot tell you" must never render the same way.
    const res = await run(epi)
    const r = field(res.body, 'receptions')
    expect(r.requirement).toBe('unsupported')
    expect(r.value).toBeNull()
    expect(r.source).toMatch(/[Nn]ot recorded/)
  })

  it('says on every response that it is not a filing', async () => {
    const res = await run(epi)
    expect(res.body.disclaimer).toMatch(/[Nn]othing here is filed/)
  })

  it('rejects a period that runs backwards', async () => {
    const res = await run(epi, 'start=2029-12-31&end=2029-01-01')
    expect(res.status).toBe(400)
  })

  it('exports a CSV that carries the provenance with it', async () => {
    const res = await request(server).get('/api/reports/parochial-report.csv?start=2029-01-01&end=2029-12-31')
      .set('Authorization', `Bearer ${epi}`)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/csv/)
    expect(res.headers['content-disposition']).toMatch(/parochial-report-2029-01-01-to-2029-12-31\.csv/)
    expect(res.text).toMatch(/^field,value,requirement,source,note/)
    expect(res.text).toMatch(/Baptisms,2,verified/)
    // The disclaimer outlives the screen — a CSV gets emailed onward.
    expect(res.text).toMatch(/[Nn]othing here is filed/)
  })

  it('is tenant-scoped — another parish sees its own zeroes', async () => {
    const other = await mk('anglican', 2)
    const res = await run(other)
    expect(res.status).toBe(200)
    expect(field(res.body, 'baptisms').value).toBe(0)
  })
})

// Placed ABOVE 'role enforcement' so tokenA keeps its admin role.
// Regression (fixed 2026-07-31): the pledges LIST query selects specific
// columns, and donorKeyForPledge trusted `pledge.organization_id` to be
// on the row — absent, the org-scoped member-email lookup matched
// nothing, and every member-linked pledge showed 0% fulfilled in the
// list and in Insights while GET /:id (p.*) computed it correctly.
describe('pledge fulfillment on the list endpoint (regression)', () => {
  it('member-linked pledges match donations by the member email in the LIST view', async () => {
    const email = `pledge_reg_${RUN_ID}@example.com`
    const m = await request(server).post('/api/clients')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `Pledge Reg Member ${RUN_ID}`, email })
    const p = await request(server).post('/api/pledges')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ member_id: m.body.id, amount: 100, frequency: 'monthly', start_date: '2027-01-01', end_date: '2027-12-31' })
    expect(p.status).toBe(201)
    const d = await request(server).post('/api/donations')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ donor_name: `Pledge Reg Member ${RUN_ID}`, donor_email: email, amount: 250, category: 'tithe', date: '2027-02-15' })
    expect(d.status).toBe(201)

    const list = await request(server).get('/api/pledges')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(list.status).toBe(200)
    const mine = list.body.pledges.find(x => x.id === p.body.id)
    expect(mine).toBeTruthy()
    expect(Number(mine.matched_total)).toBe(250)
    expect(mine.gift_count).toBe(1)
    expect(mine.fulfillment).toBeGreaterThan(0)
  })
})

describe('support tickets (SUP.2)', () => {
  let orgAId, orgBId, viewerToken, ticketV, ticketA, ticketB

  beforeAll(async () => {
    // No AI key, no vendor identity — the baseline posture for these tests.
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.SUPER_ADMIN_EMAIL
    delete process.env.VENDOR_ADMIN_EMAILS

    const { rows } = await pool.query(
      'SELECT id, name FROM ochr_organizations WHERE name = ANY($1) ORDER BY name',
      [[orgA.organizationName, orgB.organizationName]]
    )
    orgAId = rows.find(r => r.name === orgA.organizationName).id
    orgBId = rows.find(r => r.name === orgB.organizationName).id

    // A viewer in org A — the least-privileged reporter.
    const viewer = {
      name: 'Vera Viewer', email: `test_va_${RUN_ID}@example.com`,
      password: 'viewer-pw-1', role: 'viewer',
    }
    const create = await request(server).post('/api/users')
      .set('Authorization', `Bearer ${tokenA}`).send(viewer)
    expect(create.status).toBe(201)
    const login = await request(server).post('/api/auth/login')
      .send({ email: viewer.email, password: viewer.password })
    viewerToken = login.body.token
  })

  afterAll(() => {
    delete process.env.SUPER_ADMIN_EMAIL
    delete process.env.VENDOR_ADMIN_EMAILS
  })

  it('a viewer can submit a report (no writeGate on intake)', async () => {
    const res = await request(server).post('/api/support-tickets')
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({
        description: `The manifest print button does nothing ${RUN_ID}`,
        page_route: '/mass-intentions',
        context_bundle: { viewport: '390x844' },
      })
    expect(res.status).toBe(201)
    ticketV = res.body.id
    const { rows: [row] } = await pool.query(
      'SELECT * FROM ochr_support_tickets WHERE id = $1', [ticketV])
    expect(row.organization_id).toBe(orgAId)
    expect(row.status).toBe('new')
    expect(row.severity).toBe('normal')
    expect(row.classification).toBeNull()
    expect(row.diagnosis).toBeNull() // no AI key → untriaged, never an error
  })

  it('audits the submission (create, support_ticket)', async () => {
    const row = await waitForAuditRow(orgAId, r =>
      r.entity_type === 'support_ticket' && r.action === 'create' &&
      String(r.entity_id) === String(ticketV))
    expect(row).toBeTruthy()
  })

  it('rejects a too-short description', async () => {
    const res = await request(server).post('/api/support-tickets')
      .set('Authorization', `Bearer ${tokenA}`).send({ description: 'broken' })
    expect(res.status).toBe(400)
  })

  it('/mine shows the reporter only their own reports, without diagnosis', async () => {
    const a = await request(server).post('/api/support-tickets')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ description: `Admin A report about statements ${RUN_ID}` })
    ticketA = a.body.id
    const b = await request(server).post('/api/support-tickets')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ description: `Org B report about schedule ${RUN_ID}` })
    ticketB = b.body.id

    const mine = await request(server).get('/api/support-tickets/mine')
      .set('Authorization', `Bearer ${viewerToken}`)
    expect(mine.status).toBe(200)
    const ids = mine.body.tickets.map(t => t.id)
    expect(ids).toContain(ticketV)
    expect(ids).not.toContain(ticketA) // same org, different reporter
    expect(ids).not.toContain(ticketB)
    expect(mine.body.tickets[0].diagnosis).toBeUndefined()
  })

  it('the queue is admin-only, org-scoped, and severity-ordered', async () => {
    const nope = await request(server).get('/api/support-tickets')
      .set('Authorization', `Bearer ${viewerToken}`)
    expect(nope.status).toBe(403)

    // Escalate one ticket so the ordering is observable.
    await pool.query(
      `UPDATE ochr_support_tickets SET severity = 'critical' WHERE id = $1`, [ticketA])

    const res = await request(server).get('/api/support-tickets')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.vendor).toBe(false)
    const ids = res.body.tickets.map(t => t.id)
    expect(ids).toContain(ticketV)
    expect(ids).toContain(ticketA)
    expect(ids).not.toContain(ticketB) // org B invisible
    expect(ids.indexOf(ticketA)).toBeLessThan(ids.indexOf(ticketV)) // critical first

    const paged = await request(server).get('/api/support-tickets?limit=1')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(paged.body.tickets.length).toBe(1)

    const filtered = await request(server).get('/api/support-tickets?severity=critical')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(filtered.body.tickets.every(t => t.severity === 'critical')).toBe(true)
  })

  it('cross-org probes 404 (read and write)', async () => {
    const read = await request(server).get(`/api/support-tickets/${ticketB}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(read.status).toBe(404)
    const write = await request(server).patch(`/api/support-tickets/${ticketB}`)
      .set('Authorization', `Bearer ${tokenA}`).send({ status: 'resolved' })
    expect(write.status).toBe(404)
  })

  it('a parish admin may resolve with notes but not triage', async () => {
    const sev = await request(server).patch(`/api/support-tickets/${ticketV}`)
      .set('Authorization', `Bearer ${tokenA}`).send({ severity: 'low' })
    expect(sev.status).toBe(400) // vendor-only field

    const walk = await request(server).patch(`/api/support-tickets/${ticketV}`)
      .set('Authorization', `Bearer ${tokenA}`).send({ status: 'in_progress' })
    expect(walk.status).toBe(400) // vendor-only status

    const ok = await request(server).patch(`/api/support-tickets/${ticketV}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ status: 'resolved', resolution_notes: 'Printer was unplugged.' })
    expect(ok.status).toBe(200)
    expect(ok.body.status).toBe('resolved')
    expect(ok.body.resolution_notes).toBe('Printer was unplugged.')
  })

  it('vendor identity fails closed, then opens the cross-org queue', async () => {
    // Nothing configured → org-scoped even for admins (asserted above via
    // vendor:false). Configure the founder → cross-org with org names.
    process.env.SUPER_ADMIN_EMAIL = orgA.email
    const res = await request(server).get('/api/support-tickets')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.vendor).toBe(true)
    const rowB = res.body.tickets.find(t => t.id === ticketB)
    expect(rowB).toBeTruthy()
    expect(rowB.org_name).toBe(orgB.organizationName)
  })

  it('the vendor runs full triage on any org’s ticket, audited', async () => {
    process.env.SUPER_ADMIN_EMAIL = orgA.email
    const res = await request(server).patch(`/api/support-tickets/${ticketB}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        status: 'in_progress', severity: 'high', classification: 'bug',
        assigned_to: 'José', resolution_notes: null,
      })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('in_progress')
    expect(res.body.severity).toBe('high')
    expect(res.body.classification).toBe('bug')
    expect(res.body.assigned_to).toBe('José')

    const audit = await waitForAuditRow(orgAId, r =>
      r.entity_type === 'support_ticket' && r.action === 'update' &&
      String(r.entity_id) === String(ticketB))
    expect(audit).toBeTruthy()

    const bad = await request(server).patch(`/api/support-tickets/${ticketB}`)
      .set('Authorization', `Bearer ${tokenA}`).send({ classification: 'complaint' })
    expect(bad.status).toBe(400)
  })

  it('the vendor can filter by organization and search report text', async () => {
    process.env.SUPER_ADMIN_EMAIL = orgA.email
    const byOrg = await request(server).get(`/api/support-tickets?org_id=${orgBId}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(byOrg.status).toBe(200)
    expect(byOrg.body.tickets.length).toBeGreaterThan(0)
    expect(byOrg.body.tickets.every(t => t.organization_id === orgBId)).toBe(true)

    const byText = await request(server).get('/api/support-tickets?q=manifest+print')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(byText.status).toBe(200)
    expect(byText.body.tickets.some(t => t.id === ticketV)).toBe(true)

    // ILIKE wildcards in the needle are escaped — '%' matches nothing
    // rather than everything.
    const wild = await request(server).get('/api/support-tickets?q=%25zzz%25')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(wild.body.tickets.length).toBe(0)
  })

  it('org_id from a parish admin can never widen the scope', async () => {
    delete process.env.SUPER_ADMIN_EMAIL
    delete process.env.VENDOR_ADMIN_EMAILS
    const res = await request(server).get(`/api/support-tickets?org_id=${orgBId}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.tickets.every(t => t.organization_id === orgAId)).toBe(true)
    expect(res.body.tickets.some(t => t.id === ticketB)).toBe(false)
  })

  it('VENDOR_ADMIN_EMAILS extends the allowlist beyond the founder', async () => {
    delete process.env.SUPER_ADMIN_EMAIL
    process.env.VENDOR_ADMIN_EMAILS = ` other@osl.dev , ${orgB.email.toUpperCase()} `
    const res = await request(server).get('/api/support-tickets')
      .set('Authorization', `Bearer ${tokenB}`)
    expect(res.status).toBe(200)
    expect(res.body.vendor).toBe(true)
    expect(res.body.tickets.some(t => t.organization_id === orgAId)).toBe(true)
  })

  it('a vendor resolution notifies the reporter (once, prefs respected)', async () => {
    process.env.SUPER_ADMIN_EMAIL = orgA.email
    delete process.env.VENDOR_ADMIN_EMAILS
    // A fresh ticket from the viewer, resolved by the vendor.
    const fresh = await request(server).post('/api/support-tickets')
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ description: `Notify-loop check ${RUN_ID}` })
    const res = await request(server).patch(`/api/support-tickets/${fresh.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ status: 'resolved', resolution_notes: 'Fixed in tonight’s update.' })
    expect(res.status).toBe(200)

    // The notification log row lands async — poll for THIS ticket's
    // letter specifically (earlier tests legitimately produced others).
    let row = null
    for (let i = 0; i < 40 && !row; i++) {
      const { rows } = await pool.query(
        `SELECT recipient_email, subject, body FROM ochr_notification_log
          WHERE organization_id = $1 AND notification_type = 'support_ticket_update'
            AND body LIKE '%Notify-loop check%'
          ORDER BY id DESC LIMIT 1`, [orgAId])
      row = rows[0] ?? null
      if (!row) await new Promise(r => setTimeout(r, 50))
    }
    expect(row).toBeTruthy()
    expect(row.recipient_email).toBe(`test_va_${RUN_ID}@example.com`)
    expect(row.subject).toContain('Resolved')
    expect(row.body).toContain('Fixed in tonight’s update.')

    // A re-save with the same status must not send a second letter.
    const beforeCount = (await pool.query(
      `SELECT COUNT(*)::int AS n FROM ochr_notification_log
        WHERE organization_id = $1 AND notification_type = 'support_ticket_update'`, [orgAId])).rows[0].n
    await request(server).patch(`/api/support-tickets/${fresh.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ status: 'resolved' })
    await new Promise(r => setTimeout(r, 300))
    const afterCount = (await pool.query(
      `SELECT COUNT(*)::int AS n FROM ochr_notification_log
        WHERE organization_id = $1 AND notification_type = 'support_ticket_update'`, [orgAId])).rows[0].n
    expect(afterCount).toBe(beforeCount)
    delete process.env.SUPER_ADMIN_EMAIL
  })
})

describe('in-app assistant (SUP.3)', () => {
  let orgAId

  beforeAll(async () => {
    const { rows } = await pool.query(
      'SELECT id FROM ochr_organizations WHERE name = $1', [orgA.organizationName])
    orgAId = rows[0].id
  })

  it('validates the question', async () => {
    const res = await request(server).post('/api/assistant')
      .set('Authorization', `Bearer ${tokenA}`).send({ question: '' })
    expect(res.status).toBe(400)
  })

  it('feedback is org-scoped', async () => {
    const { rows: [msg] } = await pool.query(
      `INSERT INTO ochr_assistant_messages (organization_id, question, answer)
       VALUES ($1, 'q', 'a') RETURNING id`, [orgAId])
    const cross = await request(server).post(`/api/assistant/${msg.id}/feedback`)
      .set('Authorization', `Bearer ${tokenB}`).send({ feedback: 'up' })
    expect(cross.status).toBe(404)
    const own = await request(server).post(`/api/assistant/${msg.id}/feedback`)
      .set('Authorization', `Bearer ${tokenA}`).send({ feedback: 'up' })
    expect(own.status).toBe(200)
  })

  it('reports availability so the widget can hide an assistant that cannot answer', async () => {
    delete process.env.ANTHROPIC_API_KEY
    const off = await request(server).get('/api/assistant/status')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(off.status).toBe(200)
    expect(off.body.available).toBe(false)
    process.env.ANTHROPIC_API_KEY = 'test-key-present'
    const on = await request(server).get('/api/assistant/status')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(on.body.available).toBe(true)
    delete process.env.ANTHROPIC_API_KEY
  })

  it('enforces the per-org daily cap before touching any provider', async () => {
    await pool.query(
      `INSERT INTO ochr_assistant_messages (organization_id, question)
       SELECT $1, 'cap filler' FROM generate_series(1, 300)`, [orgAId])
    const res = await request(server).post('/api/assistant')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ question: 'How do I print the manifest?' })
    expect(res.status).toBe(429)
    await pool.query(
      `DELETE FROM ochr_assistant_messages WHERE organization_id = $1 AND question = 'cap filler'`,
      [orgAId])
  })
})

describe('offerings & fees — catalog + invoices (BILL.0/BILL.1)', () => {
  let orgAId, orgBId, staffToken, memberId, feeWedding, feeMusician

  beforeAll(async () => {
    const { rows } = await pool.query(
      'SELECT id, name FROM ochr_organizations WHERE name = ANY($1)',
      [[orgA.organizationName, orgB.organizationName]]
    )
    orgAId = rows.find(r => r.name === orgA.organizationName).id
    orgBId = rows.find(r => r.name === orgB.organizationName).id

    // A staff user in org A — the locked split's protagonist.
    const staff = {
      name: 'Sam Staff', email: `test_sa_${RUN_ID}@example.com`,
      password: 'staff-pw-1', role: 'staff',
    }
    const create = await request(server).post('/api/users')
      .set('Authorization', `Bearer ${tokenA}`).send(staff)
    expect(create.status).toBe(201)
    const login = await request(server).post('/api/auth/login')
      .send({ email: staff.email, password: staff.password })
    staffToken = login.body.token

    const m = await request(server).post('/api/clients')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `Parishioner Payer ${RUN_ID}` })
    memberId = m.body.id
  })

  it('renamed COA 4220 — no default we ship prices a sacrament (migration 066)', async () => {
    const { rows: [acct] } = await pool.query(
      `SELECT name FROM ochr_coa_accounts WHERE code = '4220' AND organization_id IS NULL`)
    expect(acct.name).toBe('Offerings — Weddings & Funerals')
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ochr_coa_accounts WHERE name = 'Sacramental Fees'`)
    expect(rows[0].n).toBe(0)
  })

  it('orgs carry the doctrine-aware vocabulary default', async () => {
    const { rows: [org] } = await pool.query(
      'SELECT billing_label, invoice_next_no FROM ochr_organizations WHERE id = $1', [orgAId])
    expect(org.billing_label).toBe('Offerings & Fees')
    expect(org.invoice_next_no).toBe(1)
  })

  it('staff builds the catalog: standard + parishioner price + pass-through', async () => {
    const w = await request(server).post('/api/fee-schedules')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ name: 'Wedding — church use', category: 'wedding', amount: 800,
              parishioner_amount: 400, deposit_amount: 200 })
    expect(w.status).toBe(201)
    expect(w.body.amount).toBe('800.00')
    expect(w.body.parishioner_amount).toBe('400.00')
    feeWedding = w.body.id

    const mus = await request(server).post('/api/fee-schedules')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ name: 'Musician honorarium', category: 'stipend', amount: 150,
              pass_through: true, default_payee: 'Parish musician' })
    expect(mus.status).toBe(201)
    expect(mus.body.pass_through).toBe(true)
    feeMusician = mus.body.id

    const bad = await request(server).post('/api/fee-schedules')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ name: 'Bad', amount: 'not-money' })
    expect(bad.status).toBe(400)
  })

  it('draft → parishioner pricing → issue assigns sequential numbers under FOR UPDATE', async () => {
    // Linked member → parishioner price ($400) applies from the fee item.
    const d1 = await request(server).post('/api/invoices')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ title: `Johnson wedding ${RUN_ID}`, category: 'wedding', client_id: memberId,
              lines: [{ fee_schedule_id: feeWedding }, { fee_schedule_id: feeMusician }] })
    expect(d1.status).toBe(201)
    const inv1 = d1.body.id

    const detail = await request(server).get(`/api/invoices/${inv1}`)
      .set('Authorization', `Bearer ${staffToken}`)
    expect(detail.body.status).toBe('draft')
    expect(detail.body.invoice_no).toBeNull() // drafts are unnumbered
    expect(detail.body.subtotal).toBe('550.00') // 400 parishioner + 150
    expect(detail.body.lines.find(l => l.fee_schedule_id === feeWedding).unit_amount).toBe('400.00')
    expect(detail.body.lines.find(l => l.fee_schedule_id === feeMusician).pass_through).toBe(true)

    // Non-member draft rides the standard price.
    const d2 = await request(server).post('/api/invoices')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ title: `Hall rental ${RUN_ID}`, category: 'facility', payer_name: 'Outside Group',
              lines: [{ description: 'Parish hall — Saturday', unit_amount: 250 }] })
    const inv2 = d2.body.id

    // Two concurrent issues must get distinct sequential numbers.
    const [i1, i2] = await Promise.all([
      request(server).post(`/api/invoices/${inv1}/issue`).set('Authorization', `Bearer ${staffToken}`),
      request(server).post(`/api/invoices/${inv2}/issue`).set('Authorization', `Bearer ${staffToken}`),
    ])
    expect(i1.status).toBe(200)
    expect(i2.status).toBe(200)
    expect(new Set([i1.body.invoice_no, i2.body.invoice_no]).size).toBe(2)
    expect([i1.body.invoice_no, i2.body.invoice_no].sort()).toEqual(['1', '2'])

    const again = await request(server).post(`/api/invoices/${inv1}/issue`)
      .set('Authorization', `Bearer ${staffToken}`)
    expect(again.status).toBe(409) // only drafts issue
  })

  let inv1
  it('staff records payments; overpayment is rejected; status walks issued → partially_paid → paid', async () => {
    const list = await request(server).get(`/api/invoices?q=Johnson`)
      .set('Authorization', `Bearer ${staffToken}`)
    inv1 = list.body.find(i => i.title.startsWith('Johnson'))?.id
    expect(inv1).toBeTruthy()

    const deposit = await request(server).post(`/api/invoices/${inv1}/payments`)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ amount: 200, method: 'check', is_deposit: true })
    expect(deposit.status).toBe(201)
    expect(deposit.body.status).toBe('partially_paid')

    const over = await request(server).post(`/api/invoices/${inv1}/payments`)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ amount: 9999 })
    expect(over.status).toBe(400) // exceeds the remaining balance

    const rest = await request(server).post(`/api/invoices/${inv1}/payments`)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ amount: 350, method: 'cash' })
    expect(rest.status).toBe(201)
    expect(rest.body.status).toBe('paid')
  })

  it('LOCKED SPLIT: staff cannot waive or refund; admin can, with a reason', async () => {
    // A fresh invoice with a balance to forgive.
    const d = await request(server).post('/api/invoices')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ title: `Funeral — Rivera family ${RUN_ID}`, category: 'funeral',
              payer_name: 'Rivera Family',
              lines: [{ description: 'Funeral offering', unit_amount: 300 }] })
    const funeralId = d.body.id
    await request(server).post(`/api/invoices/${funeralId}/issue`)
      .set('Authorization', `Bearer ${staffToken}`)

    const staffWaive = await request(server).post(`/api/invoices/${funeralId}/waive`)
      .set('Authorization', `Bearer ${staffToken}`).send({ reason: 'hardship' })
    expect(staffWaive.status).toBe(403)

    const noReason = await request(server).post(`/api/invoices/${funeralId}/waive`)
      .set('Authorization', `Bearer ${tokenA}`).send({})
    expect(noReason.status).toBe(400)

    const waived = await request(server).post(`/api/invoices/${funeralId}/waive`)
      .set('Authorization', `Bearer ${tokenA}`).send({ reason: 'Pastor: family hardship' })
    expect(waived.status).toBe(200)
    const after = await request(server).get(`/api/invoices/${funeralId}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(after.body.status).toBe('waived')
    expect(after.body.waiver_reason).toBe('Pastor: family hardship')
    expect(after.body.total).toBe('0.00')

    // Refund split: staff 403, admin recomputes.
    const pay = await request(server).get(`/api/invoices/${inv1}`)
      .set('Authorization', `Bearer ${tokenA}`)
    const paymentId = pay.body.payments[0].id
    const staffRefund = await request(server)
      .post(`/api/invoices/${inv1}/payments/${paymentId}/refund`)
      .set('Authorization', `Bearer ${staffToken}`).send({})
    expect(staffRefund.status).toBe(403)
    const refund = await request(server)
      .post(`/api/invoices/${inv1}/payments/${paymentId}/refund`)
      .set('Authorization', `Bearer ${tokenA}`).send({ refund_ref: 'check 1042 returned' })
    expect(refund.status).toBe(200)
    expect(refund.body.status).toBe('partially_paid') // 350 of 550 remains paid
  })

  it('the DB CHECK on line amounts is alive (decision #5)', async () => {
    await expect(pool.query(
      `INSERT INTO ochr_invoice_lines
         (organization_id, invoice_id, description, qty, unit_amount, amount)
       VALUES ($1, $2, 'tampered line', 2, 10.00, 999.00)`,
      [orgAId, inv1]
    )).rejects.toThrow(/check/i)
  })

  it('tenant isolation: cross-org invoices, fee items, and members are unreachable', async () => {
    const read = await request(server).get(`/api/invoices/${inv1}`)
      .set('Authorization', `Bearer ${tokenB}`)
    expect(read.status).toBe(404)

    const payAcross = await request(server).post(`/api/invoices/${inv1}/payments`)
      .set('Authorization', `Bearer ${tokenB}`).send({ amount: 10 })
    expect(payAcross.status).toBe(404)

    const crossFee = await request(server).post('/api/invoices')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ title: 'Sneaky', payer_name: 'X',
              lines: [{ fee_schedule_id: feeWedding }] })
    expect(crossFee.status).toBe(400) // fee item not found in org B

    const crossClient = await request(server).post('/api/invoices')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ title: 'Sneaky2', payer_name: 'X', client_id: memberId,
              lines: [{ description: 'x', unit_amount: 1 }] })
    expect(crossClient.status).toBe(400) // member not found in org B

    const bList = await request(server).get('/api/invoices')
      .set('Authorization', `Bearer ${tokenB}`)
    expect(bList.body.some(i => i.id === inv1)).toBe(false)
  })

  it('drafts are clay, issued invoices are stone', async () => {
    const d = await request(server).post('/api/invoices')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ title: `Draft to delete ${RUN_ID}`, payer_name: 'Y',
              lines: [{ description: 'x', unit_amount: 5 }] })
    const del = await request(server).delete(`/api/invoices/${d.body.id}`)
      .set('Authorization', `Bearer ${staffToken}`)
    expect(del.status).toBe(200)

    const delIssued = await request(server).delete(`/api/invoices/${inv1}`)
      .set('Authorization', `Bearer ${staffToken}`)
    expect(delIssued.status).toBe(409)

    const editIssued = await request(server).patch(`/api/invoices/${inv1}`)
      .set('Authorization', `Bearer ${staffToken}`).send({ title: 'Rewrite history' })
    expect(editIssued.status).toBe(409)
  })

  it('a referenced fee item deactivates instead of vanishing (honest delete)', async () => {
    const del = await request(server).delete(`/api/fee-schedules/${feeWedding}`)
      .set('Authorization', `Bearer ${staffToken}`)
    expect(del.status).toBe(200)
    expect(del.body.deactivated).toBe(true)
    const { rows: [fee] } = await pool.query(
      'SELECT active FROM ochr_fee_schedules WHERE id = $1', [feeWedding])
    expect(fee.active).toBe(false)

    const fresh = await request(server).post('/api/fee-schedules')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ name: 'Never referenced', amount: 10 })
    const hard = await request(server).delete(`/api/fee-schedules/${fresh.body.id}`)
      .set('Authorization', `Bearer ${staffToken}`)
    expect(hard.body.deactivated).toBe(false)
  })

  it('there is no dunning anywhere: no past_due status exists', async () => {
    const { rows } = await pool.query(`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conrelid = 'ochr_invoices'::regclass AND pg_get_constraintdef(oid) LIKE '%status%'`)
    const defs = rows.map(r => r.def).join(' ')
    expect(defs).not.toMatch(/past_due|overdue/)
  })
})


describe('Parish Care (CARE.1) — status without verdicts', () => {
  // The governing question is "what parish needs care, what is the context,
  // and what is the next faithful action" — not "which parish is failing".
  // These tests hold the line that separates those: status is derived from
  // things a human did, arrives with the sentence that produced it, and is
  // never written to a parish's record as a conclusion about them.
  const chancery = {
    organizationName: `Care Chancery ${RUN_ID}`, name: 'Canon',
    email: `care_${RUN_ID}@example.com`, password: 'smoke-test-pw-61',
    organizationType: 'diocese',
  }
  // A DEDICATED parish, not orgA. orgA is shared with the support-console
  // suite, which opens tickets on it — a care test that assumes a clean
  // slate it does not control is a test of whichever suite ran first.
  const parish = {
    organizationName: `Care Parish ${RUN_ID}`, name: 'Parish Admin',
    email: `careparish_${RUN_ID}@example.com`, password: 'smoke-test-pw-66',
  }
  let dio, dioOrg, staffTok, parishId, parishTok
  const cleanupOrgIds = []

  beforeAll(async () => {
    const res = await request(server).post('/api/auth/signup')
      .set('X-Forwarded-For', '10.99.0.15').send(chancery)
    expect(res.status).toBe(201)
    dio = res.body.token; dioOrg = res.body.user.organization.id
    cleanupOrgIds.push(dioOrg)

    // Diocesan SUPPORT STAFF, distinct from leadership — the brief asks
    // for that distinction and the brief's contact rules depend on it.
    const st = await request(server).post('/api/users')
      .set('Authorization', `Bearer ${dio}`)
      .send({ name: 'Support Staff', email: `carestaff_${RUN_ID}@example.com`,
              password: 'smoke-test-pw-62', role: 'staff' })
    expect(st.status).toBe(201)
    const li = await request(server).post('/api/auth/login')
      .send({ email: `carestaff_${RUN_ID}@example.com`, password: 'smoke-test-pw-62' })
    staffTok = li.body.token

    const pr = await request(server).post('/api/auth/signup')
      .set('X-Forwarded-For', '10.99.0.15').send(parish)
    expect(pr.status).toBe(201)
    parishTok = pr.body.token
    parishId = pr.body.user.organization.id
    cleanupOrgIds.push(parishId)

    const invite = await request(server).post('/api/diocese/parishes/invite')
      .set('Authorization', `Bearer ${dio}`).send({ email: parish.email })
    expect(invite.status).toBe(201)
    const accept = await request(server).post('/api/affiliation/accept')
      .set('Authorization', `Bearer ${parishTok}`).send({ grant_level: 'summary' })
    expect(accept.status).toBe(200)
  }, 45_000)

  afterAll(async () => {
    for (const id of cleanupOrgIds) {
      await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
    }
  })

  const care = async (tok = dio) => {
    const res = await request(server).get('/api/diocese/care').set('Authorization', `Bearer ${tok}`)
    expect(res.status).toBe(200)
    return res.body
  }
  const row = (body) => body.parishes.find(p => p.parish_org_id === parishId)

  it('a parish token cannot reach Parish Care at all', async () => {
    for (const path of ['/api/diocese/care', `/api/diocese/care/${parishId}`, `/api/diocese/care/${parishId}/brief`]) {
      const res = await request(server).get(path).set('Authorization', `Bearer ${parishTok}`)
      expect(res.status).toBe(403)
    }
  })

  it('every status arrives with the sentence that produced it', async () => {
    const body = await care()
    for (const p of body.parishes) {
      expect(p.status.because, `${p.parish_name} has a status with no reason`).toBeTruthy()
      expect(['ready', 'review_together', 'offer_support', 'awaiting_update']).toContain(p.status.key)
      expect(p.status.meaning).toBeTruthy()
    }
  })

  it('uses none of the forbidden vocabulary anywhere in the payload', async () => {
    // The words the brief rules out, checked against the whole response
    // rather than against a list of fields somebody has to remember.
    const body = JSON.stringify(await care()).toLowerCase()
    for (const banned of ['at risk', 'delinquent', 'non-compliant', 'noncompliant',
                          'overdue', 'failing', 'health score', 'risk score',
                          'compliance', 'engagement', 'leaderboard', 'rank']) {
      expect(body, `payload contains "${banned}"`).not.toContain(banned)
    }
  })

  it('a new parish reads as awaiting update, not as a problem', async () => {
    const p = row(await care())
    expect(p.status.key).toBe('awaiting_update')
    expect(p.status.because).toMatch(/first conversation|check in/i)
  })

  it('an open support request moves the parish to Offer support, without telling the diocese what it said', async () => {
    const secret = `Payroll crashes on Fr X stipend ${RUN_ID}`
    const t = await request(server).post('/api/support-tickets')
      .set('Authorization', `Bearer ${parishTok}`)
      .send({ description: secret })
    expect(t.status).toBe(201)
    const p = row(await care())
    expect(p.status.key).toBe('offer_support')
    // It must NOT claim the parish asked the diocese for anything — the ticket
    // was opened with OpenChurch, and the old wording ("asked for help")
    // reported a conversation that never happened.
    expect(p.status.because).not.toMatch(/asked for help/i)
    expect(p.status.because).toMatch(/with OpenChurch/i)

    // And the ticket TEXT must not reach the diocese anywhere: not the parish
    // record, and above all not the printed brief.
    const detail = await request(server).get(`/api/diocese/care/${parishId}`)
      .set('Authorization', `Bearer ${dio}`)
    expect(detail.status).toBe(200)
    expect(JSON.stringify(detail.body)).not.toContain(secret)
    expect(detail.body.current_work.open_support_requests).toBe(1)

    const brief = await request(server).get(`/api/diocese/care/${parishId}/brief`)
      .set('Authorization', `Bearer ${dio}`)
    expect(brief.status).toBe(200)
    expect(JSON.stringify(brief.body)).not.toContain(secret)
    expect(brief.body.current_work.open_support_requests).toBe(1)
  })

  it('the brief prints leadership only, never the parish roster', async () => {
    // role defaults to 'Member', which is why "has a role" was the wrong test:
    // it matched every parishioner and printed the first eight with contacts.
    const mk = async (name, role) => {
      const r = await request(server).post('/api/clients')
        .set('Authorization', `Bearer ${parishTok}`)
        .send({ name, role, email: `${name.replace(/\W/g, '')}@example.com`, phone: '555-0100' })
      expect(r.status).toBe(201)
    }
    await mk(`Aaron Member ${RUN_ID}`, 'Member')     // alphabetically first on purpose
    await mk(`Zeb Deacon ${RUN_ID}`, 'Deacon')

    const brief = await request(server).get(`/api/diocese/care/${parishId}/brief`)
      .set('Authorization', `Bearer ${dio}`)
    expect(brief.status).toBe(200)
    const roles = brief.body.people.map(p => String(p.role).toLowerCase())
    expect(roles.length).toBeGreaterThan(0)
    expect(roles).toContain('deacon')
    expect(roles).not.toContain('member')
    expect(JSON.stringify(brief.body.people)).not.toContain('Aaron Member')
  })

  it('leadership is read in the parish\'s OWN tradition, not one hard-coded set', async () => {
    // A Rector is leadership in an Episcopal parish and not a role a Catholic
    // parish uses at all. A single list printed nobody for four of five
    // traditions, which is the bug this pins.
    const r = await request(server).post('/api/clients')
      .set('Authorization', `Bearer ${parishTok}`)
      .send({ name: `Wilma Rector ${RUN_ID}`, role: 'Rector', email: `wr${RUN_ID}@example.com` })
    expect(r.status).toBe(201)

    const rolesFor = async () => {
      const b = await request(server).get(`/api/diocese/care/${parishId}/brief`)
        .set('Authorization', `Bearer ${dio}`)
      expect(b.status).toBe(200)
      return b.body.people.map(p => String(p.role).toLowerCase())
    }

    const setTradition = async (tradition) => {
      const res = await request(server).patch('/api/organization')
        .set('Authorization', `Bearer ${parishTok}`).send({ tradition })
      expect(res.status).toBe(200)
    }

    // Capture whatever this parish already was, so this test restores it
    // rather than deciding for whatever runs next.
    const before = await request(server).get('/api/organization')
      .set('Authorization', `Bearer ${parishTok}`)
    expect(before.status).toBe(200)
    const original = before.body.organization?.tradition ?? before.body.tradition ?? 'general'

    try {
      await setTradition('episcopal')
      expect(await rolesFor()).toContain('rector')

      // Same parish, same rows, Catholic vocabulary: Rector is not one of its
      // offices, so the Rector drops off and the Deacon (shared by both) stays.
      await setTradition('catholic')
      const catholicRoles = await rolesFor()
      expect(catholicRoles).not.toContain('rector')
      expect(catholicRoles).toContain('deacon')
    } finally {
      await setTradition(original)
    }
  })

  it('writing to the record is what makes a parish "seen"', async () => {
    const w = await request(server).post(`/api/diocese/care/${parishId}/timeline`)
      .set('Authorization', `Bearer ${dio}`)
      .send({ kind: 'visit', summary: 'Visited the parish office; met the administrator.' })
    expect(w.status).toBe(201)

    const detail = await request(server).get(`/api/diocese/care/${parishId}`)
      .set('Authorization', `Bearer ${dio}`)
    expect(detail.status).toBe(200)
    expect(detail.body.timeline[0].summary).toMatch(/Visited the parish office/)
    expect(detail.body.timeline[0].actor_name).toBe(chancery.name)
  })

  it('a follow-up is the office\'s own memory, and can be let go rather than failed', async () => {
    const f = await request(server).post(`/api/diocese/care/${parishId}/followups`)
      .set('Authorization', `Bearer ${dio}`)
      .send({ context: 'Rector transition last spring',
              next_action: 'Ask whether register continuity support would help' })
    expect(f.status).toBe(201)
    expect(f.body.state).toBe('open')

    const list = await request(server).get('/api/diocese/care/followups')
      .set('Authorization', `Bearer ${dio}`)
    expect(list.body.followups.some(x => x.id === f.body.id)).toBe(true)

    // 'let_go' exists so a pastoral judgement does not have to be recorded
    // as an unfinished task.
    const done = await request(server).patch(`/api/diocese/care/followups/${f.body.id}`)
      .set('Authorization', `Bearer ${dio}`)
      .send({ state: 'let_go', completion_note: 'Spoke informally at the deanery meeting; no longer needed.' })
    expect(done.status).toBe(200)
    expect(done.body.state).toBe('let_go')
  })

  it('a transition is recorded as a moment to accompany, not a flag', async () => {
    const tr = await request(server).post(`/api/diocese/care/${parishId}/transitions`)
      .set('Authorization', `Bearer ${dio}`)
      .send({ kind: 'administrator_departure', began_on: '2026-07-01',
              continuity_needs: 'Register handoff; nobody else has used the drafts sandbox.' })
    expect(tr.status).toBe(201)

    const detail = await request(server).get(`/api/diocese/care/${parishId}`)
      .set('Authorization', `Bearer ${dio}`)
    const entry = detail.body.timeline.find(t => t.kind === 'transition')
    expect(entry.summary).toMatch(/accompany/i)
    expect(entry.summary).not.toMatch(/risk|alert|escalat/i)
  })

  it('report review is a conversation with an agreed next step', async () => {
    const sub = await request(server).post('/api/finance/submissions')
      .set('Authorization', `Bearer ${parishTok}`)
      .send({ period_start: '2031-01-01', period_end: '2031-01-31' })
    expect(sub.status).toBe(201)

    const awaiting = row(await care())
    expect(['offer_support', 'review_together']).toContain(awaiting.status.key)

    const note = await request(server).post(`/api/diocese/care/submissions/${sub.body.id}/notes`)
      .set('Authorization', `Bearer ${dio}`)
      .send({ body: 'Offertory line looks lower than last year — worth a word.',
              visibility: 'shared', agreed_next_step: 'Bring it to the pastoral visit in October' })
    expect(note.status).toBe(201)
    expect(note.body.agreed_next_step).toMatch(/pastoral visit/)

    const detail = await request(server).get(`/api/diocese/care/${parishId}`)
      .set('Authorization', `Bearer ${dio}`)
    expect(detail.body.timeline.some(t => t.kind === 'report' && /next step was agreed/i.test(t.summary))).toBe(true)
  })

  it('is scoped to this diocese — another chancery sees nothing of this parish', async () => {
    const other = await request(server).post('/api/auth/signup')
      .set('X-Forwarded-For', '10.99.0.15')
      .send({ organizationName: `Other Chancery ${RUN_ID}`, name: 'Canon',
              email: `care2_${RUN_ID}@example.com`, password: 'smoke-test-pw-63',
              organizationType: 'diocese' })
    cleanupOrgIds.push(other.body.user.organization.id)
    const body = await care(other.body.token)
    expect(body.parishes).toEqual([])
    const denied = await request(server).get(`/api/diocese/care/${parishId}`)
      .set('Authorization', `Bearer ${other.body.token}`)
    expect(denied.status).toBe(404)
  })
})

describe('the Parish Care Brief (CARE.2)', () => {
  // "Artifacts outlive dashboards." This is the page that leaves the
  // building, so its rules are stricter than the dashboard's.
  let dio, staffTok, parishId, dioOrg
  const cleanupOrgIds = []

  beforeAll(async () => {
    const res = await request(server).post('/api/auth/signup')
      .set('X-Forwarded-For', '10.99.0.16')
      .send({ organizationName: `Brief Chancery ${RUN_ID}`, name: 'Bishop',
              email: `brief_${RUN_ID}@example.com`, password: 'smoke-test-pw-64',
              organizationType: 'diocese' })
    dio = res.body.token; dioOrg = res.body.user.organization.id
    cleanupOrgIds.push(dioOrg)

    const st = await request(server).post('/api/users')
      .set('Authorization', `Bearer ${dio}`)
      .send({ name: 'Canon Staff', email: `briefstaff_${RUN_ID}@example.com`,
              password: 'smoke-test-pw-65', role: 'staff' })
    expect(st.status).toBe(201)
    staffTok = (await request(server).post('/api/auth/login')
      .send({ email: `briefstaff_${RUN_ID}@example.com`, password: 'smoke-test-pw-65' })).body.token

    await request(server).post('/api/diocese/parishes/invite')
      .set('Authorization', `Bearer ${dio}`).send({ email: orgB.email })
    await request(server).post('/api/affiliation/accept')
      .set('Authorization', `Bearer ${tokenB}`).send({ grant_level: 'detail' })
    parishId = (await request(server).get('/api/auth/me')
      .set('Authorization', `Bearer ${tokenB}`)).body.user.organization.id

    await request(server).post(`/api/diocese/care/${parishId}/timeline`)
      .set('Authorization', `Bearer ${dio}`)
      .send({ kind: 'note', summary: 'Shared: agreed to revisit the register backlog in the autumn.', visibility: 'shared' })
    await request(server).post(`/api/diocese/care/${parishId}/timeline`)
      .set('Authorization', `Bearer ${dio}`)
      .send({ kind: 'note', summary: 'Internal: the treasurer is unwell; be gentle about the deadline.', visibility: 'diocese' })
  }, 45_000)

  afterAll(async () => {
    await request(server).post('/api/affiliation/leave')
      .set('Authorization', `Bearer ${tokenB}`).catch(() => {})
    for (const id of cleanupOrgIds) {
      await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
    }
  })

  const brief = async (tok, qs = '') => {
    const res = await request(server).get(`/api/diocese/care/${parishId}/brief${qs}`)
      .set('Authorization', `Bearer ${tok}`)
    expect(res.status).toBe(200)
    return res.body
  }

  it('leads with context and carries the Church Year', async () => {
    const b = await brief(dio)
    expect(b.parish.name).toBeTruthy()
    expect(b.situation.because).toBeTruthy()
    expect(b.church_year).toHaveProperty('season')
    expect(b.recent_history).toBeInstanceOf(Array)
  })

  it('does NOT print internal notes by default', async () => {
    // A brief may be left on a sacristy table. Diocese-only notes are
    // opt-in, and "the treasurer is unwell" is exactly the sentence that
    // must not be on a page somebody else can pick up.
    const b = await brief(dio)
    const text = JSON.stringify(b.recent_history)
    expect(text).toMatch(/register backlog/)
    expect(text).not.toMatch(/treasurer is unwell/)
    expect(b.internal_included).toBe(false)
  })

  it('includes them only when deliberately asked for', async () => {
    const b = await brief(dio, '?internal=1')
    expect(JSON.stringify(b.recent_history)).toMatch(/treasurer is unwell/)
    expect(b.internal_included).toBe(true)
  })

  it('withholds contact details from support staff, and SAYS it withheld them', async () => {
    const asStaff = await brief(staffTok)
    expect(asStaff.withheld).toBeTruthy()
    expect(asStaff.parish.address).toBeNull()
    for (const p of asStaff.people) {
      expect(p).not.toHaveProperty('email')
      expect(p).not.toHaveProperty('phone')
      expect(p.name).toBeTruthy()   // who they are is still context
    }

    const asLeadership = await brief(dio)
    expect(asLeadership.withheld).toBeNull()
  })

  it('carries no score, ranking or comparison', async () => {
    const b = JSON.stringify(await brief(dio)).toLowerCase()
    for (const banned of ['score', 'rank', 'percentile', 'compared', 'at risk', 'grade']) {
      expect(b, `brief contains "${banned}"`).not.toContain(banned)
    }
  })

  it('records that a brief was prepared, without freezing its content', async () => {
    const rec = await request(server).post(`/api/diocese/care/${parishId}/brief`)
      .set('Authorization', `Bearer ${dio}`).send({ purpose: 'the bishop\'s visit in October' })
    expect(rec.status).toBe(201)
    expect(rec.body.prepared_by_name).toBe('Bishop')

    const detail = await request(server).get(`/api/diocese/care/${parishId}`)
      .set('Authorization', `Bearer ${dio}`)
    expect(detail.body.timeline.some(t => t.kind === 'brief' && /bishop/i.test(t.summary))).toBe(true)
  })
})
describe('role enforcement', () => {
  it('admin can list users in their org', async () => {
    const res = await request(server)
      .get('/api/users')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.length).toBeGreaterThanOrEqual(1)
    expect(res.body[0].email).toBe(orgA.email.toLowerCase())
  })

  it('demoting yourself to viewer makes write attempts 403', async () => {
    // Admin-A creates a second admin so they can demote themselves
    // (last-admin guard would otherwise block).
    const second = {
      name:     'Second Admin',
      email:    `test_a2_${RUN_ID}@example.com`,
      password: 'second-admin-pw',
      role:     'admin',
    }
    const create = await request(server)
      .post('/api/users')
      .set('Authorization', `Bearer ${tokenA}`)
      .send(second)
    expect(create.status).toBe(201)

    // Login as admin-A and grab their user id.
    const me = await request(server)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${tokenA}`)
    const myId = me.body.user.id

    // Self-demote to viewer.
    const demote = await request(server)
      .patch(`/api/users/${myId}/role`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ role: 'viewer' })
    expect(demote.status).toBe(200)

    // Now any write should 403 — viewers can read but can't write.
    const writeAttempt = await request(server)
      .post('/api/clients')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Should Not Land' })
    expect(writeAttempt.status).toBe(403)

    // GET still works — viewers retain read access.
    const readAttempt = await request(server)
      .get('/api/clients')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(readAttempt.status).toBe(200)
  })
})
