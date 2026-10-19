// FBF2 CLOSURE Phase 2 — TIMELINE LEAD (Historical Truth).
//
// Independent of CHK-04 / INT-01 / CHK-05 rubber-stamps. One local-PG
// parish, one confusing twin pair, then the orderings / delete / NULL /
// dupe cases the closure asked for.
//
// Locked convergence:
//   Mass live id = (ochr_calendar_events.id, organization_id).
//   attended_* stamped at check-in INSERT; fulfilled_mass_* at fulfill.
//   Event-relative — check-in → mutate → fulfill MAY disagree.
//   NULL ≠ live JOIN. Do not invent history.

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

// Far-future Sundays so this fixture does not collide with parish data
// already on a shared local cluster (CHK-04 uses 2033, INT-01 uses 2031).
const DAY0 = '2049-10-03' // Sunday
const DAY1 = '2049-11-07' // Sunday, after the mutate
const TITLE0 = `Sunday Mass ${RUN_ID}`
const TITLE1 = `Solemn Mass ${RUN_ID}`
const TIME_A0 = '08:00'
const TIME_B0 = '10:30'
const TIME_A1 = '11:00'

function assertSunday(iso) {
  const d = new Date(`${iso}T12:00:00Z`)
  if (d.getUTCDay() !== 0) throw new Error(`${iso} is not a Sunday`)
}
assertSunday(DAY0)
assertSunday(DAY1)

let server
let token
let orgId

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  const a = await createOrg(server, {
    organizationName: `FBF2 Timeline Parish ${RUN_ID}`,
    name: 'Timeline Admin',
    email: `fbf2_tl_${RUN_ID}@example.com`,
    password: 'fbf2-timeline-pw-1',
    tradition: 'episcopal',
  })
  expect(a.status).toBe(201)
  token = a.body.token
  orgId = a.body.user.organization.id
}, 60_000)

afterAll(async () => {
  await closeServer(server)
  await pool.end()
})

const auth = () => ({ Authorization: `Bearer ${token}` })

function makeMass(body) {
  return request(server).post('/api/calendar').set(auth()).send({
    title: body.title,
    date: body.date,
    start_time: body.start_time || '09:00',
    end_time: body.end_time || '10:00',
    type: 'service',
  })
}

function renameMass(id, body) {
  return request(server).patch(`/api/calendar/${id}`).set(auth()).send({
    title: body.title,
    date: body.date,
    start_time: body.start_time,
    end_time: body.end_time || '12:00',
    type: 'service',
    assigned_to: [],
  })
}

async function checkin(eventId, body = {}) {
  const payload = { calendar_event_id: eventId, ...body }
  if (!payload.client_id && !payload.person_name) payload.person_name = `Guest ${RUN_ID}`
  if (!payload.kind) payload.kind = payload.client_id ? 'member' : 'guest'
  const res = await request(server).post('/api/checkins').set(auth()).send(payload)
  expect([200, 201]).toContain(res.status)
  return res.body
}

async function offerThenFulfill(intention, massId) {
  const made = await request(server).post('/api/mass-intentions').set(auth())
    .send({ intention })
  expect(made.status).toBe(201)
  const offered = await request(server).post(`/api/mass-intentions/${made.body.id}/assign`)
    .set(auth())
    .send({ calendar_event_id: massId, expected_calendar_event_id: null })
  expect(offered.status).toBe(200)
  expect(offered.body.status).toBe('scheduled')
  const mark = await request(server).patch(`/api/mass-intentions/${made.body.id}`)
    .set(auth())
    .send({ status: 'fulfilled' })
  expect(mark.status).toBe(200)
  expect(mark.body.status).toBe('fulfilled')
  return { id: made.body.id, fulfill: mark.body }
}

async function attendedRow(id) {
  const { rows } = await pool.query(
    `SELECT to_char(attended_date, 'YYYY-MM-DD') AS attended_date,
            attended_title,
            to_char(attended_time, 'HH24:MI') AS attended_time,
            calendar_event_id, person_name
       FROM ochr_checkins
      WHERE id = $1 AND organization_id = $2`,
    [id, orgId]
  )
  return rows[0]
}

async function fulfilledRow(id) {
  const { rows } = await pool.query(
    `SELECT to_char(fulfilled_mass_date, 'YYYY-MM-DD') AS fulfilled_mass_date,
            fulfilled_mass_title,
            to_char(fulfilled_mass_time, 'HH24:MI') AS fulfilled_mass_time,
            to_char(mass_date, 'YYYY-MM-DD') AS mass_date,
            status, calendar_event_id
       FROM ochr_mass_intentions
      WHERE id = $1 AND organization_id = $2`,
    [id, orgId]
  )
  return rows[0]
}

async function liveEvent(id) {
  const { rows } = await pool.query(
    `SELECT id, title,
            to_char(date, 'YYYY-MM-DD') AS date,
            to_char(start_time, 'HH24:MI') AS start_time
       FROM ochr_calendar_events
      WHERE id = $1 AND organization_id = $2`,
    [id, orgId]
  )
  return rows[0] || null
}

async function recentOf(days = 36500) {
  return request(server).get(`/api/checkins/recent?days=${days}`).set(auth())
}

async function listForEvent(eventId) {
  return request(server).get(`/api/checkins?event_id=${eventId}`).set(auth())
}

async function memberHistory(memberId) {
  return request(server).get(`/api/clients/${memberId}/checkins`).set(auth())
}

async function bookOf(id) {
  return request(server).get(`/api/mass-intentions/${id}`).set(auth())
}

async function weeklyOf(start, end) {
  return request(server).get(`/api/mass-intentions/weekly?start=${start}&end=${end}`).set(auth())
}

async function packetOf(date) {
  return request(server).get(`/api/packet?date=${date}`).set(auth())
}

async function asaWindow(start, end) {
  const res = await request(server)
    .get(`/api/reports/parochial-report?start=${start}&end=${end}`)
    .set(auth())
  expect(res.status).toBe(200)
  return res.body.fields.find(f => f.key === 'asa')
}

function weekOf(iso) {
  const start = new Date(`${iso}T12:00:00Z`)
  const end = new Date(start)
  end.setUTCDate(end.getUTCDate() + 6)
  return { start: iso, end: end.toISOString().slice(0, 10) }
}

describe('FBF2 timeline — invent-backfill refusal', () => {
  it('102/103 do not UPDATE existing rows and do not COALESCE stamps to live', () => {
    const mig102 = src('migrations/102-fulfilled-mass-stamps.js')
    const mig103 = src('migrations/103-attended-service-stamps.js')
    expect(mig102).not.toMatch(/UPDATE\s+ochr_mass_intentions/i)
    expect(mig102).not.toMatch(/COALESCE\s*\(\s*(?:mi\.)?fulfilled_mass_/i)
    expect(mig103).not.toMatch(/UPDATE\s+ochr_checkins/i)
    expect(mig103).not.toMatch(/COALESCE\s*\(\s*(?:ck\.|ci\.)?attended_/i)

    const calendar = src('routes/calendar.js')
    expect(calendar).not.toMatch(/UPDATE\s+ochr_checkins/i)
    // Comment names the columns so PATCH/DELETE refuse to write them.
    // A write would look like `fulfilled_mass_title =` — that must not exist.
    expect(calendar).not.toMatch(/fulfilled_mass_(?:date|title|time)\s*=/i)
    expect(calendar).toMatch(/status IN \('open', 'scheduled'\)/)
  })

  it('installed stamp columns stay nullable with no default; no rewrite triggers', async () => {
    const { rows: cols } = await pool.query(
      `SELECT table_name, column_name, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (
                (table_name = 'ochr_checkins' AND column_name IN ('attended_date','attended_title','attended_time'))
             OR (table_name = 'ochr_mass_intentions' AND column_name IN ('fulfilled_mass_date','fulfilled_mass_title','fulfilled_mass_time'))
              )`
    )
    expect(cols).toHaveLength(6)
    for (const c of cols) {
      expect(c.is_nullable).toBe('YES')
      expect(c.column_default).toBeNull()
    }

    const { rows: trigs } = await pool.query(
      `SELECT tgname, rel.relname
         FROM pg_trigger t
         JOIN pg_class rel ON rel.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = rel.relnamespace
        WHERE n.nspname = 'public'
          AND rel.relname IN ('ochr_checkins', 'ochr_mass_intentions')
          AND NOT t.tgisinternal
          -- Stage 6 organization HOLD: rejects writes to a held tenant and
          -- never assigns NEW, so it cannot backfill or rewrite a stamp.
          AND t.tgname <> 'ochr_organization_hold_guard'
          -- Stage 7 (migration 116): refuses a NEW plaintext security_code;
          -- returns NEW unchanged, so it cannot backfill or rewrite a stamp.
          AND t.tgname <> 'trg_checkins_no_plaintext_code'`
    )
    expect(trigs).toEqual([])
    const { rows: [guard] } = await pool.query(
      `SELECT prosrc FROM pg_proc WHERE proname = 'ochr_held_organization_write_guard'`
    )
    expect(guard.prosrc).not.toMatch(/NEW\.[a-z_]+\s*:=/i)
  })
})

describe('FBF2 timeline — ONE fixture (Mass A + confusing twin B)', () => {
  const fx = {
    massA: null,
    massB: null,
    member: null,
    checkin: null,
    intention: null,
    bCheckin: null,
  }

  it('T0–T3 + DUPES + DELETE on the same A/B pair', async () => {
    // T0 — create Mass A and the same-title same-day twin B.
    const a = await makeMass({ title: TITLE0, date: DAY0, start_time: TIME_A0, end_time: '09:00' })
    const b = await makeMass({ title: TITLE0, date: DAY0, start_time: TIME_B0, end_time: '11:30' })
    expect(a.status).toBe(201)
    expect(b.status).toBe(201)
    expect(a.body.id).not.toBe(b.body.id)
    fx.massA = a.body
    fx.massB = b.body

    const liveA0 = await liveEvent(fx.massA.id)
    const liveB0 = await liveEvent(fx.massB.id)
    expect(liveA0).toMatchObject({ title: TITLE0, date: DAY0, start_time: TIME_A0 })
    expect(liveB0).toMatchObject({ title: TITLE0, date: DAY0, start_time: TIME_B0 })
    expect(Number(liveA0.id)).not.toBe(Number(liveB0.id))

    const member = await request(server).post('/api/clients').set(auth())
      .send({ name: `Alice Timeline ${RUN_ID}`, status: 'active', role: 'Member' })
    expect(member.status).toBe(201)
    fx.member = member.body

    // T1 — check-in on A. attended_* = A@T0.
    const ci = await checkin(fx.massA.id, { client_id: fx.member.id })
    fx.checkin = ci
    expect(ci.attended_title).toBe(TITLE0)
    expect(ci.attended_date).toBe(DAY0)
    expect(ci.attended_time).toBe(TIME_A0)
    expect(Number(ci.calendar_event_id)).toBe(Number(fx.massA.id))

    const t1 = await attendedRow(ci.id)
    expect(t1).toMatchObject({
      attended_title: TITLE0,
      attended_date: DAY0,
      attended_time: TIME_A0,
    })
    expect(Number(t1.calendar_event_id)).toBe(Number(fx.massA.id))

    // T2 — fulfill an intention on A. fulfilled_mass_* = live A at fulfill.
    const { id: intentionId, fulfill } = await offerThenFulfill(
      `† Timeline ${RUN_ID}`,
      fx.massA.id,
    )
    fx.intention = { id: intentionId, fulfill }
    expect(fulfill.mass_title).toBe(TITLE0)
    expect(fulfill.mass_date).toBe(DAY0)
    expect(fulfill.mass_time).toBe(TIME_A0)

    const t2 = await fulfilledRow(intentionId)
    expect(t2).toMatchObject({
      fulfilled_mass_title: TITLE0,
      fulfilled_mass_date: DAY0,
      fulfilled_mass_time: TIME_A0,
      status: 'fulfilled',
    })
    expect(Number(t2.calendar_event_id)).toBe(Number(fx.massA.id))

    // Mutate A: rename + retime + move date. Do not repair disagreement.
    const moved = await renameMass(fx.massA.id, {
      title: TITLE1,
      date: DAY1,
      start_time: TIME_A1,
      end_time: '12:00',
    })
    expect(moved.status).toBe(200)

    // T3 — attendance still T1; fulfilled still T2; live A is mutated; B untouched.
    const t3Att = await attendedRow(ci.id)
    expect(t3Att).toMatchObject({
      attended_title: TITLE0,
      attended_date: DAY0,
      attended_time: TIME_A0,
    })
    expect(t3Att.attended_title).not.toBe(TITLE1)
    expect(t3Att.attended_date).not.toBe(DAY1)
    expect(t3Att.attended_time).not.toBe(TIME_A1)
    expect(Number(t3Att.calendar_event_id)).toBe(Number(fx.massA.id))

    const t3Ful = await fulfilledRow(intentionId)
    expect(t3Ful).toMatchObject({
      fulfilled_mass_title: TITLE0,
      fulfilled_mass_date: DAY0,
      fulfilled_mass_time: TIME_A0,
      status: 'fulfilled',
    })
    expect(t3Ful.fulfilled_mass_title).not.toBe(TITLE1)
    expect(t3Ful.fulfilled_mass_time).not.toBe(TIME_B0)

    const liveA3 = await liveEvent(fx.massA.id)
    expect(liveA3).toMatchObject({ title: TITLE1, date: DAY1, start_time: TIME_A1 })

    const liveB3 = await liveEvent(fx.massB.id)
    expect(liveB3).toMatchObject({ title: TITLE0, date: DAY0, start_time: TIME_B0 })

    const liveApiA = await request(server).get(`/api/calendar/${fx.massA.id}`).set(auth())
    expect(liveApiA.status).toBe(200)
    expect(liveApiA.body.title).toBe(TITLE1)
    expect(liveApiA.body.date).toBe(DAY1)

    const recent = await recentOf()
    expect(recent.status).toBe(200)
    const svcA = recent.body.services.find(s => Number(s.event_id) === Number(fx.massA.id))
    expect(svcA).toBeTruthy()
    expect(svcA.title).toBe(TITLE0)
    expect(svcA.date).toBe(DAY0)
    expect(svcA.time).toBe(TIME_A0)
    expect(svcA.title).not.toBe(TITLE1)

    const history = await memberHistory(fx.member.id)
    const hist = history.body.checkins.find(c => c.id === ci.id)
    expect(hist.event_title).toBe(TITLE0)
    expect(hist.event_date).toBe(DAY0)
    expect(Number(hist.event_id)).toBe(Number(fx.massA.id))

    const listA = await listForEvent(fx.massA.id)
    expect(listA.status).toBe(200)
    expect(listA.body.checkins.some(r => r.id === ci.id)).toBe(true)
    const listed = listA.body.checkins.find(r => r.id === ci.id)
    expect(listed.attended_title).toBe(TITLE0)
    expect(listed.attended_date).toBe(DAY0)

    const book = await bookOf(intentionId)
    expect(book.status).toBe(200)
    expect(book.body.mass_title).toBe(TITLE0)
    expect(book.body.mass_date).toBe(DAY0)
    expect(book.body.mass_time).toBe(TIME_A0)
    expect(book.body.mass_title).not.toBe(TITLE1)

    const oldWeek = weekOf(DAY0)
    const week0 = await weeklyOf(oldWeek.start, oldWeek.end)
    const week0row = week0.body.intentions.find(r => r.id === intentionId)
    expect(week0row).toBeTruthy()
    expect(week0row.mass_title).toBe(TITLE0)
    expect(week0row.mass_time).toBe(TIME_A0)
    expect(week0row.mass_date).toBe(DAY0)

    const newWeek = weekOf(DAY1)
    const week1 = await weeklyOf(newWeek.start, newWeek.end)
    expect(week1.body.intentions.some(r => r.id === intentionId)).toBe(false)

    const pkt0 = await packetOf(DAY0)
    const pktRow = pkt0.body.intentions.find(r =>
      String(r.formatted_intention || r.intention || '').includes(`Timeline ${RUN_ID}`)
    )
    expect(pktRow).toBeTruthy()
    expect(pktRow.mass_title).toBe(TITLE0)
    expect(pktRow.mass_time).toBe(TIME_A0)

    const pkt1 = await packetOf(DAY1)
    expect(pkt1.body.intentions.some(r =>
      String(r.formatted_intention || r.intention || '').includes(`Timeline ${RUN_ID}`)
    )).toBe(false)

    const asa0 = await asaWindow(DAY0, DAY0)
    expect(asa0.value).toBeGreaterThan(0)
    const asa1 = await asaWindow(DAY1, DAY1)
    expect(asa1.value).toBe(0)

    // DUPES — A's check-in must not appear under B; /recent keeps both ids.
    const listB = await listForEvent(fx.massB.id)
    expect(listB.status).toBe(200)
    expect(listB.body.checkins.some(r => r.id === ci.id)).toBe(false)
    expect(listB.body.checkins).toHaveLength(0)

    const ciB = await checkin(fx.massB.id, { person_name: `Twin guest ${RUN_ID}` })
    fx.bCheckin = ciB
    expect(ciB.attended_title).toBe(TITLE0)
    expect(ciB.attended_date).toBe(DAY0)
    expect(ciB.attended_time).toBe(TIME_B0)
    expect(Number(ciB.calendar_event_id)).toBe(Number(fx.massB.id))

    const recentBoth = await recentOf()
    const svcA2 = recentBoth.body.services.find(s => Number(s.event_id) === Number(fx.massA.id))
    const svcB2 = recentBoth.body.services.find(s => Number(s.event_id) === Number(fx.massB.id))
    expect(svcA2).toBeTruthy()
    expect(svcB2).toBeTruthy()
    expect(Number(svcA2.event_id)).not.toBe(Number(svcB2.event_id))
    expect(svcA2.time).toBe(TIME_A0)
    expect(svcB2.time).toBe(TIME_B0)
    expect(svcA2.date).toBe(DAY0)
    expect(svcB2.date).toBe(DAY0)

    const listB2 = await listForEvent(fx.massB.id)
    expect(listB2.body.checkins.some(r => r.id === ci.id)).toBe(false)
    expect(listB2.body.checkins.some(r => r.id === ciB.id)).toBe(true)

    // DELETE — attended Mass A is 409; stamps and rows remain; B untouched.
    const blocked = await request(server).delete(`/api/calendar/${fx.massA.id}`).set(auth())
    expect(blocked.status).toBe(409)
    expect(blocked.body.code).toBe('has_attendance')
    expect(blocked.body.error).toMatch(/checked in/i)

    expect(await liveEvent(fx.massA.id)).toBeTruthy()
    expect(await liveEvent(fx.massB.id)).toMatchObject({
      title: TITLE0, date: DAY0, start_time: TIME_B0,
    })
    const stillCi = await attendedRow(ci.id)
    expect(stillCi).toBeTruthy()
    expect(Number(stillCi.calendar_event_id)).toBe(Number(fx.massA.id))
    const stillFul = await fulfilledRow(intentionId)
    expect(stillFul.calendar_event_id).not.toBeNull()
    expect(stillFul.fulfilled_mass_title).toBe(TITLE0)

    // Remove A's check-in. Fulfilled-only delete may succeed; stamps survive.
    const gone = await request(server).delete(`/api/checkins/${ci.id}`).set(auth())
    expect(gone.status).toBe(204)

    const delA = await request(server).delete(`/api/calendar/${fx.massA.id}`).set(auth())
    expect(delA.status).toBe(204)
    expect(await liveEvent(fx.massA.id)).toBeNull()

    const afterDel = await fulfilledRow(intentionId)
    expect(afterDel.status).toBe('fulfilled')
    expect(afterDel.calendar_event_id).toBeNull()
    expect(afterDel.fulfilled_mass_title).toBe(TITLE0)
    expect(afterDel.fulfilled_mass_date).toBe(DAY0)
    expect(afterDel.fulfilled_mass_time).toBe(TIME_A0)

    const bookAfter = await bookOf(intentionId)
    expect(bookAfter.body.status).toBe('fulfilled')
    expect(bookAfter.body.mass_title).toBe(TITLE0)
    expect(bookAfter.body.calendar_event_id).toBeNull()

    const bAfter = await liveEvent(fx.massB.id)
    expect(bAfter).toMatchObject({ title: TITLE0, date: DAY0, start_time: TIME_B0 })
    const bCiAfter = await attendedRow(ciB.id)
    expect(Number(bCiAfter.calendar_event_id)).toBe(Number(fx.massB.id))
  })
})

describe('FBF2 timeline — ORDERING A / B / C (separate sub-fixtures)', () => {
  async function pair(tag, day0, day1) {
    assertSunday(day0)
    assertSunday(day1)
    const m0 = { title: `${tag} M0 ${RUN_ID}`, date: day0, start_time: '08:15', end_time: '09:15' }
    const m1 = { title: `${tag} M1 ${RUN_ID}`, date: day1, start_time: '17:00', end_time: '18:00' }
    const mass = await makeMass(m0)
    expect(mass.status).toBe(201)
    return { mass, m0, m1 }
  }

  async function mutate(id, m1) {
    const res = await renameMass(id, m1)
    expect(res.status).toBe(200)
    return liveEvent(id)
  }

  it('A: check-in → mutate → fulfill (attendance=M0, intention=M1, disagreement OK)', async () => {
    const { mass, m0, m1 } = await pair('OA', '2050-01-02', '2050-02-06')
    const ci = await checkin(mass.body.id, { person_name: `OA ${RUN_ID}` })
    const live1 = await mutate(mass.body.id, m1)
    expect(live1).toMatchObject({ title: m1.title, date: m1.date, start_time: m1.start_time })

    const { id, fulfill } = await offerThenFulfill(`† OA ${RUN_ID}`, mass.body.id)
    expect(fulfill.mass_title).toBe(m1.title)
    expect(fulfill.mass_date).toBe(m1.date)
    expect(fulfill.mass_time).toBe(m1.start_time)

    const att = await attendedRow(ci.id)
    const ful = await fulfilledRow(id)
    expect(att).toMatchObject({
      attended_title: m0.title, attended_date: m0.date, attended_time: m0.start_time,
    })
    expect(ful).toMatchObject({
      fulfilled_mass_title: m1.title, fulfilled_mass_date: m1.date, fulfilled_mass_time: m1.start_time,
    })
    expect(att.attended_title).not.toBe(ful.fulfilled_mass_title)
    expect(att.attended_date).not.toBe(ful.fulfilled_mass_date)
    const live = await liveEvent(mass.body.id)
    expect(live).toMatchObject({ title: m1.title, date: m1.date, start_time: m1.start_time })
  })

  it('B: fulfill → mutate → check-in (intention=M0, attendance=M1)', async () => {
    const { mass, m0, m1 } = await pair('OB', '2050-03-06', '2050-04-03')
    const { id, fulfill } = await offerThenFulfill(`† OB ${RUN_ID}`, mass.body.id)
    expect(fulfill.mass_title).toBe(m0.title)

    const live1 = await mutate(mass.body.id, m1)
    expect(live1).toMatchObject({ title: m1.title, date: m1.date, start_time: m1.start_time })

    const ci = await checkin(mass.body.id, { person_name: `OB ${RUN_ID}` })
    expect(ci.attended_title).toBe(m1.title)
    expect(ci.attended_date).toBe(m1.date)
    expect(ci.attended_time).toBe(m1.start_time)

    const att = await attendedRow(ci.id)
    const ful = await fulfilledRow(id)
    expect(ful).toMatchObject({
      fulfilled_mass_title: m0.title, fulfilled_mass_date: m0.date, fulfilled_mass_time: m0.start_time,
    })
    expect(att).toMatchObject({
      attended_title: m1.title, attended_date: m1.date, attended_time: m1.start_time,
    })
    expect(att.attended_title).not.toBe(ful.fulfilled_mass_title)
    const live = await liveEvent(mass.body.id)
    expect(live).toMatchObject({ title: m1.title, date: m1.date, start_time: m1.start_time })
  })

  it('C: check-in → fulfill → mutate (both bags = M0; live = M1)', async () => {
    const { mass, m0, m1 } = await pair('OC', '2050-05-01', '2050-06-05')
    assertSunday('2050-06-05')
    const ci = await checkin(mass.body.id, { person_name: `OC ${RUN_ID}` })
    const { id, fulfill } = await offerThenFulfill(`† OC ${RUN_ID}`, mass.body.id)
    expect(fulfill.mass_title).toBe(m0.title)
    expect(ci.attended_title).toBe(m0.title)

    const live1 = await mutate(mass.body.id, m1)
    expect(live1).toMatchObject({ title: m1.title, date: m1.date, start_time: m1.start_time })

    const att = await attendedRow(ci.id)
    const ful = await fulfilledRow(id)
    expect(att).toMatchObject({
      attended_title: m0.title, attended_date: m0.date, attended_time: m0.start_time,
    })
    expect(ful).toMatchObject({
      fulfilled_mass_title: m0.title, fulfilled_mass_date: m0.date, fulfilled_mass_time: m0.start_time,
    })
    expect(att.attended_title).toBe(ful.fulfilled_mass_title)
    expect(att.attended_date).toBe(ful.fulfilled_mass_date)
    expect(att.attended_title).not.toBe(m1.title)
    expect(ful.fulfilled_mass_title).not.toBe(m1.title)
    const live = await liveEvent(mass.body.id)
    expect(live).toMatchObject({ title: m1.title, date: m1.date, start_time: m1.start_time })
  })
})

describe('FBF2 timeline — fulfilled-only delete + LEGACY NULL', () => {
  it('fulfilled-only Mass deletes; stamps survive; calendar_event_id is NULL', async () => {
    const mass = await makeMass({
      title: `Fulfilled only ${RUN_ID}`,
      date: '2050-07-03',
      start_time: '07:00',
      end_time: '08:00',
    })
    expect(mass.status).toBe(201)
    const twin = await makeMass({
      title: `Fulfilled only ${RUN_ID}`,
      date: '2050-07-03',
      start_time: '09:00',
      end_time: '10:00',
    })
    expect(twin.status).toBe(201)

    const { id } = await offerThenFulfill(`† Fulfilled only ${RUN_ID}`, mass.body.id)
    const del = await request(server).delete(`/api/calendar/${mass.body.id}`).set(auth())
    expect(del.status).toBe(204)

    const row = await fulfilledRow(id)
    expect(row.status).toBe('fulfilled')
    expect(row.calendar_event_id).toBeNull()
    expect(row.fulfilled_mass_title).toBe(`Fulfilled only ${RUN_ID}`)
    expect(row.fulfilled_mass_date).toBe('2050-07-03')
    expect(row.fulfilled_mass_time).toBe('07:00')

    const book = await bookOf(id)
    expect(book.body.mass_title).toBe(`Fulfilled only ${RUN_ID}`)
    expect(book.body.calendar_event_id).toBeNull()

    const stillTwin = await liveEvent(twin.body.id)
    expect(stillTwin).toMatchObject({
      title: `Fulfilled only ${RUN_ID}`,
      date: '2050-07-03',
      start_time: '09:00',
    })
  })

  it('legacy NULL stamps stay UNKNOWN after a live mutate; ASA does not invent the new Sunday', async () => {
    const mass = await makeMass({
      title: `Legacy live ${RUN_ID}`,
      date: '2050-08-07',
      start_time: '09:00',
      end_time: '10:00',
    })
    expect(mass.status).toBe(201)
    const member = await request(server).post('/api/clients').set(auth())
      .send({ name: `Legacy ${RUN_ID}`, status: 'active', role: 'Member' })
    expect(member.status).toBe(201)

    const insertedCi = await pool.query(
      `INSERT INTO ochr_checkins
         (organization_id, calendar_event_id, client_id, person_name, kind)
       VALUES ($1, $2, $3, $4, 'member')
       RETURNING id`,
      [orgId, mass.body.id, member.body.id, `Legacy ${RUN_ID}`]
    )
    const ciId = insertedCi.rows[0].id

    const insertedMi = await pool.query(
      `INSERT INTO ochr_mass_intentions
         (organization_id, intention, mass_date, calendar_event_id, status)
       VALUES ($1, $2, $3::date, $4, 'fulfilled')
       RETURNING id`,
      [orgId, `† Legacy unknown ${RUN_ID}`, '2050-08-07', mass.body.id]
    )
    const miId = insertedMi.rows[0].id

    const beforeAtt = await attendedRow(ciId)
    const beforeFul = await fulfilledRow(miId)
    expect(beforeAtt.attended_title).toBeNull()
    expect(beforeAtt.attended_date).toBeNull()
    expect(beforeAtt.attended_time).toBeNull()
    expect(beforeFul.fulfilled_mass_title).toBeNull()
    expect(beforeFul.fulfilled_mass_date).toBeNull()
    expect(beforeFul.fulfilled_mass_time).toBeNull()

    const renamed = await renameMass(mass.body.id, {
      title: `Renamed live ${RUN_ID}`,
      date: '2050-09-04',
      start_time: '16:00',
      end_time: '17:00',
    })
    expect(renamed.status).toBe(200)

    const afterAtt = await attendedRow(ciId)
    const afterFul = await fulfilledRow(miId)
    expect(afterAtt.attended_title).toBeNull()
    expect(afterAtt.attended_date).toBeNull()
    expect(afterAtt.attended_time).toBeNull()
    expect(afterFul.fulfilled_mass_title).toBeNull()
    expect(afterFul.fulfilled_mass_date).toBeNull()
    expect(afterFul.fulfilled_mass_time).toBeNull()

    const recent = await recentOf()
    const svc = recent.body.services.find(s =>
      Number(s.event_id) === Number(mass.body.id) && s.title == null
    )
    expect(svc).toBeTruthy()
    expect(svc.title).toBeNull()
    expect(svc.date).toBeNull()
    expect(svc.title).not.toBe(`Renamed live ${RUN_ID}`)
    expect(svc.title).not.toBe(`Legacy live ${RUN_ID}`)

    const history = await memberHistory(member.body.id)
    const hist = history.body.checkins.find(c => c.id === ciId)
    expect(hist.event_title).toBeNull()
    expect(hist.event_date).toBeNull()

    const book = await bookOf(miId)
    expect(book.body.status).toBe('fulfilled')
    expect(book.body.mass_title).toBeNull()
    expect(book.body.mass_time).toBeNull()
    expect(book.body.mass_date).toBeNull()
    expect(book.body.mass_title).not.toBe(`Renamed live ${RUN_ID}`)

    const weekOld = await weeklyOf('2050-08-07', '2050-08-13')
    const weekRow = weekOld.body.intentions.find(r => r.id === miId)
    expect(weekRow).toBeTruthy()
    expect(weekRow.mass_title).toBeNull()
    expect(weekRow.mass_date).toBeNull()

    const weekNew = await weeklyOf('2050-09-04', '2050-09-10')
    expect(weekNew.body.intentions.some(r => r.id === miId)).toBe(false)

    const asaOld = await asaWindow('2050-08-07', '2050-08-07')
    expect(asaOld.value).toBe(0)
    const asaNew = await asaWindow('2050-09-04', '2050-09-04')
    expect(asaNew.value).toBe(0)
  })
})
