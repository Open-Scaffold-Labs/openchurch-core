// CHK-04 / DDR-CHK-04 — a check-in keeps the service as attended.
//
// THE ATTACK THIS CLOSES. Title, date, and time lived only on the live
// calendar row. After check-in, a rename, retime, or move rewrote
// /recent, the member history, and the parochial ASA as if the person
// had been at today's Mass.
//
// WHAT WOULD MAKE THESE FAIL (M1–M7)
//   M1 Restore e.title / e.date on /recent (live JOIN masquerade).
//   M2 Date the ASA from the live Mass after a move.
//   M3 Let calendar PATCH rewrite attended_time.
//   M4 Present a NULL stamp as the post-rename live title.
//   M5 COALESCE(attended_title, e.title) on a read path.
//   M6 Let a member rename rewrite person_name (034 regression).
//   M7 Weaken CHK-05 (attended DELETE becomes 204 / SET NULL).

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

let server
let tokenA, tokenB, orgAId

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()

  const a = await createOrg(server, {
    organizationName: `CHK04 Parish A ${RUN_ID}`,
    name: 'Ada Admin',
    email: `chk04_a_${RUN_ID}@example.com`,
    password: 'chk04-test-pw-1',
    tradition: 'episcopal',
  })
  expect(a.status).toBe(201)
  tokenA = a.body.token
  orgAId = a.body.user.organization.id

  const b = await createOrg(server, {
    organizationName: `CHK04 Parish B ${RUN_ID}`,
    name: 'Bea Admin',
    email: `chk04_b_${RUN_ID}@example.com`,
    password: 'chk04-test-pw-2',
  })
  expect(b.status).toBe(201)
  tokenB = b.body.token
}, 60_000)

afterAll(async () => {
  await closeServer(server)
  await pool.end()
})

const auth = token => ({ Authorization: `Bearer ${token}` })

function makeMass(token, body) {
  return request(server).post('/api/calendar').set(auth(token)).send({
    title: body.title,
    date: body.date,
    start_time: body.start_time || '09:00',
    end_time: body.end_time || '10:00',
    type: 'service',
  })
}

async function checkin(token, eventId, body = {}) {
  const payload = { calendar_event_id: eventId, ...body }
  if (!payload.client_id && !payload.person_name) payload.person_name = `Guest ${RUN_ID}`
  if (!payload.kind) payload.kind = payload.client_id ? 'member' : 'guest'
  const res = await request(server).post('/api/checkins').set(auth(token)).send(payload)
  expect([200, 201]).toContain(res.status)
  return res.body
}

async function renameMass(token, id, body) {
  return request(server).patch(`/api/calendar/${id}`).set(auth(token)).send({
    title: body.title,
    date: body.date,
    start_time: body.start_time || '09:00',
    end_time: body.end_time || '10:00',
    type: 'service',
    assigned_to: [],
  })
}

async function stamps(id) {
  const { rows } = await pool.query(
    `SELECT to_char(attended_date, 'YYYY-MM-DD') AS attended_date,
            attended_title,
            to_char(attended_time, 'HH24:MI') AS attended_time,
            calendar_event_id, person_name
       FROM ochr_checkins
      WHERE id = $1 AND organization_id = $2`,
    [id, orgAId]
  )
  return rows[0]
}

async function recentOf(token = tokenA, days = 36500) {
  return request(server).get(`/api/checkins/recent?days=${days}`).set(auth(token))
}

async function memberHistory(memberId, token = tokenA) {
  return request(server).get(`/api/clients/${memberId}/checkins`).set(auth(token))
}

async function asaWindow(start, end, token = tokenA) {
  const res = await request(server)
    .get(`/api/reports/parochial-report?start=${start}&end=${end}`)
    .set(auth(token))
  expect(res.status).toBe(200)
  return res.body.fields.find(f => f.key === 'asa')
}

describe('CHK-04 — write stamps date, title, and time from the org-scoped Mass', () => {
  it('the installed columns are nullable with no default, and the migration does not UPDATE', () => {
    const mig = src('migrations/103-attended-service-stamps.js')
    expect(mig).toMatch(/attended_date/)
    expect(mig).toMatch(/attended_title/)
    expect(mig).toMatch(/attended_time/)
    expect(mig).not.toMatch(/UPDATE\s+ochr_checkins/i)
    expect(mig).not.toMatch(/COALESCE\s*\(/i)
  })

  it('POST /api/checkins stamps from the Mass and echoes them; client labels are ignored', async () => {
    const mass = await makeMass(tokenA, {
      title: `Stamp Mass ${RUN_ID}`,
      date: '2033-03-06',
      start_time: '08:30',
    })
    expect(mass.status).toBe(201)
    const row = await request(server).post('/api/checkins').set(auth(tokenA)).send({
      calendar_event_id: mass.body.id,
      person_name: `Alice ${RUN_ID}`,
      kind: 'guest',
      attended_title: 'Invented title',
      attended_date: '1999-01-01',
      attended_time: '00:00',
      title: 'Client label',
    })
    expect(row.status).toBe(201)
    expect(row.body.attended_title).toBe(`Stamp Mass ${RUN_ID}`)
    expect(row.body.attended_date).toBe('2033-03-06')
    expect(row.body.attended_time).toBe('08:30')
    expect(row.body.attended_title).not.toBe('Invented title')

    const stored = await stamps(row.body.id)
    expect(stored.attended_title).toBe(`Stamp Mass ${RUN_ID}`)
    expect(stored.attended_date).toBe('2033-03-06')
    expect(stored.attended_time).toBe('08:30')
  })

  it('a foreign Mass cannot supply the stamp', async () => {
    const foreign = await makeMass(tokenB, {
      title: `Other parish Mass ${RUN_ID}`,
      date: '2033-03-13',
    })
    expect(foreign.status).toBe(201)
    const res = await request(server).post('/api/checkins').set(auth(tokenA)).send({
      calendar_event_id: foreign.body.id,
      person_name: `Cross ${RUN_ID}`,
      kind: 'guest',
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/unknown event/i)
  })
})

describe('CHK-04 — T0 check-in, mutate Mass, T1 stamps hold (M1–M3)', () => {
  it('M1 rename: /recent and ASA keep the as-attended title and Sunday', async () => {
    const mass = await makeMass(tokenA, {
      title: `8am Mass ${RUN_ID}`,
      date: '2033-04-03',
      start_time: '08:00',
    })
    expect(mass.status).toBe(201)
    const member = await request(server).post('/api/clients').set(auth(tokenA))
      .send({ name: `Alice M1 ${RUN_ID}`, status: 'active', role: 'Member' })
    const row = await checkin(tokenA, mass.body.id, { client_id: member.body.id })

    const moved = await renameMass(tokenA, mass.body.id, {
      title: `Solemn Mass ${RUN_ID}`,
      date: '2033-04-03',
      start_time: '08:00',
    })
    expect(moved.status).toBe(200)

    const stored = await stamps(row.id)
    expect(stored.attended_title).toBe(`8am Mass ${RUN_ID}`)
    expect(stored.attended_date).toBe('2033-04-03')
    expect(stored.attended_title).not.toBe(`Solemn Mass ${RUN_ID}`)

    const recent = await recentOf()
    expect(recent.status).toBe(200)
    const svc = recent.body.services.find(s => s.event_id === mass.body.id)
    expect(svc).toBeTruthy()
    expect(svc.title).toBe(`8am Mass ${RUN_ID}`)
    expect(svc.date).toBe('2033-04-03')
    expect(svc.title).not.toBe(`Solemn Mass ${RUN_ID}`)

    const history = await memberHistory(member.body.id)
    const hist = history.body.checkins.find(c => c.id === row.id)
    expect(hist.event_title).toBe(`8am Mass ${RUN_ID}`)
    expect(hist.event_date).toBe('2033-04-03')
    expect(hist.event_id).toBe(mass.body.id)

    const asa = await asaWindow('2033-04-01', '2033-04-09')
    expect(asa.value).toBeGreaterThan(0)
  })

  it('M2 move: attended Sunday keeps Alice; the new Sunday does not gain her', async () => {
    const mass = await makeMass(tokenA, {
      title: `Move Mass ${RUN_ID}`,
      date: '2033-05-01',
      start_time: '10:00',
    })
    const member = await request(server).post('/api/clients').set(auth(tokenA))
      .send({ name: `Alice M2 ${RUN_ID}`, status: 'active', role: 'Member' })
    const row = await checkin(tokenA, mass.body.id, { client_id: member.body.id })

    const moved = await renameMass(tokenA, mass.body.id, {
      title: `Move Mass ${RUN_ID}`,
      date: '2033-05-08',
      start_time: '10:00',
    })
    expect(moved.status).toBe(200)

    const stored = await stamps(row.id)
    expect(stored.attended_date).toBe('2033-05-01')
    expect(Number(stored.calendar_event_id)).toBe(Number(mass.body.id))

    const recent = await recentOf()
    const svc = recent.body.services.find(s => s.event_id === mass.body.id)
    expect(svc.date).toBe('2033-05-01')
    expect(svc.date).not.toBe('2033-05-08')

    const oldAsa = await asaWindow('2033-05-01', '2033-05-01')
    expect(oldAsa.value).toBeGreaterThan(0)
    const newAsa = await asaWindow('2033-05-08', '2033-05-08')
    expect(newAsa.value).toBe(0)
  })

  it('M3 retime: historical time stays as stamped', async () => {
    const mass = await makeMass(tokenA, {
      title: `Time Mass ${RUN_ID}`,
      date: '2033-06-05',
      start_time: '07:15',
    })
    const row = await checkin(tokenA, mass.body.id, { person_name: `Time ${RUN_ID}` })

    const retimed = await renameMass(tokenA, mass.body.id, {
      title: `Time Mass ${RUN_ID}`,
      date: '2033-06-05',
      start_time: '11:00',
      end_time: '12:00',
    })
    expect(retimed.status).toBe(200)

    const stored = await stamps(row.id)
    expect(stored.attended_time).toBe('07:15')
    const recent = await recentOf()
    const svc = recent.body.services.find(s => s.event_id === mass.body.id)
    expect(svc.time).toBe('07:15')
  })
})

describe('CHK-04 — NULL is unknown, never the live Mass (M4–M5)', () => {
  it('M4 a legacy NULL row does not display the post-rename title as attended', async () => {
    const mass = await makeMass(tokenA, {
      title: `Live after the fact ${RUN_ID}`,
      date: '2033-07-03',
      start_time: '09:00',
    })
    expect(mass.status).toBe(201)
    const member = await request(server).post('/api/clients').set(auth(tokenA))
      .send({ name: `Legacy ${RUN_ID}`, status: 'active', role: 'Member' })
    const inserted = await pool.query(
      `INSERT INTO ochr_checkins
         (organization_id, calendar_event_id, client_id, person_name, kind)
       VALUES ($1, $2, $3, $4, 'member')
       RETURNING id`,
      [orgAId, mass.body.id, member.body.id, `Legacy ${RUN_ID}`]
    )
    const id = inserted.rows[0].id

    const renamed = await renameMass(tokenA, mass.body.id, {
      title: `Renamed live ${RUN_ID}`,
      date: '2033-07-03',
      start_time: '09:00',
    })
    expect(renamed.status).toBe(200)

    const stored = await stamps(id)
    expect(stored.attended_title).toBeNull()
    expect(stored.attended_date).toBeNull()
    expect(stored.attended_time).toBeNull()

    const recent = await recentOf()
    const svc = recent.body.services.find(s => s.event_id === mass.body.id && s.title == null)
    expect(svc).toBeTruthy()
    expect(svc.title).toBeNull()
    expect(svc.date).toBeNull()
    expect(svc.title).not.toBe(`Renamed live ${RUN_ID}`)
    expect(svc.title).not.toBe(`Live after the fact ${RUN_ID}`)

    const history = await memberHistory(member.body.id)
    const hist = history.body.checkins.find(c => c.id === id)
    expect(hist.event_title).toBeNull()
    expect(hist.event_date).toBeNull()
    expect(hist.event_title).not.toBe(`Renamed live ${RUN_ID}`)
  })

  it('M5 live JOIN restore / COALESCE on the read paths is refused in source', () => {
    const recent = src('routes/checkins.js')
    const recentFn = recent.slice(recent.indexOf("router.get('/recent'"))
    const recentSql = recentFn.slice(0, recentFn.indexOf('res.json'))
    expect(recentSql).not.toMatch(/JOIN\s+ochr_calendar_events/i)
    expect(recentSql).not.toMatch(/e\.title/)
    expect(recentSql).not.toMatch(/e\.date/)
    expect(recentSql).not.toMatch(/COALESCE\s*\(\s*(?:ck\.|ci\.)?attended_/i)

    const listFn = recent.slice(recent.indexOf("router.get('/', async"))
    const listSql = listFn.slice(0, listFn.indexOf('res.json'))
    expect(listSql).not.toMatch(/COALESCE\s*\(\s*(?:ci\.)?attended_/i)

    const members = src('routes/clients.js')
    const hist = members.slice(members.indexOf("router.get('/:id/checkins'"))
    const histSql = hist.slice(0, hist.indexOf('res.json'))
    expect(histSql).not.toMatch(/JOIN\s+ochr_calendar_events/i)
    expect(histSql).not.toMatch(/e\.title/)
    expect(histSql).not.toMatch(/e\.date/)
    expect(histSql).not.toMatch(/COALESCE\s*\(\s*(?:ci\.)?attended_/i)

    const asa = src('reporting/definitions.js')
    expect(asa).toMatch(/ck\.attended_date/)
    expect(asa).not.toMatch(/COALESCE\s*\(\s*(?:ck\.)?attended_/i)
    const asaSql = asa.slice(asa.indexOf("key: 'asa'"))
    const asaQuery = asaSql.slice(0, asaSql.indexOf('source:'))
    expect(asaQuery).not.toMatch(/JOIN\s+ochr_calendar_events/i)
    expect(asaQuery).not.toMatch(/\be\.date\b/)
  })
})

describe('CHK-04 — person_name, duplicates, CHK-05 (M6–M7)', () => {
  it('M6 a member rename does not rewrite person_name', async () => {
    const mass = await makeMass(tokenA, {
      title: `Name Mass ${RUN_ID}`,
      date: '2033-08-07',
    })
    const member = await request(server).post('/api/clients').set(auth(tokenA))
      .send({ name: `Celia ${RUN_ID}`, status: 'active', role: 'Member' })
    const row = await checkin(tokenA, mass.body.id, { client_id: member.body.id })
    expect(row.person_name).toBe(`Celia ${RUN_ID}`)

    const renamed = await request(server).patch(`/api/clients/${member.body.id}`).set(auth(tokenA))
      .send({ name: `Celia Renamed ${RUN_ID}` })
    expect([200, 201]).toContain(renamed.status)

    const stored = await stamps(row.id)
    expect(stored.person_name).toBe(`Celia ${RUN_ID}`)
    expect(stored.person_name).not.toBe(`Celia Renamed ${RUN_ID}`)
  })

  it('two same-day same-title Masses stay distinct on /recent', async () => {
    const a = await makeMass(tokenA, {
      title: `Sunday Mass ${RUN_ID}`,
      date: '2033-09-04',
      start_time: '08:00',
    })
    const b = await makeMass(tokenA, {
      title: `Sunday Mass ${RUN_ID}`,
      date: '2033-09-04',
      start_time: '08:00',
    })
    expect(a.body.id).not.toBe(b.body.id)
    await checkin(tokenA, a.body.id, { person_name: `Early ${RUN_ID}` })
    await checkin(tokenA, b.body.id, { person_name: `Late ${RUN_ID}` })

    const recent = await recentOf()
    const rows = recent.body.services.filter(s =>
      s.title === `Sunday Mass ${RUN_ID}` && s.date === '2033-09-04'
    )
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map(s => s.event_id)).size).toBe(2)
  })

  it('M7 calendar PATCH does not UPDATE ochr_checkins; CHK-05 refuse-delete still holds', async () => {
    const calendar = src('routes/calendar.js')
    expect(calendar).not.toMatch(/UPDATE\s+ochr_checkins/i)
    const vault = src('vault/index.js')
    expect(vault).toMatch(/if \(kind === 'event'\) await refuseEventIfAttendance/)
    expect(vault).toMatch(/FOR UPDATE/)

    const mass = await makeMass(tokenA, {
      title: `Keep Mass ${RUN_ID}`,
      date: '2033-10-02',
    })
    const row = await checkin(tokenA, mass.body.id, { person_name: `Keep ${RUN_ID}` })

    const patched = await renameMass(tokenA, mass.body.id, {
      title: `Patched Mass ${RUN_ID}`,
      date: '2033-11-06',
      start_time: '16:00',
    })
    expect(patched.status).toBe(200)
    const stored = await stamps(row.id)
    expect(stored.attended_title).toBe(`Keep Mass ${RUN_ID}`)
    expect(stored.attended_date).toBe('2033-10-02')
    expect(Number(stored.calendar_event_id)).toBe(Number(mass.body.id))

    const del = await request(server).delete(`/api/calendar/${mass.body.id}`).set(auth(tokenA))
    expect(del.status).toBe(409)
    expect(del.body.code).toBe('has_attendance')
    expect(del.body.error).toMatch(/checked in/i)
    expect(del.body.error).toMatch(/not erased/i)

    const still = await pool.query(
      'SELECT calendar_event_id FROM ochr_checkins WHERE id = $1 AND organization_id = $2',
      [row.id, orgAId]
    )
    expect(still.rowCount).toBe(1)
    expect(Number(still.rows[0].calendar_event_id)).toBe(Number(mass.body.id))
    const ev = await pool.query(
      'SELECT 1 FROM ochr_calendar_events WHERE id = $1 AND organization_id = $2',
      [mass.body.id, orgAId]
    )
    expect(ev.rowCount).toBe(1)
  })

  it('kiosk write path also stamps from the org-scoped Mass (source)', () => {
    const kiosk = src('routes/kiosk.js')
    expect(kiosk).toMatch(/attended_title/)
    expect(kiosk).toMatch(/attended_date/)
    expect(kiosk).toMatch(/attended_time/)
    expect(kiosk).toMatch(/SELECT title, date, start_time/)
    expect(kiosk).not.toMatch(/req\.body\?\.(attended_|title)/)
  })
})
