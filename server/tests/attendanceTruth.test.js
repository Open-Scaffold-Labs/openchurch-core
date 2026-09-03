// Attendance is people, not rows.
//
// THE DEFECT THIS PROTECTS, reproduced on 1 Sep before anything changed:
// a Sunday service with three people present reported `attendance: 8` on
// GET /api/checkins/recent and an ASA of 8 on the parochial report. Nothing
// had failed. A member had been checked out and checked back in (two rows,
// one person — the active-row index only forbids two rows at ONCE), and a
// volunteer had tapped the guest button several times. Every row was a
// correct record of a real check-in. The COUNT over them was a false fact
// about how many people were at worship, and the parochial report calls
// that figure 'verified'.
//
// WHAT WOULD MAKE THESE FAIL: putting `count(*)` back in any of the four
// places DISTINCT_PEOPLE now stands — the ASA and Christmas fields in
// reporting/definitions.js, the Easter query in reporting/run.js, and the
// /recent report in routes/checkins.js. Each was mutated back in turn and
// the matching test below went red.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'
import jwt from 'jsonwebtoken'

import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'

let server, orgId, token, memberA, memberB

const auth = req => req.set('Authorization', `Bearer ${token}`)

// A Sunday, a 24 December, an Easter Day — all inside 2024 so one report
// window covers them. Easter 2024 was 31 March (a Sunday, as it must be).
const SUNDAY    = '2024-06-09'
const CHRISTMAS = '2024-12-24'
const EASTER    = '2024-03-31'

async function service(date) {
  const { rows } = await pool.query(
    `INSERT INTO ochr_calendar_events (organization_id, title, date, start_time, end_time, type)
     VALUES ($1, $2, $3, '10:00', '11:00', 'service') RETURNING id`,
    [orgId, `Service ${date} ${RUN_ID}`, date])
  return rows[0].id
}

async function checkin(eventId, body) {
  const res = await auth(request(server).post('/api/checkins')).send({ calendar_event_id: eventId, ...body })
  expect([200, 201]).toContain(res.status)
  return res.body
}

async function checkout(id) {
  const res = await auth(request(server).post(`/api/checkins/${id}/checkout`)).send({})
  expect(res.status).toBe(200)
}

async function report() {
  const res = await auth(request(server).get('/api/reports/parochial-report?start=2024-01-01&end=2024-12-31'))
  expect(res.status).toBe(200)
  const field = key => res.body.fields.find(f => f.key === key)
  return { asa: field('asa').value, christmas: field('christmas_attendance').value, easter: field('easter_attendance').value }
}

// Three people at one service, five rows: A checked out and returned (2
// rows), B once (1), and the guest button tapped twice for two different
// guests (2). The truthful count is 4 people — A, B, and two guests, whom
// nothing can tell apart and so must each count.
async function threePeopleFiveRows(eventId) {
  const a1 = await checkin(eventId, { client_id: memberA })
  await checkout(a1.id)
  await checkin(eventId, { client_id: memberA })          // A is back: a second row, the same person
  await checkin(eventId, { client_id: memberB })
  await checkin(eventId, { person_name: 'Guest One', kind: 'guest' })
  await checkin(eventId, { person_name: 'Guest Two', kind: 'guest' })
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM ochr_checkins WHERE calendar_event_id = $1', [eventId])
  expect(rows[0].n).toBe(5)                                // the CONTROL: five rows really exist
}

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  const o = await pool.query(
    `INSERT INTO ochr_organizations (name, slug, org_type, tradition)
     VALUES ($1, $2, 'parish', 'episcopal') RETURNING id`,
    [`AT Parish ${RUN_ID}`, `at-par-${RUN_ID}`])
  orgId = o.rows[0].id
  const u = await pool.query(
    `INSERT INTO ochr_users (organization_id, name, email, password_hash, role)
     VALUES ($1, 'AT Admin', $2, 'x', 'admin') RETURNING id, token_version`,
    [orgId, `at_${RUN_ID}@example.com`])
  token = jwt.sign(
    { userId: u.rows[0].id, organizationId: orgId, role: 'admin', tv: u.rows[0].token_version },
    process.env.JWT_SECRET, { expiresIn: '1h' })
  const m = await pool.query(
    `INSERT INTO ochr_clients (organization_id, name) VALUES ($1, 'Alma Attends'), ($1, 'Ben Attends') RETURNING id`,
    [orgId])
  ;[memberA, memberB] = m.rows.map(r => r.id)
}, 60_000)

afterAll(async () => {
  await pool.query('DELETE FROM ochr_checkins WHERE organization_id = $1', [orgId])
  await pool.query('DELETE FROM ochr_calendar_events WHERE organization_id = $1', [orgId])
  await pool.query('DELETE FROM ochr_clients WHERE organization_id = $1', [orgId])
  await pool.query('DELETE FROM ochr_users WHERE organization_id = $1', [orgId])
  await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [orgId])
  await closeServer(server)
  await pool.end()
})

describe('attendance counts people, not check-in rows', () => {
  it('a member who checked out and came back is one person on the attendance report', async () => {
    const ev = await service(SUNDAY)
    await threePeopleFiveRows(ev)
    const res = await auth(request(server).get('/api/checkins/recent?days=36500'))
    expect(res.status).toBe(200)
    const row = res.body.services.find(s => s.event_id === ev)
    expect(row).toBeTruthy()
    expect(row.attendance).toBe(4)   // was 5: the returning member counted twice
  }, 30_000)

  it('the parochial report ASA is a mean of people, and the same person is not two people', async () => {
    // The Sunday above already holds 4 people. A second Sunday with one
    // person (2 rows) makes the mean unambiguous: (4 + 1) / 2 = 2.5.
    const ev = await service('2024-06-16')
    const a1 = await checkin(ev, { client_id: memberA })
    await checkout(a1.id)
    await checkin(ev, { client_id: memberA })
    const { asa } = await report()
    expect(asa).toBe(2.5)            // was (5 + 2) / 2 = 3.5
  }, 30_000)

  it('Christmas and Easter attendance count people the same way', async () => {
    await threePeopleFiveRows(await service(CHRISTMAS))
    await threePeopleFiveRows(await service(EASTER))
    const { christmas, easter } = await report()
    expect(christmas).toBe(4)        // was 5
    expect(easter).toBe(4)           // was 5
  }, 30_000)

  it('one person at the 8am AND the 10am is attendance at two services — people are distinct PER service', async () => {
    // Self-challenge from the pass that added DISTINCT_PEOPLE: the first
    // version grouped by date, which would have silently changed what the
    // report measures. The parochial figures sum per-service attendance;
    // somebody who worships twice on a Sunday is counted at each service.
    const early = await service('2024-06-30')
    const late  = await service('2024-06-30')
    await checkin(early, { client_id: memberB })
    await checkin(late,  { client_id: memberB })
    const l1 = await checkin(late, { client_id: memberA })
    await checkout(l1.id)
    await checkin(late, { client_id: memberA })             // twice at ONE service: once
    const res = await auth(request(server).get('/api/checkins/recent?days=36500'))
    const byId = Object.fromEntries(res.body.services.map(s => [s.event_id, s.attendance]))
    expect(byId[early]).toBe(1)
    expect(byId[late]).toBe(2)
    // ASA over the four Sundays now on file: 4, 1, (Guest-only Sunday below is
    // added after this test), and this one at 1 + 2 = 3 → checked at the end.
  }, 30_000)

  it('two different guests are still two people — a guest carries nothing to collapse on', async () => {
    const ev = await service('2024-06-23')
    await checkin(ev, { person_name: 'Smith family', kind: 'guest' })
    await checkin(ev, { person_name: 'Smith family', kind: 'guest' })
    const res = await auth(request(server).get('/api/checkins/recent?days=36500'))
    const row = res.body.services.find(s => s.event_id === ev)
    expect(row.attendance).toBe(2)
  }, 30_000)

  it('the ASA is the mean of per-Sunday sums of per-service distinct people', async () => {
    // Sundays on file: Easter 03-31 → 4 (Easter Day is a Sunday, so it is in
    // the mean); 06-09 → 4; 06-16 → 1; 06-23 → 2 guests; 06-30 → 1 + 2 = 3.
    const { asa } = await report()
    expect(asa).toBe(2.8)   // (4 + 4 + 1 + 2 + 3) / 5
  }, 30_000)
})
