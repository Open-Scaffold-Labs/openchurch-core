// F6 on /assign and /unassign (same ordering as patchIntention, #405 / R405-1).
//
// A fulfilled or stamped intention that would change its Mass through
// assign or unassign must answer 409 fulfilled_offering_locked BEFORE
// the older stamped_history refusal. The row, its stamp, corrections,
// and audit trail are unchanged. N449-3: void of fulfilled+held 2330 is refused
// (deferred remittance / SP-268); open or zero-liability voids still work.
// Same-Mass assign on a reopened stamped row is still the no-op.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
import {
  FULFILLED_OFFERING_LOCKED_CODE,
  STAMPED_HISTORY_CODE,
} from '../src/routes/massIntentions.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'

let server, tokenA, orgA, tokenB

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  const a = await createOrg(server, {
    organizationName: `F6 Assign ${RUN_ID}`,
    name: 'Ada Admin',
    email: `f6_assign_${RUN_ID}@example.com`,
    password: 'f6-assign-pw-0001',
  }, '10.253.1.1')
  expect(a.status).toBe(201)
  tokenA = a.body.token
  orgA = a.body.user.organization.id
  const b = await createOrg(server, {
    organizationName: `F6 Assign Other ${RUN_ID}`,
    name: 'Bea Admin',
    email: `f6_assign_b_${RUN_ID}@example.com`,
    password: 'f6-assign-pw-0001',
  }, '10.253.1.2')
  expect(b.status).toBe(201)
  tokenB = b.body.token
}, 60_000)

afterAll(async () => {
  await closeServer(server)
  await pool.end()
})

const auth = token => ({ Authorization: `Bearer ${token}` })

async function mass(title, date, start = '09:00') {
  const res = await request(server).post('/api/calendar').set(auth(tokenA)).send({
    title, date, start_time: start, end_time: '23:00', type: 'service',
  })
  expect(res.status).toBe(201)
  return res.body
}

async function offerThenFulfill(intention, massRow, stipend = '12.00') {
  const body = { intention, calendar_event_id: massRow.id }
  if (stipend != null) body.stipend = stipend
  const made = await request(server).post('/api/mass-intentions').set(auth(tokenA)).send(body)
  expect(made.status).toBe(201)
  const mark = await request(server).patch(`/api/mass-intentions/${made.body.id}`)
    .set(auth(tokenA)).send({ status: 'fulfilled' })
  expect(mark.status).toBe(200)
  return made.body.id
}

async function snap(id) {
  const row = (await pool.query(
    `SELECT status, calendar_event_id, stipend::text AS stipend,
            fulfilled_mass_date::text AS fulfilled_mass_date,
            fulfilled_mass_title, fulfilled_mass_time::text AS fulfilled_mass_time,
            entered_history, voided_at
       FROM ochr_mass_intentions WHERE id = $1 AND organization_id = $2`,
    [id, orgA],
  )).rows[0]
  const corr = Number((await pool.query(
    'SELECT count(*) FROM ochr_mass_intention_corrections WHERE mass_intention_id = $1 AND organization_id = $2',
    [id, orgA],
  )).rows[0].count)
  const audit = Number((await pool.query(
    `SELECT count(*) FROM ochr_audit_log
      WHERE organization_id = $1 AND entity_type = 'mass_intention' AND entity_id = $2`,
    [orgA, String(id)],
  )).rows[0].count)
  return { row, corr, audit }
}

describe('F6 lock precedes stamped_history on assign and unassign', () => {
  it('fulfilled: assign to another Mass is 409 fulfilled_offering_locked and writes nothing', async () => {
    const massA = await mass(`F6 A ${RUN_ID}`, '2035-01-05', '08:00')
    const massB = await mass(`F6 B ${RUN_ID}`, '2035-01-12', '11:00')
    const id = await offerThenFulfill(`† F6 assign ${RUN_ID}`, massA)
    const before = await snap(id)
    const assigned = await request(server).post(`/api/mass-intentions/${id}/assign`)
      .set(auth(tokenA))
      .send({ calendar_event_id: massB.id, expected_calendar_event_id: massA.id })
    expect(assigned.status).toBe(409)
    expect(assigned.body.code).toBe(FULFILLED_OFFERING_LOCKED_CODE)
    expect(assigned.body.code).not.toBe(STAMPED_HISTORY_CODE)
    expect(await snap(id)).toEqual(before)
  })

  it('fulfilled: unassign is 409 fulfilled_offering_locked and writes nothing', async () => {
    const massA = await mass(`F6 C ${RUN_ID}`, '2035-02-02', '09:00')
    const id = await offerThenFulfill(`† F6 unassign ${RUN_ID}`, massA)
    const before = await snap(id)
    const released = await request(server).post(`/api/mass-intentions/${id}/unassign`)
      .set(auth(tokenA))
      .send({ expected_calendar_event_id: massA.id })
    expect(released.status).toBe(409)
    expect(released.body.code).toBe(FULFILLED_OFFERING_LOCKED_CODE)
    expect(await snap(id)).toEqual(before)
  })

  it('fulfilled without a stamp still gets the F6 code, not the older sentence', async () => {
    const massA = await mass(`F6 D ${RUN_ID}`, '2035-03-02', '09:00')
    const massB = await mass(`F6 E ${RUN_ID}`, '2035-03-09', '10:00')
    const id = await offerThenFulfill(`† F6 nostamp ${RUN_ID}`, massA)
    await pool.query(
      `UPDATE ochr_mass_intentions
          SET fulfilled_mass_date = NULL, fulfilled_mass_title = NULL, fulfilled_mass_time = NULL
        WHERE id = $1 AND organization_id = $2`,
      [id, orgA],
    )
    const before = await snap(id)
    expect(before.row.fulfilled_mass_date).toBeNull()
    expect(before.row.status).toBe('fulfilled')
    const assigned = await request(server).post(`/api/mass-intentions/${id}/assign`)
      .set(auth(tokenA)).send({ calendar_event_id: massB.id })
    expect(assigned.status).toBe(409)
    expect(assigned.body.code).toBe(FULFILLED_OFFERING_LOCKED_CODE)
    const released = await request(server).post(`/api/mass-intentions/${id}/unassign`)
      .set(auth(tokenA)).send({ expected_calendar_event_id: massA.id })
    expect(released.status).toBe(409)
    expect(released.body.code).toBe(FULFILLED_OFFERING_LOCKED_CODE)
    expect(await snap(id)).toEqual(before)
  })

  it('stamped and reopened: a different Mass or an unassign is F6; the same Mass is still a no-op', async () => {
    const massA = await mass(`F6 F ${RUN_ID}`, '2035-04-06', '08:30')
    const massB = await mass(`F6 G ${RUN_ID}`, '2035-04-13', '11:30')
    const id = await offerThenFulfill(`† F6 reopen ${RUN_ID}`, massA)
    const reopened = await request(server).post(`/api/mass-intentions/${id}/correct`)
      .set(auth(tokenA)).send({ reason: 'Recorded in error', changes: { status: 'open' } })
    expect(reopened.status).toBe(200)
    expect(reopened.body.status).not.toBe('fulfilled')
    const before = await snap(id)
    expect(before.row.status).toBe('scheduled')

    const assigned = await request(server).post(`/api/mass-intentions/${id}/assign`)
      .set(auth(tokenA))
      .send({ calendar_event_id: massB.id, expected_calendar_event_id: massA.id })
    expect(assigned.status).toBe(409)
    expect(assigned.body.code).toBe(FULFILLED_OFFERING_LOCKED_CODE)
    expect(await snap(id)).toEqual(before)

    const released = await request(server).post(`/api/mass-intentions/${id}/unassign`)
      .set(auth(tokenA)).send({ expected_calendar_event_id: massA.id })
    expect(released.status).toBe(409)
    expect(released.body.code).toBe(FULFILLED_OFFERING_LOCKED_CODE)
    expect(await snap(id)).toEqual(before)

    const same = await request(server).post(`/api/mass-intentions/${id}/assign`)
      .set(auth(tokenA)).send({ calendar_event_id: massA.id })
    expect(same.status).toBe(200)
    expect(same.body.calendar_event_id).toBe(massA.id)
    const after = await snap(id)
    expect(after.row.calendar_event_id).toBe(massA.id)
    expect(after.row.fulfilled_mass_date).toBe(before.row.fulfilled_mass_date)
    expect(after.row.fulfilled_mass_title).toBe(before.row.fulfilled_mass_title)
    expect(after.corr).toBe(before.corr)
  })

  it('another parish cannot assign or unassign this row', async () => {
    const massA = await mass(`F6 H ${RUN_ID}`, '2035-05-04', '09:00')
    const id = await offerThenFulfill(`† F6 tenant ${RUN_ID}`, massA)
    const before = await snap(id)
    const assigned = await request(server).post(`/api/mass-intentions/${id}/assign`)
      .set(auth(tokenB)).send({ calendar_event_id: massA.id })
    expect(assigned.status).toBe(404)
    const released = await request(server).post(`/api/mass-intentions/${id}/unassign`)
      .set(auth(tokenB)).send({})
    expect(released.status).toBe(404)
    expect(await snap(id)).toEqual(before)
  })

  it('N449-3: void of fulfilled+held stipend is refused; zero-liability void still works', async () => {
    const massA = await mass(`F6 I ${RUN_ID}`, '2035-06-01', '09:00')
    const id = await offerThenFulfill(`† F6 void ${RUN_ID}`, massA)
    const held = await request(server).post(`/api/mass-intentions/${id}/void`)
      .set(auth(tokenA)).send({ reason: 'Wrong amount; re-recorded', disposition: { kind: 'refunded', reason: 'Returned to requester' } })
    expect(held.status).toBe(409)
    expect(held.body.code).toBe('void_fulfilled_held')
    expect((await snap(id)).row.voided_at).toBeNull()

    const massB = await mass(`F6 J ${RUN_ID}`, '2035-06-08', '09:00')
    const freeId = await offerThenFulfill(`† F6 free void ${RUN_ID}`, massB, null)
    const free = await request(server).post(`/api/mass-intentions/${freeId}/void`)
      .set(auth(tokenA)).send({ reason: 'Duplicate entry' })
    expect(free.status).toBe(200)
    expect(free.body.status).toBe('cancelled')
    expect((await snap(freeId)).row.voided_at).not.toBeNull()
  })
})
