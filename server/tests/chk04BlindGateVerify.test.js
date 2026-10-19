// Independent CHK-04 merge-gate fixture (PR #57 blind verify).
//
// Not the author's chk04AttendedStamps.test.js. This file is a single
// parish chronology: T0 Mass → check-in → mutate live Schedule → T1.
// Dates are 2041 Sundays so they cannot collide with the author's 2033
// fixtures if both files share one database.
//
// What OpenChurch may claim after the live Mass changes:
//   - Schedule fields (GET /api/calendar/:id) may change.
//   - attended_* stay what was true at check-in, or stay NULL if never
//     stamped. Never invent from today's calendar.
//   - A Mass with attendance is 409, not deleted.
//   - Same-title same-day Masses stay distinct identities.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'

const here = dirname(fileURLToPath(import.meta.url))
const src = name => readFileSync(join(here, '..', 'src', name), 'utf8')

const FX = `GATE57 ${RUN_ID}`
const T0_DATE = '2041-03-03' // Sunday
const T1_DATE = '2041-03-10' // Sunday, after the move
const DUP_DATE = '2041-04-07' // Sunday
const T0_TITLE = `Dawn Mass ${FX}`
const T1_TITLE = `Solemn Vespers ${FX}`
const T0_TIME = '07:30'
const T1_TIME = '18:00'

let server
let token
let orgId
const fx = {}

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  const parish = await createOrg(server, {
    organizationName: `Blind Gate Parish ${FX}`,
    name: 'Rosa Admin',
    email: `gate57_blind_${RUN_ID}@example.com`,
    password: 'gate57-blind-pw-1',
    tradition: 'catholic',
  })
  expect(parish.status).toBe(201)
  token = parish.body.token
  orgId = parish.body.user.organization.id
}, 60_000)

afterAll(async () => {
  await closeServer(server)
  await pool.end()
})

const auth = { get Authorization() { return `Bearer ${token}` } }

function hhmm(value) {
  if (value == null) return null
  const s = String(value)
  return s.length >= 5 ? s.slice(0, 5) : s
}

async function makeMass(body) {
  return request(server).post('/api/calendar').set(auth).send({
    title: body.title,
    date: body.date,
    start_time: body.start_time || '09:00',
    end_time: body.end_time || '10:00',
    type: 'service',
  })
}

async function mutateMass(id, body) {
  return request(server).patch(`/api/calendar/${id}`).set(auth).send({
    title: body.title,
    date: body.date,
    start_time: body.start_time || '09:00',
    end_time: body.end_time || '10:00',
    type: 'service',
    assigned_to: [],
  })
}

async function sqlStamps(checkinId) {
  const { rows } = await pool.query(
    `SELECT to_char(attended_date, 'YYYY-MM-DD') AS attended_date,
            attended_title,
            to_char(attended_time, 'HH24:MI') AS attended_time,
            calendar_event_id, person_name, client_id
       FROM ochr_checkins
      WHERE id = $1 AND organization_id = $2`,
    [checkinId, orgId]
  )
  return rows[0] || null
}

// ASA as the report definition computes it. The HTTP parochial report is
// Episcopal-only; a Catholic parish 404s on purpose (no invented Status
// Animarum). The historical-truth claim is this SQL: stamped Sunday, or
// nothing — never e.date from a live JOIN.
async function asaSql(start, end, organizationId = orgId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(ROUND(AVG(n)::numeric, 1), 0)::float8 AS value
       FROM (
         SELECT date, SUM(n) AS n
           FROM (
             SELECT ck.attended_date AS date, ck.calendar_event_id AS id,
                    count(DISTINCT COALESCE(ck.client_id::text, 'row:' || ck.id::text))::int AS n
               FROM ochr_checkins ck
              WHERE ck.organization_id = $1
                AND ck.attended_date IS NOT NULL
                AND ck.attended_date >= $2 AND ck.attended_date <= $3
                AND EXTRACT(DOW FROM ck.attended_date) = 0
              GROUP BY ck.attended_date, ck.calendar_event_id
           ) per_service
          GROUP BY date
       ) per_sunday`,
    [organizationId, start, end]
  )
  return Number(rows[0].value)
}

describe('CHK-04 blind gate — catalog and no invent-backfill in 103', () => {
  it('attended_* exist as nullable, default-less columns; 103 never UPDATEs', async () => {
    const { rows } = await pool.query(
      `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'ochr_checkins'
          AND column_name IN ('attended_date', 'attended_title', 'attended_time')
        ORDER BY column_name`
    )
    const by = Object.fromEntries(rows.map(r => [r.column_name, r]))
    expect(by.attended_date.data_type).toBe('date')
    expect(by.attended_title.data_type).toBe('text')
    expect(by.attended_time.data_type).toBe('time without time zone')
    for (const name of ['attended_date', 'attended_title', 'attended_time']) {
      expect(by[name].is_nullable).toBe('YES')
      expect(by[name].column_default).toBeNull()
    }

    const mig = src('migrations/103-attended-service-stamps.js')
    expect(mig).not.toMatch(/UPDATE\s+ochr_checkins/i)
    expect(mig).not.toMatch(/COALESCE\s*\(/i)
    expect(mig).not.toMatch(/SET\s+attended_/i)
    expect(src('routes/calendar.js')).not.toMatch(/UPDATE\s+ochr_checkins/i)
    expect(src('routes/calendar.js')).not.toMatch(/attended_title|attended_date|attended_time/)
  })
})

describe('CHK-04 blind gate — T0 attend, mutate Schedule, T1 stamps hold', () => {
  it('T0: Mass exists with known title/date/time', async () => {
    const mass = await makeMass({ title: T0_TITLE, date: T0_DATE, start_time: T0_TIME, end_time: '08:30' })
    expect(mass.status).toBe(201)
    fx.massId = mass.body.id

    const live = await request(server).get(`/api/calendar/${fx.massId}`).set(auth)
    expect(live.status).toBe(200)
    expect(live.body.title).toBe(T0_TITLE)
    expect(live.body.date).toBe(T0_DATE)
    expect(hhmm(live.body.start_time)).toBe(T0_TIME)
    fx.t0Live = { title: live.body.title, date: live.body.date, time: hhmm(live.body.start_time) }
  })

  it('Action: check-in stamps from the org-scoped Mass, not the request body', async () => {
    const member = await request(server).post('/api/clients').set(auth)
      .send({ name: `Rosa ${FX}`, status: 'active', role: 'Member' })
    expect(member.status).toBe(201)
    fx.memberId = member.body.id

    const row = await request(server).post('/api/checkins').set(auth).send({
      calendar_event_id: fx.massId,
      client_id: fx.memberId,
      kind: 'member',
      attended_title: 'Invented from the client',
      attended_date: '1999-12-31',
      attended_time: '00:00',
      title: 'Client label',
    })
    expect(row.status).toBe(201)
    fx.checkinId = row.body.id
    expect(row.body.attended_title).toBe(T0_TITLE)
    expect(row.body.attended_date).toBe(T0_DATE)
    expect(row.body.attended_time).toBe(T0_TIME)
    expect(row.body.attended_title).not.toBe('Invented from the client')

    const stored = await sqlStamps(fx.checkinId)
    expect(stored.attended_title).toBe(T0_TITLE)
    expect(stored.attended_date).toBe(T0_DATE)
    expect(stored.attended_time).toBe(T0_TIME)
    expect(Number(stored.calendar_event_id)).toBe(Number(fx.massId))
    fx.t0Stamps = stored
  })

  it('Mutate: live Schedule rename / retime / move succeeds', async () => {
    const patched = await mutateMass(fx.massId, {
      title: T1_TITLE,
      date: T1_DATE,
      start_time: T1_TIME,
      end_time: '19:00',
    })
    expect(patched.status).toBe(200)

    const live = await request(server).get(`/api/calendar/${fx.massId}`).set(auth)
    expect(live.status).toBe(200)
    expect(live.body.title).toBe(T1_TITLE)
    expect(live.body.date).toBe(T1_DATE)
    expect(hhmm(live.body.start_time)).toBe(T1_TIME)
    fx.t1Live = { title: live.body.title, date: live.body.date, time: hhmm(live.body.start_time) }
    expect(fx.t1Live).not.toEqual(fx.t0Live)
  })

  it('T1: recorded stamps stay T0; live JOIN is not substituted on any read path', async () => {
    const stored = await sqlStamps(fx.checkinId)
    expect(stored.attended_title).toBe(T0_TITLE)
    expect(stored.attended_date).toBe(T0_DATE)
    expect(stored.attended_time).toBe(T0_TIME)
    expect(stored.attended_title).not.toBe(T1_TITLE)
    expect(stored.attended_date).not.toBe(T1_DATE)
    expect(stored.attended_time).not.toBe(T1_TIME)
    expect(Number(stored.calendar_event_id)).toBe(Number(fx.massId))

    const listed = await request(server).get(`/api/checkins?event_id=${fx.massId}`).set(auth)
    expect(listed.status).toBe(200)
    const listedRow = listed.body.checkins.find(c => c.id === fx.checkinId)
    expect(listedRow.attended_title).toBe(T0_TITLE)
    expect(listedRow.attended_date).toBe(T0_DATE)
    expect(listedRow.attended_time).toBe(T0_TIME)

    const recent = await request(server).get('/api/checkins/recent?days=36500').set(auth)
    expect(recent.status).toBe(200)
    const svc = recent.body.services.find(s => s.event_id === fx.massId)
    expect(svc).toBeTruthy()
    expect(svc.title).toBe(T0_TITLE)
    expect(svc.date).toBe(T0_DATE)
    expect(svc.time).toBe(T0_TIME)
    expect(svc.title).not.toBe(T1_TITLE)
    expect(svc.date).not.toBe(T1_DATE)

    const history = await request(server).get(`/api/clients/${fx.memberId}/checkins`).set(auth)
    expect(history.status).toBe(200)
    const hist = history.body.checkins.find(c => c.id === fx.checkinId)
    expect(hist.event_title).toBe(T0_TITLE)
    expect(hist.event_date).toBe(T0_DATE)
    expect(hist.attended_time).toBe(T0_TIME)
    expect(hist.event_title).not.toBe(T1_TITLE)

    expect(await asaSql(T0_DATE, T0_DATE)).toBeGreaterThan(0)
    expect(await asaSql(T1_DATE, T1_DATE)).toBe(0)

    const missingReport = await request(server)
      .get(`/api/reports/parochial-report?start=${T0_DATE}&end=${T1_DATE}`)
      .set(auth)
    expect(missingReport.status).toBe(404)
    expect(missingReport.body.error).toMatch(/catholic/i)
  })

  it('Episcopal HTTP ASA also dates the person from the stamp, not the live Mass', async () => {
    const episcopal = await createOrg(server, {
      organizationName: `Blind Gate Episcopal ${FX}`,
      name: 'Bea Admin',
      email: `gate57_episcopal_${RUN_ID}@example.com`,
      password: 'gate57-blind-pw-2',
      tradition: 'episcopal',
    })
    expect(episcopal.status).toBe(201)
    const eAuth = { Authorization: `Bearer ${episcopal.body.token}` }
    const eOrg = episcopal.body.user.organization.id

    const mass = await request(server).post('/api/calendar').set(eAuth).send({
      title: `Episcopal Dawn ${FX}`,
      date: T0_DATE,
      start_time: T0_TIME,
      end_time: '08:30',
      type: 'service',
    })
    expect(mass.status).toBe(201)
    const member = await request(server).post('/api/clients').set(eAuth)
      .send({ name: `Bea ${FX}`, status: 'active', role: 'Member' })
    const row = await request(server).post('/api/checkins').set(eAuth).send({
      calendar_event_id: mass.body.id,
      client_id: member.body.id,
      kind: 'member',
    })
    expect(row.status).toBe(201)

    const moved = await request(server).patch(`/api/calendar/${mass.body.id}`).set(eAuth).send({
      title: `Episcopal Vespers ${FX}`,
      date: T1_DATE,
      start_time: T1_TIME,
      end_time: '19:00',
      type: 'service',
      assigned_to: [],
    })
    expect(moved.status).toBe(200)

    const t0 = await request(server)
      .get(`/api/reports/parochial-report?start=${T0_DATE}&end=${T0_DATE}`)
      .set(eAuth)
    const t1 = await request(server)
      .get(`/api/reports/parochial-report?start=${T1_DATE}&end=${T1_DATE}`)
      .set(eAuth)
    expect(t0.status).toBe(200)
    expect(t1.status).toBe(200)
    expect(t0.body.fields.find(f => f.key === 'asa').value).toBeGreaterThan(0)
    expect(t1.body.fields.find(f => f.key === 'asa').value).toBe(0)
    expect(await asaSql(T0_DATE, T0_DATE, eOrg)).toBeGreaterThan(0)
    expect(await asaSql(T1_DATE, T1_DATE, eOrg)).toBe(0)
  })
})

describe('CHK-04 blind gate — legacy NULL is unknown, not a live JOIN', () => {
  it('a pre-stamp row stays NULL after the live Mass is renamed, and ASA excludes it', async () => {
    const mass = await makeMass({
      title: `Legacy Live ${FX}`,
      date: '2041-05-05',
      start_time: '09:00',
    })
    expect(mass.status).toBe(201)
    const member = await request(server).post('/api/clients').set(auth)
      .send({ name: `Legacy ${FX}`, status: 'active', role: 'Member' })
    expect(member.status).toBe(201)

    const inserted = await pool.query(
      `INSERT INTO ochr_checkins
         (organization_id, calendar_event_id, client_id, person_name, kind)
       VALUES ($1, $2, $3, $4, 'member')
       RETURNING id, attended_date, attended_title, attended_time`,
      [orgId, mass.body.id, member.body.id, `Legacy ${FX}`]
    )
    expect(inserted.rows[0].attended_date).toBeNull()
    expect(inserted.rows[0].attended_title).toBeNull()
    expect(inserted.rows[0].attended_time).toBeNull()
    const id = inserted.rows[0].id

    const renamed = await mutateMass(mass.body.id, {
      title: `Legacy Renamed ${FX}`,
      date: '2041-05-12',
      start_time: '11:00',
      end_time: '12:00',
    })
    expect(renamed.status).toBe(200)

    const live = await request(server).get(`/api/calendar/${mass.body.id}`).set(auth)
    expect(live.body.title).toBe(`Legacy Renamed ${FX}`)
    expect(live.body.date).toBe('2041-05-12')

    const stored = await sqlStamps(id)
    expect(stored.attended_title).toBeNull()
    expect(stored.attended_date).toBeNull()
    expect(stored.attended_time).toBeNull()

    const recent = await request(server).get('/api/checkins/recent?days=36500').set(auth)
    const svc = recent.body.services.find(s => s.event_id === mass.body.id && s.title == null)
    expect(svc).toBeTruthy()
    expect(svc.title).toBeNull()
    expect(svc.date).toBeNull()
    expect(svc.title).not.toBe(`Legacy Renamed ${FX}`)
    expect(svc.title).not.toBe(`Legacy Live ${FX}`)

    const history = await request(server).get(`/api/clients/${member.body.id}/checkins`).set(auth)
    const hist = history.body.checkins.find(c => c.id === id)
    expect(hist.event_title).toBeNull()
    expect(hist.event_date).toBeNull()
    expect(hist.event_title).not.toBe(live.body.title)

    // NULL ≠ live Sunday. ASA must not date this row from today's Schedule.
    expect(await asaSql('2041-05-12', '2041-05-12')).toBe(0)
    expect(await asaSql('2041-05-05', '2041-05-05')).toBe(0)
  })
})

describe('CHK-04 blind gate — duplicate Mass identity and CHK-05', () => {
  it('same-day same-title Masses bind attendance by calendar_event_id', async () => {
    const a = await makeMass({ title: `Sunday Mass ${FX}`, date: DUP_DATE, start_time: '08:00', end_time: '09:00' })
    const b = await makeMass({ title: `Sunday Mass ${FX}`, date: DUP_DATE, start_time: '08:00', end_time: '09:00' })
    expect(a.status).toBe(201)
    expect(b.status).toBe(201)
    expect(a.body.id).not.toBe(b.body.id)

    const early = await request(server).post('/api/checkins').set(auth)
      .send({ calendar_event_id: a.body.id, person_name: `Early ${FX}`, kind: 'guest' })
    const late = await request(server).post('/api/checkins').set(auth)
      .send({ calendar_event_id: b.body.id, person_name: `Late ${FX}`, kind: 'guest' })
    expect(early.status).toBe(201)
    expect(late.status).toBe(201)

    expect(early.body.attended_title).toBe(`Sunday Mass ${FX}`)
    expect(late.body.attended_title).toBe(`Sunday Mass ${FX}`)
    expect(early.body.attended_date).toBe(DUP_DATE)
    expect(Number(early.body.calendar_event_id)).toBe(Number(a.body.id))
    expect(Number(late.body.calendar_event_id)).toBe(Number(b.body.id))

    const listA = await request(server).get(`/api/checkins?event_id=${a.body.id}`).set(auth)
    const listB = await request(server).get(`/api/checkins?event_id=${b.body.id}`).set(auth)
    const namesA = listA.body.checkins.map(c => c.person_name)
    const namesB = listB.body.checkins.map(c => c.person_name)
    expect(namesA).toContain(`Early ${FX}`)
    expect(namesA).not.toContain(`Late ${FX}`)
    expect(namesB).toContain(`Late ${FX}`)
    expect(namesB).not.toContain(`Early ${FX}`)

    const recent = await request(server).get('/api/checkins/recent?days=36500').set(auth)
    const rows = recent.body.services.filter(s =>
      s.title === `Sunday Mass ${FX}` && s.date === DUP_DATE
    )
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map(s => s.event_id)).size).toBe(2)
  })

  it('CHK-05: deleting a Mass that has attendance is 409; history is not erased', async () => {
    const del = await request(server).delete(`/api/calendar/${fx.massId}`).set(auth)
    expect(del.status).toBe(409)
    expect(del.body.code).toBe('has_attendance')
    expect(del.body.error).toMatch(/checked in/i)
    expect(del.body.error).toMatch(/not erased/i)

    const still = await sqlStamps(fx.checkinId)
    expect(still).toBeTruthy()
    expect(still.attended_title).toBe(T0_TITLE)
    expect(still.attended_date).toBe(T0_DATE)
    expect(Number(still.calendar_event_id)).toBe(Number(fx.massId))

    const ev = await pool.query(
      'SELECT 1 FROM ochr_calendar_events WHERE id = $1 AND organization_id = $2',
      [fx.massId, orgId]
    )
    expect(ev.rowCount).toBe(1)
  })

  it('kiosk write path stamps from the Mass-of-today and holds after a rename', async () => {
    const { rows: orgRows } = await pool.query(
      `SELECT COALESCE(timezone, 'UTC') AS timezone FROM ochr_organizations WHERE id = $1`,
      [orgId]
    )
    const { rows: todayRows } = await pool.query(
      `SELECT to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS today`,
      [orgRows[0].timezone]
    )
    const today = todayRows[0].today

    const mass = await makeMass({
      title: `Kiosk Mass ${FX}`,
      date: today,
      start_time: '06:15',
      end_time: '07:00',
    })
    expect(mass.status).toBe(201)

    const rotated = await request(server).post('/api/kiosk-admin/rotate').set(auth)
    expect(rotated.status).toBe(200)
    const kioskToken = rotated.body.kiosk_token
    expect(kioskToken).toBeTruthy()

    const kiosk = await request(server).post(`/api/kiosk/${kioskToken}/checkin`).send({
      calendar_event_id: mass.body.id,
      person_name: `Kiosk ${FX}`,
      kind: 'guest',
      attended_title: 'Kiosk invented',
      attended_date: '1999-01-01',
      attended_time: '00:00',
    })
    expect(kiosk.status).toBe(201)
    expect(kiosk.body.attended_title).toBe(`Kiosk Mass ${FX}`)
    expect(kiosk.body.attended_date).toBe(today)
    expect(kiosk.body.attended_time).toBe('06:15')

    const renamed = await mutateMass(mass.body.id, {
      title: `Kiosk Renamed ${FX}`,
      date: today,
      start_time: '16:45',
      end_time: '17:30',
    })
    expect(renamed.status).toBe(200)

    const stored = await sqlStamps(kiosk.body.id)
    expect(stored.attended_title).toBe(`Kiosk Mass ${FX}`)
    expect(stored.attended_date).toBe(today)
    expect(stored.attended_time).toBe('06:15')
    expect(stored.attended_title).not.toBe(`Kiosk Renamed ${FX}`)
    expect(stored.attended_time).not.toBe('16:45')
  })
})
