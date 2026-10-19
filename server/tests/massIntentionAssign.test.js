// MI.4 — offering an intention at a scheduled Mass is one trusted fact.
// The book, weekly sheet, Sunday Packet, and calendar tiles all read
// calendar_event_id + mass_date + status from the same row. This file
// signs up its own parishes and shares nothing with smoke.test.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
import { REFUSE_DATE_DISAGREES, REFUSE_NOT_A_MASS, intentionCalendarDay } from '../src/routes/massIntentions.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'

let server
let tokenA, tokenB, orgAId, orgBId

async function auditCountForIntention(orgId, entityId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS c FROM ochr_audit_log
      WHERE organization_id = $1 AND entity_type = 'mass_intention' AND entity_id = $2`,
    [orgId, String(entityId)]
  )
  return rows[0].c
}

async function auditCountForOrgIntentions(orgId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS c FROM ochr_audit_log
      WHERE organization_id = $1 AND entity_type = 'mass_intention'`,
    [orgId]
  )
  return rows[0].c
}

async function intentionCount(orgId) {
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS c FROM ochr_mass_intentions WHERE organization_id = $1',
    [orgId],
  )
  return rows[0].c
}
let viewerToken
let massTue, massWed
let openId, datedId, cancelledId, fulfilledId

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()

  const a = await createOrg(server, {
    organizationName: `Assign Parish A ${RUN_ID}`,
    name: 'Ada Admin',
    email: `assign_a_${RUN_ID}@example.com`,
    password: 'assign-test-pw-1',
  })
  expect(a.status).toBe(201)
  tokenA = a.body.token
  orgAId = a.body.user.organization.id

  const b = await createOrg(server, {
    organizationName: `Assign Parish B ${RUN_ID}`,
    name: 'Bea Admin',
    email: `assign_b_${RUN_ID}@example.com`,
    password: 'assign-test-pw-2',
  })
  expect(b.status).toBe(201)
  tokenB = b.body.token
  orgBId = b.body.user.organization.id

  const viewer = await request(server).post('/api/users')
    .set('Authorization', `Bearer ${tokenA}`)
    .send({
      name: 'Vera Viewer',
      email: `assign_viewer_${RUN_ID}@example.com`,
      password: 'assign-viewer-pw-1',
      role: 'viewer',
    })
  expect(viewer.status).toBe(201)
  const vLogin = await request(server).post('/api/auth/login')
    .send({ email: `assign_viewer_${RUN_ID}@example.com`, password: 'assign-viewer-pw-1' })
  expect(vLogin.status).toBe(200)
  viewerToken = vLogin.body.token

  const tue = await request(server).post('/api/calendar')
    .set('Authorization', `Bearer ${tokenA}`)
    .send({
      title: `Tuesday Mass ${RUN_ID}`,
      date: '2027-06-08',
      start_time: '09:00',
      end_time: '10:00',
      type: 'service',
    })
  expect(tue.status).toBe(201)
  massTue = tue.body.id

  const wed = await request(server).post('/api/calendar')
    .set('Authorization', `Bearer ${tokenA}`)
    .send({
      title: `Wednesday Mass ${RUN_ID}`,
      date: '2027-06-09',
      start_time: '08:00',
      end_time: '09:00',
      type: 'service',
    })
  expect(wed.status).toBe(201)
  massWed = wed.body.id

  const open = await request(server).post('/api/mass-intentions')
    .set('Authorization', `Bearer ${tokenA}`)
    .send({ intention: `† Open ${RUN_ID}` })
  expect(open.status).toBe(201)
  expect(open.body.status).toBe('open')
  openId = open.body.id

  const dated = await request(server).post('/api/mass-intentions')
    .set('Authorization', `Bearer ${tokenA}`)
    .send({ intention: `Dated ${RUN_ID}`, mass_date: '2027-06-08', status: 'scheduled' })
  expect(dated.status).toBe(201)
  datedId = dated.body.id

  const cancelled = await request(server).post('/api/mass-intentions')
    .set('Authorization', `Bearer ${tokenA}`)
    .send({ intention: `Cancelled ${RUN_ID}`, status: 'cancelled' })
  expect(cancelled.status).toBe(201)
  cancelledId = cancelled.body.id

  // Legacy fulfilled row: stamps stay NULL. New writes refuse fulfill
  // without a linked Mass; this fixture stands in for history captured
  // before that contract.
  const fulfilled = await pool.query(
    `INSERT INTO ochr_mass_intentions
       (organization_id, intention, mass_date, status)
     VALUES ($1, $2, $3::date, 'fulfilled')
     RETURNING id`,
    [orgAId, `Fulfilled ${RUN_ID}`, '2027-06-01']
  )
  fulfilledId = fulfilled.rows[0].id
}, 60_000)

afterAll(async () => {
  await closeServer(server)
  await pool.end()
})

describe('GET /api/mass-intentions/awaiting (MI.4)', () => {
  it('requires a date', async () => {
    const res = await request(server).get('/api/mass-intentions/awaiting')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(400)
  })

  it('returns undated open and same-day unassigned, not cancelled, fulfilled, or other days', async () => {
    const res = await request(server).get('/api/mass-intentions/awaiting?date=2027-06-08')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    const ids = res.body.intentions.map(r => r.id)
    expect(ids).toContain(openId)
    expect(ids).toContain(datedId)
    expect(ids).not.toContain(cancelledId)
    expect(ids).not.toContain(fulfilledId)
  })

  it('does not leak across tenants', async () => {
    const res = await request(server).get('/api/mass-intentions/awaiting?date=2027-06-08')
      .set('Authorization', `Bearer ${tokenB}`)
    expect(res.status).toBe(200)
    expect(res.body.intentions.some(r => r.id === openId)).toBe(false)
  })
})

describe('POST /api/mass-intentions/:id/assign (MI.4)', () => {
  it('offers an open intention at a Mass — date and status become the Mass', async () => {
    const res = await request(server).post(`/api/mass-intentions/${openId}/assign`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ calendar_event_id: massTue, expected_calendar_event_id: null })
    expect(res.status).toBe(200)
    expect(res.body.calendar_event_id).toBe(massTue)
    expect(res.body.mass_date).toBe('2027-06-08')
    expect(res.body.status).toBe('scheduled')
    expect(res.body.mass_title).toBe(`Tuesday Mass ${RUN_ID}`)
  })

  it('the weekly manifest and Sunday Packet read the same assignment', async () => {
    const week = await request(server)
      .get('/api/mass-intentions/awaiting?date=2027-06-08')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(week.body.intentions.some(r => r.id === openId)).toBe(false)

    const manifest = await request(server)
      .get('/api/mass-intentions/weekly?start=2027-06-06&end=2027-06-12')
      .set('Authorization', `Bearer ${tokenA}`)
    const row = manifest.body.intentions.find(r => r.id === openId)
    expect(row).toBeTruthy()
    expect(row.calendar_event_id).toBe(massTue)
    expect(row.status).toBe('scheduled')

    const packet = await request(server)
      .get('/api/packet?date=2027-06-06')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(packet.status).toBe(200)
    expect(packet.body.intentions.some(r =>
      r.formatted_intention?.includes(`Open ${RUN_ID}`) || r.intention?.includes(`Open ${RUN_ID}`)
    )).toBe(true)
  })

  it('the same Mass twice is idempotent', async () => {
    const again = await request(server).post(`/api/mass-intentions/${openId}/assign`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ calendar_event_id: massTue })
    expect(again.status).toBe(200)
    expect(again.body.calendar_event_id).toBe(massTue)
  })

  it('a stale expected assignment is 409 and the Mass does not change', async () => {
    const stale = await request(server).post(`/api/mass-intentions/${openId}/assign`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ calendar_event_id: massWed, expected_calendar_event_id: null })
    expect(stale.status).toBe(409)
    const check = await request(server).get(`/api/mass-intentions/${openId}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(check.body.calendar_event_id).toBe(massTue)
    expect(check.body.mass_date).toBe('2027-06-08')
  })

  it('rapid reassignment to another Mass succeeds without expected', async () => {
    const res = await request(server).post(`/api/mass-intentions/${openId}/assign`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ calendar_event_id: massWed })
    expect(res.status).toBe(200)
    expect(res.body.calendar_event_id).toBe(massWed)
    expect(res.body.mass_date).toBe('2027-06-09')
    expect(res.body.status).toBe('scheduled')
  })

  it('concurrent double-assign serializes on the row — one Mass wins, nothing is lost', async () => {
    const fresh = await request(server).post('/api/mass-intentions')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ intention: `Race ${RUN_ID}` })
    expect(fresh.status).toBe(201)

    const [a, b] = await Promise.all([
      request(server).post(`/api/mass-intentions/${fresh.body.id}/assign`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ calendar_event_id: massTue, expected_calendar_event_id: null }),
      request(server).post(`/api/mass-intentions/${fresh.body.id}/assign`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ calendar_event_id: massWed, expected_calendar_event_id: null }),
    ])
    const statuses = [a.status, b.status].sort()
    expect(statuses[0]).toBe(200)
    expect([200, 409]).toContain(statuses[1])
    // Dual HTTP 200 is only tolerable when both named the SAME Mass.
    // Success for Tuesday and Wednesday at once is a false dual write.
    if (a.status === 200 && b.status === 200) {
      expect(a.body.calendar_event_id).toBe(b.body.calendar_event_id)
    }

    const row = await request(server).get(`/api/mass-intentions/${fresh.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(row.status).toBe(200)
    expect([massTue, massWed]).toContain(row.body.calendar_event_id)
    expect(row.body.status).toBe('scheduled')
    expect(['2027-06-08', '2027-06-09']).toContain(row.body.mass_date)
    const winner = row.body.calendar_event_id
    const winnerDate = winner === massTue ? '2027-06-08' : '2027-06-09'
    expect(row.body.mass_date).toBe(winnerDate)
  })

  it('refuses cancelled and fulfilled', async () => {
    const c = await request(server).post(`/api/mass-intentions/${cancelledId}/assign`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ calendar_event_id: massTue })
    expect(c.status).toBe(409)
    const f = await request(server).post(`/api/mass-intentions/${fulfilledId}/assign`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ calendar_event_id: massTue })
    expect(f.status).toBe(409)
  })

  it('refuses a foreign Mass and a foreign intention', async () => {
    const foreignEvent = await request(server).post(`/api/mass-intentions/${datedId}/assign`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ calendar_event_id: 999999999 })
    expect(foreignEvent.status).toBe(404)

    const cross = await request(server).post(`/api/mass-intentions/${datedId}/assign`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ calendar_event_id: massTue })
    expect(cross.status).toBe(404)

    const still = await request(server).get(`/api/mass-intentions/${datedId}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(still.body.calendar_event_id).toBeNull()
  })

  // SP-014..022: intentions are not in the Viewer's role table.
  it('viewers can neither read awaiting nor assign', async () => {
    const read = await request(server).get('/api/mass-intentions/awaiting?date=2027-06-08')
      .set('Authorization', `Bearer ${viewerToken}`)
    expect(read.status).toBe(403)
    const write = await request(server).post(`/api/mass-intentions/${datedId}/assign`)
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ calendar_event_id: massTue })
    expect(write.status).toBe(403)
  })
})

describe('POST /api/mass-intentions/:id/unassign (MI.4)', () => {
  it('releases the Mass, returns scheduled to open, and keeps the date', async () => {
    const res = await request(server).post(`/api/mass-intentions/${openId}/unassign`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ expected_calendar_event_id: massWed })
    expect(res.status).toBe(200)
    expect(res.body.calendar_event_id).toBeNull()
    expect(res.body.status).toBe('open')
    expect(res.body.mass_date).toBe('2027-06-09')
  })

  it('releasing twice is idempotent', async () => {
    const res = await request(server).post(`/api/mass-intentions/${openId}/unassign`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({})
    expect(res.status).toBe(200)
    expect(res.body.calendar_event_id).toBeNull()
  })
})

describe('PATCH still agrees with the Mass (MI.4)', () => {
  it('linking via PATCH promotes open → scheduled and adopts the Mass date', async () => {
    const made = await request(server).post('/api/mass-intentions')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ intention: `Patch link ${RUN_ID}` })
    expect(made.body.status).toBe('open')
    const link = await request(server).patch(`/api/mass-intentions/${made.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ calendar_event_id: massTue })
    expect(link.status).toBe(200)
    expect(link.body.status).toBe('scheduled')
    expect(link.body.mass_date).toBe('2027-06-08')
    expect(link.body.calendar_event_id).toBe(massTue)
  })

  it('clearing via PATCH demotes scheduled → open and keeps the date', async () => {
    const made = await request(server).post('/api/mass-intentions')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ intention: `Patch clear ${RUN_ID}`, calendar_event_id: massTue })
    expect(made.body.status).toBe('scheduled')
    const clear = await request(server).patch(`/api/mass-intentions/${made.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ calendar_event_id: null })
    expect(clear.status).toBe(200)
    expect(clear.body.calendar_event_id).toBeNull()
    expect(clear.body.status).toBe('open')
    expect(clear.body.mass_date).toBe('2027-06-08')
  })

  it('creating with a Mass and no status is scheduled on the Mass date', async () => {
    const res = await request(server).post('/api/mass-intentions')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ intention: `Create link ${RUN_ID}`, calendar_event_id: massWed })
    expect(res.status).toBe(201)
    expect(res.body.status).toBe('scheduled')
    expect(res.body.mass_date).toBe('2027-06-09')
    expect(res.body.calendar_event_id).toBe(massWed)
  })
})

describe('tenancy of the assignment row', () => {
  it('organization_id on the row is the caller, never a body field', async () => {
    const { rows } = await pool.query(
      `SELECT organization_id FROM ochr_mass_intentions WHERE id = $1`,
      [openId]
    )
    expect(rows[0].organization_id).toBe(orgAId)
  })
})

describe('Mass action closure keeps week + Mass + intention together (MI.4)', () => {
  it('moving a Mass adopts the new date on the book, weekly sheet, and Packet', async () => {
    const mass = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `MASS ALPHA ${RUN_ID}`,
        date: '2028-01-02',
        start_time: '08:00',
        end_time: '09:00',
        type: 'service',
      })
    expect(mass.status).toBe(201)

    const made = await request(server).post('/api/mass-intentions')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ intention: `† MOVED ${RUN_ID}` })
    const offered = await request(server).post(`/api/mass-intentions/${made.body.id}/assign`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ calendar_event_id: mass.body.id, expected_calendar_event_id: null })
    expect(offered.body.mass_date).toBe('2028-01-02')
    expect(offered.body.status).toBe('scheduled')

    const moved = await request(server).patch(`/api/calendar/${mass.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `MASS ALPHA now Omega ${RUN_ID}`,
        date: '2029-12-23',
        start_time: '08:00',
        end_time: '09:00',
        type: 'service',
        assigned_to: [],
      })
    expect(moved.status).toBe(200)

    const book = await request(server).get(`/api/mass-intentions/${made.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(book.body.calendar_event_id).toBe(mass.body.id)
    expect(book.body.mass_date).toBe('2029-12-23')
    expect(book.body.status).toBe('scheduled')
    expect(book.body.mass_title).toContain('Omega')

    const weekAlpha = await request(server)
      .get('/api/mass-intentions/weekly?start=2028-01-02&end=2028-01-08')
      .set('Authorization', `Bearer ${tokenA}`)
    const weekOmega = await request(server)
      .get('/api/mass-intentions/weekly?start=2029-12-23&end=2029-12-29')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(weekAlpha.body.intentions.some(r => r.id === made.body.id)).toBe(false)
    const omegaRow = weekOmega.body.intentions.find(r => r.id === made.body.id)
    expect(omegaRow).toBeTruthy()
    expect(omegaRow.mass_date).toBe('2029-12-23')
    expect(omegaRow.calendar_event_id).toBe(mass.body.id)

    const pktAlpha = await request(server)
      .get('/api/packet?date=2028-01-02')
      .set('Authorization', `Bearer ${tokenA}`)
    const pktOmega = await request(server)
      .get('/api/packet?date=2029-12-23')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(pktAlpha.body.intentions.some(r =>
      (r.formatted_intention || r.intention || '').includes(`MOVED ${RUN_ID}`)
    )).toBe(false)
    expect(pktOmega.body.intentions.some(r =>
      (r.formatted_intention || r.intention || '').includes(`MOVED ${RUN_ID}`)
    )).toBe(true)
  })

  it('deleting a Mass releases scheduled → open and does not invent a scheduled-unassigned row', async () => {
    const mass = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `MASS TO DELETE ${RUN_ID}`,
        date: '2028-01-05',
        start_time: '07:00',
        end_time: '08:00',
        type: 'service',
      })
    expect(mass.status).toBe(201)

    const made = await request(server).post('/api/mass-intentions')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ intention: `† DELETE MASS ${RUN_ID}` })
    await request(server).post(`/api/mass-intentions/${made.body.id}/assign`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ calendar_event_id: mass.body.id, expected_calendar_event_id: null })

    const datedOnly = await request(server).post('/api/mass-intentions')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ intention: `Dated scheduled stays ${RUN_ID}`, mass_date: '2028-01-06', status: 'scheduled' })
    expect(datedOnly.body.calendar_event_id).toBeNull()
    expect(datedOnly.body.status).toBe('scheduled')

    const del = await request(server).delete(`/api/calendar/${mass.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(del.status).toBe(204)

    const book = await request(server).get(`/api/mass-intentions/${made.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(book.body.calendar_event_id).toBeNull()
    expect(book.body.status).toBe('open')
    expect(book.body.mass_date).toBe('2028-01-05')

    const untouched = await request(server).get(`/api/mass-intentions/${datedOnly.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(untouched.body.status).toBe('scheduled')
    expect(untouched.body.calendar_event_id).toBeNull()
    expect(untouched.body.mass_date).toBe('2028-01-06')
  })

  it('a fulfilled intention keeps its date when the Mass is moved', async () => {
    const mass = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `MASS FULFILLED ${RUN_ID}`,
        date: '2028-02-06',
        start_time: '09:00',
        end_time: '10:00',
        type: 'service',
      })
    const made = await request(server).post('/api/mass-intentions')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ intention: `† FULFILLED STAYS ${RUN_ID}`, calendar_event_id: mass.body.id })
    expect(made.body.status).toBe('scheduled')
    const mark = await request(server).patch(`/api/mass-intentions/${made.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ status: 'fulfilled' })
    expect(mark.body.status).toBe('fulfilled')
    expect(mark.body.mass_date).toBe('2028-02-06')
    expect(mark.body.mass_title).toBe(`MASS FULFILLED ${RUN_ID}`)
    expect(mark.body.mass_time).toBe('09:00')

    const moved = await request(server).patch(`/api/calendar/${mass.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `MASS FULFILLED moved ${RUN_ID}`,
        date: '2029-11-04',
        start_time: '09:00',
        end_time: '10:00',
        type: 'service',
        assigned_to: [],
      })
    expect(moved.status).toBe(200)

    const book = await request(server).get(`/api/mass-intentions/${made.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(book.body.status).toBe('fulfilled')
    expect(book.body.mass_date).toBe('2028-02-06')
    expect(book.body.mass_title).toBe(`MASS FULFILLED ${RUN_ID}`)
    expect(book.body.mass_time).toBe('09:00')
    expect(book.body.calendar_event_id).toBe(mass.body.id)
  })
})

// POST and PATCH that name a calendar_event_id adopt that Mass's date.
// PATCH of mass_date alone, while a Mass on another day is still linked,
// is 409 and does not write. Unassign (calendar_event_id: null) keeps
// the date. Moving the Mass in SQL still updates open/scheduled dates.
describe('linked Mass date and a typed day', () => {
  it('PATCH mass_date alone on a different day is 409 and leaves the row', async () => {
    const mass = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `MASS ON MARCH 2 ${RUN_ID}`,
        date: '2031-03-02',
        start_time: '09:30',
        end_time: '10:30',
        type: 'service',
      })
    expect(mass.status).toBe(201)

    const created = await request(server).post('/api/mass-intentions')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        intention: `Disagree ${RUN_ID}`,
        calendar_event_id: mass.body.id,
      })
    expect(created.status).toBe(201)
    expect(created.body.calendar_event_id).toBe(mass.body.id)
    expect(created.body.mass_date).toBe('2031-03-02')
    expect(created.body.mass_title).toBe(`MASS ON MARCH 2 ${RUN_ID}`)

    const shifted = await request(server).patch(`/api/mass-intentions/${created.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ mass_date: '2031-03-09', note: 'must not land' })
    expect(shifted.status).toBe(409)
    expect(shifted.body.error).toBe(REFUSE_DATE_DISAGREES)
    expect(shifted.body.code).toBe('date_conflict')

    const kept = await request(server).get(`/api/mass-intentions/${created.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(kept.status).toBe(200)
    expect(kept.body.mass_date).toBe('2031-03-02')
    expect(kept.body.calendar_event_id).toBe(mass.body.id)
    expect(kept.body.mass_title).toBe(`MASS ON MARCH 2 ${RUN_ID}`)
    expect(kept.body.mass_time).toBe('09:30')
    expect(kept.body.note == null || kept.body.note === '').toBe(true)

    const weekOfTyped = await request(server)
      .get('/api/mass-intentions/weekly?start=2031-03-09&end=2031-03-15')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(weekOfTyped.body.intentions.some(r => r.id === created.body.id)).toBe(false)

    const weekOfMass = await request(server)
      .get('/api/mass-intentions/weekly?start=2031-03-02&end=2031-03-08')
      .set('Authorization', `Bearer ${tokenA}`)
    const listed = weekOfMass.body.intentions.find(r => r.id === created.body.id)
    expect(listed).toBeTruthy()
    expect(listed.mass_date).toBe('2031-03-02')
    expect(listed.calendar_event_id).toBe(mass.body.id)

    const beforeRefuse = await auditCountForIntention(orgAId, created.body.id)
    const both = await request(server).patch(`/api/mass-intentions/${created.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ mass_date: '2031-03-16', calendar_event_id: mass.body.id, note: 'same mass, other day' })
    expect(both.status).toBe(409)
    expect(both.body.error).toBe(REFUSE_DATE_DISAGREES)
    expect(both.body.code).toBe('date_conflict')
    const keptSame = await request(server).get(`/api/mass-intentions/${created.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(keptSame.body.mass_date).toBe('2031-03-02')
    expect(keptSame.body.calendar_event_id).toBe(mass.body.id)
    expect(keptSame.body.note == null || keptSame.body.note === '').toBe(true)
    await new Promise(r => setTimeout(r, 400))
    expect(await auditCountForIntention(orgAId, created.body.id)).toBe(beforeRefuse)

    const blank = await request(server).patch(`/api/mass-intentions/${created.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ mass_date: '' })
    expect(blank.status).toBe(409)
    const nulled = await request(server).patch(`/api/mass-intentions/${created.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ mass_date: null })
    expect(nulled.status).toBe(409)
    const blankSame = await request(server).patch(`/api/mass-intentions/${created.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ mass_date: '', calendar_event_id: mass.body.id })
    expect(blankSame.status).toBe(409)
    const nullSame = await request(server).patch(`/api/mass-intentions/${created.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ mass_date: null, calendar_event_id: mass.body.id })
    expect(nullSame.status).toBe(409)
    const still = await request(server).get(`/api/mass-intentions/${created.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(still.body.mass_date).toBe('2031-03-02')
    expect(still.body.calendar_event_id).toBe(mass.body.id)
  })

  it('PATCH that changes the Mass stores that Mass day, even if the typed day differs', async () => {
    const first = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `MASS FIRST ${RUN_ID}`,
        date: '2031-06-01',
        start_time: '09:00',
        end_time: '10:00',
        type: 'service',
      })
    const second = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `MASS SECOND ${RUN_ID}`,
        date: '2031-06-08',
        start_time: '09:00',
        end_time: '10:00',
        type: 'service',
      })
    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    const created = await request(server).post('/api/mass-intentions')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        intention: `Move mass ${RUN_ID}`,
        calendar_event_id: first.body.id,
      })
    expect(created.status).toBe(201)
    expect(created.body.mass_date).toBe('2031-06-01')

    const moved = await request(server).patch(`/api/mass-intentions/${created.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ mass_date: '2031-12-25', calendar_event_id: second.body.id })
    expect(moved.status).toBe(200)
    expect(moved.body.calendar_event_id).toBe(second.body.id)
    expect(moved.body.mass_date).toBe('2031-06-08')
  })

  it('POST, a new link, and assign refuse a meeting and change nothing', async () => {
    const meeting = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `MEETING ${RUN_ID}`,
        date: '2031-06-08',
        start_time: '19:00',
        end_time: '20:00',
        type: 'meeting',
      })
    expect(meeting.status).toBe(201)
    const before = await pool.query(
      'SELECT COUNT(*)::int AS c FROM ochr_mass_intentions WHERE organization_id = $1',
      [orgAId],
    )
    const posted = await request(server).post('/api/mass-intentions')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ intention: `At the meeting ${RUN_ID}`, calendar_event_id: meeting.body.id, mass_date: '2031-12-25' })
    expect(posted.status).toBe(409)
    expect(posted.body.error).toBe(REFUSE_NOT_A_MASS)
    expect(posted.body.code).toBe('not_a_mass')
    const after = await pool.query(
      'SELECT COUNT(*)::int AS c FROM ochr_mass_intentions WHERE organization_id = $1',
      [orgAId],
    )
    expect(after.rows[0].c).toBe(before.rows[0].c)

    const mass = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `MASS BESIDE MEETING ${RUN_ID}`,
        date: '2031-06-01',
        start_time: '09:00',
        end_time: '10:00',
        type: 'service',
      })
    const created = await request(server).post('/api/mass-intentions')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ intention: `Keep the Mass ${RUN_ID}`, calendar_event_id: mass.body.id })
    expect(created.status).toBe(201)

    const relink = await request(server).patch(`/api/mass-intentions/${created.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ mass_date: '2031-12-25', calendar_event_id: meeting.body.id, note: 'must not land' })
    expect(relink.status).toBe(409)
    expect(relink.body.error).toBe(REFUSE_NOT_A_MASS)
    const still = await request(server).get(`/api/mass-intentions/${created.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(still.body.calendar_event_id).toBe(mass.body.id)
    expect(still.body.mass_date).toBe('2031-06-01')
    expect(still.body.note == null || still.body.note === '').toBe(true)

    const loose = await request(server).post('/api/mass-intentions')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ intention: `Unassigned ${RUN_ID}` })
    expect(loose.status).toBe(201)
    const assigned = await request(server).post(`/api/mass-intentions/${loose.body.id}/assign`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ calendar_event_id: meeting.body.id })
    expect(assigned.status).toBe(409)
    expect(assigned.body.error).toBe(REFUSE_NOT_A_MASS)
    expect(assigned.body.code).toBe('not_a_mass')
    const looseAfter = await request(server).get(`/api/mass-intentions/${loose.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(looseAfter.body.calendar_event_id).toBeNull()
  })

  it("refuses 'Meeting' and ' meeting ' on POST, PATCH, and assign", async () => {
    const mass = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `MASS BESIDE CASED MEETING ${RUN_ID}`,
        date: '2032-04-04',
        start_time: '09:00',
        end_time: '10:00',
        type: 'service',
      })
    expect(mass.status).toBe(201)
    const created = await request(server).post('/api/mass-intentions')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ intention: `Beside a cased meeting ${RUN_ID}`, calendar_event_id: mass.body.id })
    expect(created.status).toBe(201)
    const loose = await request(server).post('/api/mass-intentions')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ intention: `Loose cased meeting ${RUN_ID}` })
    expect(loose.status).toBe(201)

    for (const type of ['Meeting', ' meeting ']) {
      const meeting = await request(server).post('/api/calendar')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          title: `CASED ${type} ${RUN_ID}`,
          date: '2032-04-04',
          start_time: '19:00',
          end_time: '20:00',
          type,
        })
      expect(meeting.status).toBe(201)
      expect(meeting.body.type).toBe(type)

      const before = await pool.query(
        'SELECT COUNT(*)::int AS c FROM ochr_mass_intentions WHERE organization_id = $1',
        [orgAId],
      )
      const posted = await request(server).post('/api/mass-intentions')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ intention: `At ${type} ${RUN_ID}`, calendar_event_id: meeting.body.id })
      expect(posted.status).toBe(409)
      expect(posted.body.error).toBe(REFUSE_NOT_A_MASS)
      expect(posted.body.code).toBe('not_a_mass')
      const after = await pool.query(
        'SELECT COUNT(*)::int AS c FROM ochr_mass_intentions WHERE organization_id = $1',
        [orgAId],
      )
      expect(after.rows[0].c).toBe(before.rows[0].c)

      const relink = await request(server).patch(`/api/mass-intentions/${created.body.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ calendar_event_id: meeting.body.id, note: 'must not land' })
      expect(relink.status).toBe(409)
      expect(relink.body.code).toBe('not_a_mass')
      const still = await request(server).get(`/api/mass-intentions/${created.body.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
      expect(still.body.calendar_event_id).toBe(mass.body.id)
      expect(still.body.note == null || still.body.note === '').toBe(true)

      const assigned = await request(server).post(`/api/mass-intentions/${loose.body.id}/assign`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ calendar_event_id: meeting.body.id })
      expect(assigned.status).toBe(409)
      expect(assigned.body.code).toBe('not_a_mass')
      const looseAfter = await request(server).get(`/api/mass-intentions/${loose.body.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
      expect(looseAfter.body.calendar_event_id).toBeNull()
    }
  })

  it('an existing meeting link still accepts a note, and a same-id PATCH does not rewrite the day', async () => {
    const mass = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `WAS A MASS ${RUN_ID}`,
        date: '2031-07-01',
        start_time: '09:00',
        end_time: '10:00',
        type: 'service',
      })
    const created = await request(server).post('/api/mass-intentions')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ intention: `Historical link ${RUN_ID}`, calendar_event_id: mass.body.id })
    expect(created.status).toBe(201)
    const typed = await request(server).patch(`/api/calendar/${mass.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `NOW A MEETING ${RUN_ID}`,
        date: '2031-07-01',
        start_time: '09:00',
        end_time: '10:00',
        type: 'meeting',
        assigned_to: [],
      })
    expect(typed.status).toBe(200)
    await pool.query(
      `UPDATE ochr_mass_intentions SET mass_date = '2031-01-15'::date WHERE id = $1 AND organization_id = $2`,
      [created.body.id, orgAId],
    )

    const noted = await request(server).patch(`/api/mass-intentions/${created.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ note: 'still linked' })
    expect(noted.status).toBe(200)
    expect(noted.body.calendar_event_id).toBe(mass.body.id)
    expect(noted.body.note).toBe('still linked')

    const same = await request(server).patch(`/api/mass-intentions/${created.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ calendar_event_id: mass.body.id, note: 'same link' })
    expect(same.status).toBe(200)
    expect(same.body.calendar_event_id).toBe(mass.body.id)
    const stored = await pool.query(
      `SELECT to_char(mass_date, 'YYYY-MM-DD') AS mass_date FROM ochr_mass_intentions WHERE id = $1`,
      [created.body.id],
    )
    expect(stored.rows[0].mass_date).toBe('2031-01-15')
  })

  it('a same-Mass PATCH with no date field returns 200', async () => {
    const mass = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `MASS NO DATE FIELD ${RUN_ID}`,
        date: '2031-08-02',
        start_time: '09:00',
        end_time: '10:00',
        type: 'service',
      })
    const created = await request(server).post('/api/mass-intentions')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ intention: `No date field ${RUN_ID}`, calendar_event_id: mass.body.id })
    expect(created.status).toBe(201)
    const patched = await request(server).patch(`/api/mass-intentions/${created.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ calendar_event_id: mass.body.id, note: 'no date key' })
    expect(patched.status).toBe(200)
    expect(patched.body.mass_date).toBe('2031-08-02')
    expect(patched.body.calendar_event_id).toBe(mass.body.id)
    expect(patched.body.note).toBe('no date key')
  })

  it('a fulfilled row with no stamp still accepts a note sent with the same Mass and a blank date', async () => {
    const mass = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `MASS BLANK STAMP ${RUN_ID}`,
        date: '2031-09-07',
        start_time: '09:00',
        end_time: '10:00',
        type: 'service',
      })
    const created = await request(server).post('/api/mass-intentions')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ intention: `Blank stamp ${RUN_ID}`, calendar_event_id: mass.body.id })
    const marked = await request(server).patch(`/api/mass-intentions/${created.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ status: 'fulfilled' })
    expect(marked.status).toBe(200)
    await pool.query(
      `UPDATE ochr_mass_intentions
          SET fulfilled_mass_date = NULL, fulfilled_mass_title = NULL, fulfilled_mass_time = NULL
        WHERE id = $1 AND organization_id = $2`,
      [created.body.id, orgAId],
    )
    const noted = await request(server).patch(`/api/mass-intentions/${created.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ note: 'older book', mass_date: null, calendar_event_id: mass.body.id })
    expect(noted.status).toBe(200)
    expect(noted.body.note).toBe('older book')
    expect(noted.body.status).toBe('fulfilled')
    expect(noted.body.mass_date).toBeNull()
    expect(noted.body.calendar_event_id).toBe(mass.body.id)
    const stored = await pool.query(
      `SELECT to_char(mass_date, 'YYYY-MM-DD') AS mass_date,
              fulfilled_mass_date, fulfilled_mass_title, fulfilled_mass_time, note
         FROM ochr_mass_intentions WHERE id = $1`,
      [created.body.id],
    )
    expect(stored.rows[0].mass_date).toBe('2031-09-07')
    expect(stored.rows[0].fulfilled_mass_date).toBeNull()
    expect(stored.rows[0].fulfilled_mass_title).toBeNull()
    expect(stored.rows[0].fulfilled_mass_time).toBeNull()
    expect(stored.rows[0].note).toBe('older book')
  })

  it('a fulfilled row whose Mass later moved still accepts a note sent with the stamp date', async () => {
    const mass = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `MASS STAMP THEN MOVE ${RUN_ID}`,
        date: '2031-09-14',
        start_time: '11:00',
        end_time: '12:00',
        type: 'service',
      })
    const created = await request(server).post('/api/mass-intentions')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ intention: `Stamp then move ${RUN_ID}`, calendar_event_id: mass.body.id })
    const marked = await request(server).patch(`/api/mass-intentions/${created.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ status: 'fulfilled' })
    expect(marked.body.mass_date).toBe('2031-09-14')
    const moved = await request(server).patch(`/api/calendar/${mass.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `MASS STAMP THEN MOVE ${RUN_ID}`,
        date: '2031-09-21',
        start_time: '11:00',
        end_time: '12:00',
        type: 'service',
        assigned_to: [],
      })
    expect(moved.status).toBe(200)
    const noted = await request(server).patch(`/api/mass-intentions/${created.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        note: 'after the move',
        mass_date: '2031-09-14',
        calendar_event_id: mass.body.id,
      })
    expect(noted.status).toBe(200)
    expect(noted.body.note).toBe('after the move')
    expect(noted.body.mass_date).toBe('2031-09-14')
    expect(noted.body.mass_title).toBe(`MASS STAMP THEN MOVE ${RUN_ID}`)
    expect(noted.body.calendar_event_id).toBe(mass.body.id)
    const stored = await pool.query(
      `SELECT to_char(mass_date, 'YYYY-MM-DD') AS mass_date,
              to_char(fulfilled_mass_date, 'YYYY-MM-DD') AS fulfilled_mass_date
         FROM ochr_mass_intentions WHERE id = $1`,
      [created.body.id],
    )
    expect(stored.rows[0].mass_date).toBe('2031-09-14')
    expect(stored.rows[0].fulfilled_mass_date).toBe('2031-09-14')
  })

  it('reopening a fulfilled intention after its Mass moved stores that Mass’s current day', async () => {
    const mass = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `MASS THEN REOPEN ${RUN_ID}`,
        date: '2032-10-06',
        start_time: '10:00',
        end_time: '11:00',
        type: 'service',
      })
    expect(mass.status).toBe(201)
    const created = await request(server).post('/api/mass-intentions')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ intention: `Reopen after move ${RUN_ID}`, calendar_event_id: mass.body.id })
    const named = await request(server).post('/api/mass-intentions')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ intention: `Reopen naming the Mass ${RUN_ID}`, calendar_event_id: mass.body.id })
    const marked = await request(server).patch(`/api/mass-intentions/${created.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ status: 'fulfilled' })
    const namedMarked = await request(server).patch(`/api/mass-intentions/${named.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ status: 'fulfilled' })
    expect(marked.status).toBe(200)
    expect(marked.body.status).toBe('fulfilled')
    expect(marked.body.mass_date).toBe('2032-10-06')
    expect(namedMarked.body.mass_date).toBe('2032-10-06')
    const moved = await request(server).patch(`/api/calendar/${mass.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `MASS THEN REOPEN ${RUN_ID}`,
        date: '2032-10-08',
        start_time: '10:00',
        end_time: '11:00',
        type: 'service',
        assigned_to: [],
      })
    expect(moved.status).toBe(200)
    const before = await pool.query(
      `SELECT status, calendar_event_id,
              to_char(mass_date, 'YYYY-MM-DD') AS mass_date,
              to_char(fulfilled_mass_date, 'YYYY-MM-DD') AS fulfilled_mass_date
         FROM ochr_mass_intentions WHERE id = $1`,
      [created.body.id],
    )
    expect(before.rows[0].status).toBe('fulfilled')
    expect(before.rows[0].mass_date).toBe('2032-10-06')
    expect(before.rows[0].fulfilled_mass_date).toBe('2032-10-06')

    const reopened = await request(server).patch(`/api/mass-intentions/${created.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ status: 'open' })
    expect(reopened.status).toBe(200)
    expect(reopened.body.status).toBe('scheduled')
    expect(reopened.body.calendar_event_id).toBe(mass.body.id)
    expect(reopened.body.mass_date).toBe('2032-10-08')
    const stored = await pool.query(
      `SELECT status, calendar_event_id,
              to_char(mass_date, 'YYYY-MM-DD') AS mass_date,
              to_char(fulfilled_mass_date, 'YYYY-MM-DD') AS fulfilled_mass_date
         FROM ochr_mass_intentions WHERE id = $1`,
      [created.body.id],
    )
    expect(stored.rows[0].status).toBe('scheduled')
    expect(stored.rows[0].calendar_event_id).toBe(mass.body.id)
    expect(stored.rows[0].mass_date).toBe('2032-10-08')
    expect(stored.rows[0].fulfilled_mass_date).toBe('2032-10-06')

    const namedOpen = await request(server).patch(`/api/mass-intentions/${named.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ status: 'open', calendar_event_id: mass.body.id })
    expect(namedOpen.status).toBe(200)
    expect(namedOpen.body.status).toBe('scheduled')
    expect(namedOpen.body.mass_date).toBe('2032-10-08')
    expect(namedOpen.body.calendar_event_id).toBe(mass.body.id)
  })

  // R3: leaving fulfilled still re-syncs when the next status is cancelled.
  // A mutant that skips re-sync for cancelled keeps the old day.
  it('cancelling a fulfilled intention after its Mass moved stores that Mass’s current day', async () => {
    const mass = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `MASS THEN CANCEL ${RUN_ID}`,
        date: '2033-01-09',
        start_time: '10:00',
        end_time: '11:00',
        type: 'service',
      })
    expect(mass.status).toBe(201)
    const created = await request(server).post('/api/mass-intentions')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ intention: `Cancel after move ${RUN_ID}`, calendar_event_id: mass.body.id })
    expect(created.status).toBe(201)
    const marked = await request(server).patch(`/api/mass-intentions/${created.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ status: 'fulfilled' })
    expect(marked.status).toBe(200)
    expect(marked.body.mass_date).toBe('2033-01-09')
    const moved = await request(server).patch(`/api/calendar/${mass.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `MASS THEN CANCEL ${RUN_ID}`,
        date: '2033-01-11',
        start_time: '10:00',
        end_time: '11:00',
        type: 'service',
        assigned_to: [],
      })
    expect(moved.status).toBe(200)

    const cancelled = await request(server).patch(`/api/mass-intentions/${created.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ status: 'cancelled' })
    expect(cancelled.status).toBe(200)
    expect(cancelled.body.status).toBe('cancelled')
    expect(cancelled.body.calendar_event_id).toBe(mass.body.id)
    expect(cancelled.body.mass_date).toBe('2033-01-11')
    const stored = await pool.query(
      `SELECT status, calendar_event_id,
              to_char(mass_date, 'YYYY-MM-DD') AS mass_date,
              to_char(fulfilled_mass_date, 'YYYY-MM-DD') AS fulfilled_mass_date
         FROM ochr_mass_intentions WHERE id = $1`,
      [created.body.id],
    )
    expect(stored.rows[0].status).toBe('cancelled')
    expect(stored.rows[0].calendar_event_id).toBe(mass.body.id)
    expect(stored.rows[0].mass_date).toBe('2033-01-11')
    expect(stored.rows[0].fulfilled_mass_date).toBe('2033-01-09')
  })

  // R10: a historical meeting link is not re-synced on reopen.
  // A mutant that adopts the meeting's later day stores that day.
  it('reopening a fulfilled intention whose link is now a meeting keeps the stored day', async () => {
    const mass = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `MASS THEN MEETING ${RUN_ID}`,
        date: '2033-02-07',
        start_time: '10:00',
        end_time: '11:00',
        type: 'service',
      })
    expect(mass.status).toBe(201)
    const created = await request(server).post('/api/mass-intentions')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ intention: `Reopen a meeting link ${RUN_ID}`, calendar_event_id: mass.body.id })
    expect(created.status).toBe(201)
    const marked = await request(server).patch(`/api/mass-intentions/${created.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ status: 'fulfilled' })
    expect(marked.status).toBe(200)
    expect(marked.body.mass_date).toBe('2033-02-07')
    await pool.query(
      `UPDATE ochr_calendar_events
          SET type = 'meeting', date = '2033-02-14'
        WHERE id = $1 AND organization_id = $2`,
      [mass.body.id, orgAId],
    )

    const reopened = await request(server).patch(`/api/mass-intentions/${created.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ status: 'open' })
    expect(reopened.status).toBe(200)
    expect(reopened.body.status).toBe('scheduled')
    expect(reopened.body.calendar_event_id).toBe(mass.body.id)
    expect(reopened.body.mass_date).toBe('2033-02-07')
    const stored = await pool.query(
      `SELECT status, calendar_event_id,
              to_char(mass_date, 'YYYY-MM-DD') AS mass_date,
              to_char(fulfilled_mass_date, 'YYYY-MM-DD') AS fulfilled_mass_date
         FROM ochr_mass_intentions WHERE id = $1`,
      [created.body.id],
    )
    expect(stored.rows[0].status).toBe('scheduled')
    expect(stored.rows[0].calendar_event_id).toBe(mass.body.id)
    expect(stored.rows[0].mass_date).toBe('2033-02-07')
    expect(stored.rows[0].fulfilled_mass_date).toBe('2033-02-07')
  })

  it('POST with a date that is not the Mass day is 409 and writes nothing', async () => {
    const mass = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `MASS ON OCT 5 ${RUN_ID}`,
        date: '2026-10-05',
        start_time: '09:00',
        end_time: '10:00',
        type: 'service',
      })
    expect(mass.status).toBe(201)

    const beforeRows = await intentionCount(orgAId)
    const beforeAudit = await auditCountForOrgIntentions(orgAId)
    const created = await request(server).post('/api/mass-intentions')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        intention: `Typed Oct 4 ${RUN_ID}`,
        mass_date: '2026-10-04',
        calendar_event_id: mass.body.id,
      })
    expect(created.status).toBe(409)
    expect(created.body.error).toBe(REFUSE_DATE_DISAGREES)
    expect(created.body.code).toBe('date_conflict')
    expect(await intentionCount(orgAId)).toBe(beforeRows)
    const named = await pool.query(
      `SELECT COUNT(*)::int AS c FROM ochr_mass_intentions
        WHERE organization_id = $1 AND intention = $2`,
      [orgAId, `Typed Oct 4 ${RUN_ID}`],
    )
    expect(named.rows[0].c).toBe(0)
    await new Promise(r => setTimeout(r, 400))
    expect(await auditCountForOrgIntentions(orgAId)).toBe(beforeAudit)
  })

  it('POST with the Mass day stores that day, and an omitted date is derived from the Mass', async () => {
    const mass = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `MASS ON OCT 5 MATCH ${RUN_ID}`,
        date: '2026-10-05',
        start_time: '09:00',
        end_time: '10:00',
        type: 'service',
      })
    expect(mass.status).toBe(201)

    const matched = await request(server).post('/api/mass-intentions')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        intention: `Matched Oct 5 ${RUN_ID}`,
        mass_date: '2026-10-05',
        calendar_event_id: mass.body.id,
      })
    expect(matched.status).toBe(201)
    expect(matched.body.calendar_event_id).toBe(mass.body.id)
    expect(matched.body.mass_date).toBe('2026-10-05')
    expect(matched.body.status).toBe('scheduled')

    const derived = await request(server).post('/api/mass-intentions')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        intention: `Derived Oct 5 ${RUN_ID}`,
        calendar_event_id: mass.body.id,
      })
    expect(derived.status).toBe(201)
    expect(derived.body.calendar_event_id).toBe(mass.body.id)
    expect(derived.body.mass_date).toBe('2026-10-05')
    expect(derived.body.status).toBe('scheduled')

    const week = await request(server)
      .get('/api/mass-intentions/weekly?start=2026-10-04&end=2026-10-10')
      .set('Authorization', `Bearer ${tokenA}`)
    const listed = week.body.intentions.find(r => r.id === derived.body.id)
    expect(listed).toBeTruthy()
    expect(listed.mass_date).toBe('2026-10-05')
    expect(listed.calendar_event_id).toBe(mass.body.id)
  })

  it('POST of another parish Mass is 404 and writes nothing in either parish', async () => {
    const mass = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `MASS PARISH A ONLY ${RUN_ID}`,
        date: '2026-10-05',
        start_time: '09:00',
        end_time: '10:00',
        type: 'service',
      })
    expect(mass.status).toBe(201)
    const beforeA = await intentionCount(orgAId)
    const beforeB = await intentionCount(orgBId)
    const cross = await request(server).post('/api/mass-intentions')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({
        intention: `Cross tenant ${RUN_ID}`,
        mass_date: '2026-10-04',
        calendar_event_id: mass.body.id,
      })
    expect(cross.status).toBe(404)
    expect(cross.body.error).toBe('Mass not found on your calendar')
    expect(await intentionCount(orgAId)).toBe(beforeA)
    expect(await intentionCount(orgBId)).toBe(beforeB)
  })

  it('PATCH mass_date to the Mass day is kept, and a date with no Mass is kept', async () => {
    const mass = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `MASS SAME DAY ${RUN_ID}`,
        date: '2031-04-06',
        start_time: '08:00',
        end_time: '09:00',
        type: 'service',
      })
    expect(mass.status).toBe(201)
    const created = await request(server).post('/api/mass-intentions')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        intention: `Same day ${RUN_ID}`,
        calendar_event_id: mass.body.id,
      })
    expect(created.status).toBe(201)
    expect(created.body.mass_date).toBe('2031-04-06')

    expect(intentionCalendarDay('2031-04-06T00:00:00.000Z')).toBe('2031-04-06')
    expect(intentionCalendarDay('2031-04-05T07:00:00.000Z')).toBe('')
    const same = await request(server).patch(`/api/mass-intentions/${created.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ mass_date: '2031-04-06' })
    expect(same.status).toBe(200)
    expect(same.body.mass_date).toBe('2031-04-06')
    expect(same.body.calendar_event_id).toBe(mass.body.id)

    const bare = await request(server).post('/api/mass-intentions')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ intention: `No Mass ${RUN_ID}`, mass_date: '2031-04-07' })
    expect(bare.status).toBe(201)
    const moved = await request(server).patch(`/api/mass-intentions/${bare.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ mass_date: '2031-04-08' })
    expect(moved.status).toBe(200)
    expect(moved.body.mass_date).toBe('2031-04-08')
    expect(moved.body.calendar_event_id).toBeNull()
  })

  it('unassign keeps the date, and a date sent with calendar_event_id null is stored', async () => {
    const mass = await request(server).post('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: `MASS UNASSIGN ${RUN_ID}`,
        date: '2031-05-03',
        start_time: '11:00',
        end_time: '12:00',
        type: 'service',
      })
    expect(mass.status).toBe(201)
    const created = await request(server).post('/api/mass-intentions')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        intention: `Unassign keeps ${RUN_ID}`,
        calendar_event_id: mass.body.id,
        status: 'scheduled',
      })
    expect(created.status).toBe(201)
    expect(created.body.mass_date).toBe('2031-05-03')

    const released = await request(server).patch(`/api/mass-intentions/${created.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ calendar_event_id: null })
    expect(released.status).toBe(200)
    expect(released.body.calendar_event_id).toBeNull()
    expect(released.body.mass_date).toBe('2031-05-03')

    const relinked = await request(server).patch(`/api/mass-intentions/${created.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ calendar_event_id: mass.body.id })
    expect(relinked.status).toBe(200)
    expect(relinked.body.mass_date).toBe('2031-05-03')

    const dated = await request(server).patch(`/api/mass-intentions/${created.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ calendar_event_id: null, mass_date: '2031-05-10' })
    expect(dated.status).toBe(200)
    expect(dated.body.calendar_event_id).toBeNull()
    expect(dated.body.mass_date).toBe('2031-05-10')
  })
})
