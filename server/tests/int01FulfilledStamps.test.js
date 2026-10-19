// INT-01 / DDR-INT-01 — a fulfilled intention keeps the Mass as offered.
//
// THE ATTACK THIS CLOSES. Title and time lived only on the live calendar
// row. After fulfill, a rename, retime, move, or vault-delete rewrote
// (or blanked) the book, the weekly sheet, and the Sunday Packet.
//
// WHAT WOULD MAKE THESE FAIL
//   - COALESCE(fulfilled_mass_title, ce.title) on the book or the view
//     (legacy NULL rows pick up today's Mass; rename rewrites history).
//   - Stamping at assign, or writing stamps from calendar PATCH / DELETE.
//   - Fulfill without a linked Mass (mints LEGACY UNKNOWN on purpose).
//   - Backfilling existing fulfilled rows from the current calendar.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'

let server
let tokenA, tokenB, orgAId

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()

  const a = await createOrg(server, {
    organizationName: `INT01 Parish A ${RUN_ID}`,
    name: 'Ada Admin',
    email: `int01_a_${RUN_ID}@example.com`,
    password: 'int01-test-pw-1',
  })
  expect(a.status).toBe(201)
  tokenA = a.body.token
  orgAId = a.body.user.organization.id

  const b = await createOrg(server, {
    organizationName: `INT01 Parish B ${RUN_ID}`,
    name: 'Bea Admin',
    email: `int01_b_${RUN_ID}@example.com`,
    password: 'int01-test-pw-2',
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

async function offerThenFulfill(token, intention, mass) {
  const made = await request(server).post('/api/mass-intentions')
    .set(auth(token))
    .send({ intention })
  expect(made.status).toBe(201)
  const offered = await request(server).post(`/api/mass-intentions/${made.body.id}/assign`)
    .set(auth(token))
    .send({ calendar_event_id: mass.id, expected_calendar_event_id: null })
  expect(offered.status).toBe(200)
  expect(offered.body.status).toBe('scheduled')
  const mark = await request(server).patch(`/api/mass-intentions/${made.body.id}`)
    .set(auth(token))
    .send({ status: 'fulfilled' })
  expect(mark.status).toBe(200)
  expect(mark.body.status).toBe('fulfilled')
  return { id: made.body.id, fulfill: mark.body }
}

async function stamps(id) {
  const { rows } = await pool.query(
    `SELECT to_char(fulfilled_mass_date, 'YYYY-MM-DD') AS fulfilled_mass_date,
            fulfilled_mass_title,
            to_char(fulfilled_mass_time, 'HH24:MI') AS fulfilled_mass_time,
            to_char(mass_date, 'YYYY-MM-DD') AS mass_date,
            status, calendar_event_id
       FROM ochr_mass_intentions
      WHERE id = $1 AND organization_id = $2`,
    [id, orgAId]
  )
  return rows[0]
}

async function bookOf(id, token = tokenA) {
  return request(server).get(`/api/mass-intentions/${id}`).set(auth(token))
}

async function weeklyOf(start, end, token = tokenA) {
  return request(server)
    .get(`/api/mass-intentions/weekly?start=${start}&end=${end}`)
    .set(auth(token))
}

async function packetOf(date, token = tokenA) {
  return request(server).get(`/api/packet?date=${date}`).set(auth(token))
}

describe('INT-01 — fulfilled Mass stamps', () => {
  it('the installed view projects stamps for fulfilled and keeps the tenant join', async () => {
    const { rows } = await pool.query(
      `SELECT pg_get_viewdef('ochr_sacristy_weekly_manifest', true) AS def`
    )
    const def = rows[0].def
    expect(def).toMatch(/ce\.organization_id\s*=\s*mi\.organization_id/)
    expect(def).toMatch(/fulfilled_mass_title/)
    expect(def).toMatch(/fulfilled_mass_time/)
    expect(def).toMatch(/fulfilled_mass_date/)
    expect(def).toMatch(/\bweek_date\b/)
    expect(def).not.toMatch(/COALESCE\s*\(\s*(?:mi\.)?fulfilled_mass_/i)
  })

  it('fulfill stamps date, title, and time from the org-scoped Mass', async () => {
    const mass = await makeMass(tokenA, {
      title: `Stamp Mass ${RUN_ID}`,
      date: '2031-03-01',
      start_time: '08:30',
    })
    expect(mass.status).toBe(201)
    const { id, fulfill } = await offerThenFulfill(tokenA, `† Stamp ${RUN_ID}`, mass.body)
    expect(fulfill.mass_date).toBe('2031-03-01')
    expect(fulfill.mass_title).toBe(`Stamp Mass ${RUN_ID}`)
    expect(fulfill.mass_time).toBe('08:30')

    const row = await stamps(id)
    expect(row.fulfilled_mass_date).toBe('2031-03-01')
    expect(row.fulfilled_mass_title).toBe(`Stamp Mass ${RUN_ID}`)
    expect(row.fulfilled_mass_time).toBe('08:30')
  })

  it('rename, retime, and move after fulfill do not rewrite book, weekly, or Packet', async () => {
    const mass = await makeMass(tokenA, {
      title: `8am Mass ${RUN_ID}`,
      date: '2031-04-05',
      start_time: '08:00',
    })
    expect(mass.status).toBe(201)
    const { id } = await offerThenFulfill(tokenA, `† Held ${RUN_ID}`, mass.body)

    const moved = await request(server).patch(`/api/calendar/${mass.body.id}`)
      .set(auth(tokenA))
      .send({
        title: `Solemn Mass ${RUN_ID}`,
        date: '2032-01-11',
        start_time: '11:00',
        end_time: '12:00',
        type: 'service',
        assigned_to: [],
      })
    expect(moved.status).toBe(200)

    const row = await stamps(id)
    expect(row.fulfilled_mass_date).toBe('2031-04-05')
    expect(row.fulfilled_mass_title).toBe(`8am Mass ${RUN_ID}`)
    expect(row.fulfilled_mass_time).toBe('08:00')
    expect(row.mass_date).toBe('2031-04-05')

    const book = await bookOf(id)
    expect(book.status).toBe(200)
    expect(book.body.mass_date).toBe('2031-04-05')
    expect(book.body.mass_title).toBe(`8am Mass ${RUN_ID}`)
    expect(book.body.mass_time).toBe('08:00')
    expect(book.body.mass_title).not.toBe(`Solemn Mass ${RUN_ID}`)

    const oldWeek = await weeklyOf('2031-04-05', '2031-04-11')
    const oldRow = oldWeek.body.intentions.find(r => r.id === id)
    expect(oldRow).toBeTruthy()
    expect(oldRow.mass_title).toBe(`8am Mass ${RUN_ID}`)
    expect(oldRow.mass_time).toBe('08:00')
    expect(oldRow.mass_date).toBe('2031-04-05')

    const newWeek = await weeklyOf('2032-01-11', '2032-01-17')
    expect(newWeek.body.intentions.some(r => r.id === id)).toBe(false)
    expect(newWeek.body.intentions.some(r =>
      String(r.mass_title || '').includes(`Solemn Mass ${RUN_ID}`) &&
      String(r.formatted_intention || '').includes(`Held ${RUN_ID}`)
    )).toBe(false)

    const oldPkt = await packetOf('2031-04-05')
    expect(oldPkt.status).toBe(200)
    const pktRow = oldPkt.body.intentions.find(r =>
      String(r.formatted_intention || r.intention || '').includes(`Held ${RUN_ID}`)
    )
    expect(pktRow).toBeTruthy()
    expect(pktRow.mass_title).toBe(`8am Mass ${RUN_ID}`)
    expect(pktRow.mass_time).toBe('08:00')
    expect(pktRow.mass_date).toBe('2031-04-05')

    const newPkt = await packetOf('2032-01-11')
    expect(newPkt.body.intentions.some(r =>
      String(r.formatted_intention || r.intention || '').includes(`Held ${RUN_ID}`)
    )).toBe(false)
  })

  it('vault-deleting the Mass leaves the stamps; it does not resurrect from the live join', async () => {
    const mass = await makeMass(tokenA, {
      title: `To vault ${RUN_ID}`,
      date: '2031-05-10',
      start_time: '07:00',
    })
    expect(mass.status).toBe(201)
    const { id } = await offerThenFulfill(tokenA, `† Vault ${RUN_ID}`, mass.body)

    const del = await request(server).delete(`/api/calendar/${mass.body.id}`)
      .set(auth(tokenA))
    expect(del.status).toBe(204)

    const row = await stamps(id)
    expect(row.status).toBe('fulfilled')
    expect(row.calendar_event_id).toBeNull()
    expect(row.fulfilled_mass_title).toBe(`To vault ${RUN_ID}`)
    expect(row.fulfilled_mass_date).toBe('2031-05-10')
    expect(row.fulfilled_mass_time).toBe('07:00')

    const book = await bookOf(id)
    expect(book.body.status).toBe('fulfilled')
    expect(book.body.mass_title).toBe(`To vault ${RUN_ID}`)
    expect(book.body.mass_time).toBe('07:00')
    expect(book.body.mass_date).toBe('2031-05-10')
    expect(book.body.calendar_event_id).toBeNull()

    const week = await weeklyOf('2031-05-10', '2031-05-16')
    const weekRow = week.body.intentions.find(r => r.id === id)
    expect(weekRow).toBeTruthy()
    expect(weekRow.mass_title).toBe(`To vault ${RUN_ID}`)
  })

  it('a fulfilled row with NULL stamps appears in Packet and weekly as unknown, not omitted and not the live title', async () => {
    const mass = await makeMass(tokenA, {
      title: `Live after the fact ${RUN_ID}`,
      date: '2031-06-14',
      start_time: '10:00',
    })
    expect(mass.status).toBe(201)

    const inserted = await pool.query(
      `INSERT INTO ochr_mass_intentions
         (organization_id, intention, mass_date, calendar_event_id, status)
       VALUES ($1, $2, $3::date, $4, 'fulfilled')
       RETURNING id`,
      [orgAId, `† Legacy unknown ${RUN_ID}`, '2031-06-14', mass.body.id]
    )
    const id = inserted.rows[0].id

    const row = await stamps(id)
    expect(row.fulfilled_mass_title).toBeNull()
    expect(row.fulfilled_mass_date).toBeNull()
    expect(row.fulfilled_mass_time).toBeNull()

    const book = await bookOf(id)
    expect(book.body.status).toBe('fulfilled')
    expect(book.body.mass_title).toBeNull()
    expect(book.body.mass_time).toBeNull()
    expect(book.body.mass_date).toBeNull()
    expect(book.body.mass_title).not.toBe(`Live after the fact ${RUN_ID}`)

    const week = await weeklyOf('2031-06-14', '2031-06-20')
    const weekRow = week.body.intentions.find(r => r.id === id)
    expect(weekRow).toBeTruthy()
    expect(weekRow.mass_title).toBeNull()
    expect(weekRow.mass_time).toBeNull()
    expect(weekRow.mass_date).toBeNull()
    expect(weekRow.mass_title).not.toBe(`Live after the fact ${RUN_ID}`)
    expect(weekRow.formatted_intention).toMatch(/Legacy unknown/)

    const otherWeek = await weeklyOf('2031-06-21', '2031-06-27')
    expect(otherWeek.body.intentions.some(r => r.id === id)).toBe(false)

    const pkt = await packetOf('2031-06-14')
    const pktRow = pkt.body.intentions.find(r =>
      String(r.formatted_intention || r.intention || '').includes(`Legacy unknown ${RUN_ID}`)
    )
    expect(pktRow).toBeTruthy()
    expect(pktRow.mass_title).toBeNull()
    expect(pktRow.mass_time).toBeNull()
    expect(pktRow.mass_date).toBeNull()
    expect(pktRow.mass_title).not.toBe(`Live after the fact ${RUN_ID}`)
  })

  it('assign leaves fulfilled_mass_* NULL', async () => {
    const mass = await makeMass(tokenA, {
      title: `Assign only ${RUN_ID}`,
      date: '2031-07-04',
    })
    const made = await request(server).post('/api/mass-intentions')
      .set(auth(tokenA))
      .send({ intention: `Assign no stamp ${RUN_ID}` })
    const offered = await request(server).post(`/api/mass-intentions/${made.body.id}/assign`)
      .set(auth(tokenA))
      .send({ calendar_event_id: mass.body.id, expected_calendar_event_id: null })
    expect(offered.status).toBe(200)
    expect(offered.body.status).toBe('scheduled')
    expect(offered.body.mass_title).toBe(`Assign only ${RUN_ID}`)

    const row = await stamps(made.body.id)
    expect(row.fulfilled_mass_date).toBeNull()
    expect(row.fulfilled_mass_title).toBeNull()
    expect(row.fulfilled_mass_time).toBeNull()
  })

  it('PATCH status=fulfilled with no linked Mass is 409 and writes nothing', async () => {
    const made = await request(server).post('/api/mass-intentions')
      .set(auth(tokenA))
      .send({ intention: `No Mass ${RUN_ID}`, note: 'keep me' })
    expect(made.status).toBe(201)

    const mark = await request(server).patch(`/api/mass-intentions/${made.body.id}`)
      .set(auth(tokenA))
      .send({ status: 'fulfilled' })
    expect(mark.status).toBe(409)
    expect(mark.body.error).toMatch(/not offered at a Mass yet/i)
    expect(mark.body.error).toMatch(/nothing was lost/i)

    const row = await stamps(made.body.id)
    expect(row.status).toBe('open')
    expect(row.fulfilled_mass_title).toBeNull()

    const book = await bookOf(made.body.id)
    expect(book.body.status).toBe('open')
    expect(book.body.note).toBe('keep me')
  })

  it('POST create as fulfilled without a Mass is 409 and inserts nothing', async () => {
    const before = await pool.query(
      `SELECT count(*)::int AS n FROM ochr_mass_intentions
        WHERE organization_id = $1 AND intention = $2`,
      [orgAId, `Create fulfilled bare ${RUN_ID}`]
    )

    const created = await request(server).post('/api/mass-intentions')
      .set(auth(tokenA))
      .send({
        intention: `Create fulfilled bare ${RUN_ID}`,
        mass_date: '2031-08-01',
        status: 'fulfilled',
      })
    expect(created.status).toBe(409)
    expect(created.body.error).toMatch(/not offered at a Mass yet/i)

    const after = await pool.query(
      `SELECT count(*)::int AS n FROM ochr_mass_intentions
        WHERE organization_id = $1 AND intention = $2`,
      [orgAId, `Create fulfilled bare ${RUN_ID}`]
    )
    expect(after.rows[0].n).toBe(before.rows[0].n)
  })

  it('editing mass_date or the live Mass after fulfill does not mutate stamps', async () => {
    const mass = await makeMass(tokenA, {
      title: `Correction hold ${RUN_ID}`,
      date: '2031-09-06',
      start_time: '09:15',
    })
    const { id } = await offerThenFulfill(tokenA, `† No silent fix ${RUN_ID}`, mass.body)

    const dateEdit = await request(server).patch(`/api/mass-intentions/${id}`)
      .set(auth(tokenA))
      .send({ mass_date: '2031-12-25' })
    expect(dateEdit.status).toBe(409)

    const sneak = await request(server).patch(`/api/mass-intentions/${id}`)
      .set(auth(tokenA))
      .send({
        status: 'fulfilled',
        fulfilled_mass_title: 'Invented title',
        note: 'office note',
      })
    expect(sneak.status).toBe(200)
    expect(sneak.body.note).toBe('office note')
    expect(sneak.body.mass_title).toBe(`Correction hold ${RUN_ID}`)

    const row = await stamps(id)
    expect(row.mass_date).toBe('2031-09-06')
    expect(row.calendar_event_id).toBe(mass.body.id)
    expect(row.fulfilled_mass_date).toBe('2031-09-06')
    expect(row.fulfilled_mass_title).toBe(`Correction hold ${RUN_ID}`)
    expect(row.fulfilled_mass_time).toBe('09:15')
  })

  it('same-Mass same-day re-fulfil leaves the stamp', async () => {
    const mass = await makeMass(tokenA, {
      title: `Same day again ${RUN_ID}`,
      date: '2031-11-02',
      start_time: '08:00',
    })
    const { id } = await offerThenFulfill(tokenA, `† Same day ${RUN_ID}`, mass.body)

    const demote = await request(server).patch(`/api/mass-intentions/${id}`)
      .set(auth(tokenA))
      .send({ status: 'scheduled' })
    expect(demote.status).toBe(200)
    expect(demote.body.status).toBe('scheduled')

    const again = await request(server).patch(`/api/mass-intentions/${id}`)
      .set(auth(tokenA))
      .send({ status: 'fulfilled' })
    expect(again.status).toBe(200)
    expect(again.body.status).toBe('fulfilled')
    expect(again.body.mass_title).toBe(`Same day again ${RUN_ID}`)
    expect(again.body.mass_date).toBe('2031-11-02')
    expect(again.body.mass_time).toBe('08:00')

    const row = await stamps(id)
    expect(row.fulfilled_mass_title).toBe(`Same day again ${RUN_ID}`)
    expect(row.fulfilled_mass_date).toBe('2031-11-02')
    expect(row.fulfilled_mass_time).toBe('08:00')
  })

  it('demote then fulfill again after a rename is refused and does not restamp', async () => {
    const mass = await makeMass(tokenA, {
      title: `First offered ${RUN_ID}`,
      date: '2031-11-01',
      start_time: '08:00',
    })
    const { id } = await offerThenFulfill(tokenA, `† Write once ${RUN_ID}`, mass.body)

    const demote = await request(server).patch(`/api/mass-intentions/${id}`)
      .set(auth(tokenA))
      .send({ status: 'scheduled' })
    expect(demote.status).toBe(200)
    expect(demote.body.status).toBe('scheduled')
    expect(demote.body.mass_title).toBe(`First offered ${RUN_ID}`)

    const renamed = await request(server).patch(`/api/calendar/${mass.body.id}`)
      .set(auth(tokenA))
      .send({
        title: `Renamed after demote ${RUN_ID}`,
        date: '2031-11-01',
        start_time: '08:00',
        end_time: '09:00',
        type: 'service',
        assigned_to: [],
      })
    expect(renamed.status).toBe(200)

    const before = await stamps(id)
    const again = await request(server).patch(`/api/mass-intentions/${id}`)
      .set(auth(tokenA))
      .send({ status: 'fulfilled' })
    // The live title no longer equals the stamp, so the transition is refused.
    expect(again.status).toBe(409)
    expect(again.body.code).toBe('stamp_conflict')

    const row = await stamps(id)
    expect(row.status).toBe('scheduled')
    expect(row.fulfilled_mass_title).toBe(before.fulfilled_mass_title)
    expect(row.fulfilled_mass_date).toBe(before.fulfilled_mass_date)
    expect(row.fulfilled_mass_time).toBe(before.fulfilled_mass_time)
    expect(row.fulfilled_mass_title).toBe(`First offered ${RUN_ID}`)
  })

  it('a foreign Mass cannot supply the stamp', async () => {
    const foreign = await makeMass(tokenB, {
      title: `Other parish Mass ${RUN_ID}`,
      date: '2031-10-04',
    })
    expect(foreign.status).toBe(201)

    const made = await request(server).post('/api/mass-intentions')
      .set(auth(tokenA))
      .send({ intention: `Cross stamp ${RUN_ID}` })
    const mark = await request(server).patch(`/api/mass-intentions/${made.body.id}`)
      .set(auth(tokenA))
      .send({ status: 'fulfilled', calendar_event_id: foreign.body.id })
    expect(mark.status).toBe(404)

    const row = await stamps(made.body.id)
    expect(row.status).toBe('open')
    expect(row.fulfilled_mass_title).toBeNull()
    expect(row.calendar_event_id).toBeNull()
  })
})
