// D-b — a recorded fulfilment cannot be split from the Mass it names.
//
// Reopen, then point the row at a different Mass, used to leave the
// stamp on Mass A and the link on Mass B. Re-fulfilling after the same
// Mass moved kept the old day in the stamp and the new day on the row.
//
// WHAT WOULD MAKE THESE FAIL
//   - /assign or PATCH calendar_event_id accepts a new link while any
//     fulfilled_mass_* column is set (ARG-228-17, ARG-228-5).
//   - The transition back to fulfilled succeeds when the live Mass's
//     date, title, or time is not the stamp.
//   - A reopened stamped row is labeled with the plain word fulfilled.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
import {
  PREVIOUSLY_RECORDED_FULFILMENT,
  STAMP_CONFLICT_CODE,
  STAMPED_HISTORY_CODE,
} from '../src/routes/massIntentions.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'

let server
let tokenA, orgAId

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  const a = await createOrg(server, {
    organizationName: `Stamp Guard Parish ${RUN_ID}`,
    name: 'Ada Admin',
    email: `stamp_guard_${RUN_ID}@example.com`,
    password: 'stamp-guard-pw-1',
  })
  expect(a.status).toBe(201)
  tokenA = a.body.token
  orgAId = a.body.user.organization.id
}, 60_000)

afterAll(async () => {
  await closeServer(server)
  await pool.end()
})

const auth = token => ({ Authorization: `Bearer ${token}` })

function makeMass(body) {
  return request(server).post('/api/calendar').set(auth(tokenA)).send({
    title: body.title,
    date: body.date,
    start_time: body.start_time || '09:00',
    end_time: body.end_time || '10:00',
    type: 'service',
  })
}

async function offerThenFulfill(intention, mass) {
  const made = await request(server).post('/api/mass-intentions')
    .set(auth(tokenA))
    .send({ intention, calendar_event_id: mass.id })
  expect(made.status).toBe(201)
  const mark = await request(server).patch(`/api/mass-intentions/${made.body.id}`)
    .set(auth(tokenA))
    .send({ status: 'fulfilled' })
  expect(mark.status).toBe(200)
  expect(mark.body.status).toBe('fulfilled')
  return made.body.id
}

async function stampBytes(id) {
  const { rows } = await pool.query(
    `SELECT status,
            calendar_event_id,
            fulfilled_mass_date::text AS fulfilled_mass_date,
            fulfilled_mass_title,
            fulfilled_mass_time::text AS fulfilled_mass_time
       FROM ochr_mass_intentions
      WHERE id = $1 AND organization_id = $2`,
    [id, orgAId]
  )
  return rows[0]
}

function triple(row) {
  return {
    fulfilled_mass_date: row.fulfilled_mass_date,
    fulfilled_mass_title: row.fulfilled_mass_title,
    fulfilled_mass_time: row.fulfilled_mass_time,
  }
}

describe('recorded fulfilment cannot be re-linked or quietly re-fulfilled', () => {
  it('reopen then re-link to another Mass is 409 stamped_history and the stamp is byte-identical', async () => {
    const massA = await makeMass({ title: `Mass A ${RUN_ID}`, date: '2034-04-02', start_time: '08:00' })
    const massB = await makeMass({ title: `Mass B ${RUN_ID}`, date: '2034-04-09', start_time: '11:00' })
    expect(massA.status).toBe(201)
    expect(massB.status).toBe(201)
    const id = await offerThenFulfill(`† Re-link ${RUN_ID}`, massA.body)
    const before = await stampBytes(id)
    expect(before.fulfilled_mass_date).toBe('2034-04-02')
    expect(before.fulfilled_mass_title).toBe(`Mass A ${RUN_ID}`)

    const reopened = await request(server).patch(`/api/mass-intentions/${id}`)
      .set(auth(tokenA))
      .send({ status: 'open' })
    expect(reopened.status).toBe(200)
    expect(reopened.body.status).toBe('scheduled')

    const assigned = await request(server).post(`/api/mass-intentions/${id}/assign`)
      .set(auth(tokenA))
      .send({ calendar_event_id: massB.body.id, expected_calendar_event_id: massA.body.id })
    expect(assigned.status).toBe(409)
    expect(assigned.body.code).toBe(STAMPED_HISTORY_CODE)

    const patched = await request(server).patch(`/api/mass-intentions/${id}`)
      .set(auth(tokenA))
      .send({ calendar_event_id: massB.body.id })
    expect(patched.status).toBe(409)
    expect(patched.body.code).toBe(STAMPED_HISTORY_CODE)

    const after = await stampBytes(id)
    expect(triple(after)).toEqual(triple(before))
    expect(after.calendar_event_id).toBe(massA.body.id)
    expect(after.status).toBe('scheduled')

    const same = await request(server).post(`/api/mass-intentions/${id}/assign`)
      .set(auth(tokenA))
      .send({ calendar_event_id: massA.body.id })
    expect(same.status).toBe(200)
    expect(same.body.calendar_event_id).toBe(massA.body.id)
    expect(triple(await stampBytes(id))).toEqual(triple(before))
  })

  it('PATCH calendar_event_id on a fulfilled row is 409 stamped_history and the stamp is byte-identical', async () => {
    const massA = await makeMass({ title: `Held A ${RUN_ID}`, date: '2034-05-06', start_time: '09:15' })
    const massB = await makeMass({ title: `Held B ${RUN_ID}`, date: '2034-05-13', start_time: '09:15' })
    const id = await offerThenFulfill(`† Stay fulfilled ${RUN_ID}`, massA.body)
    const before = await stampBytes(id)

    const noted = await request(server).patch(`/api/mass-intentions/${id}`)
      .set(auth(tokenA))
      .send({ note: 'still this Mass', calendar_event_id: massA.body.id })
    expect(noted.status).toBe(200)
    expect(noted.body.calendar_event_id).toBe(massA.body.id)
    expect(triple(await stampBytes(id))).toEqual(triple(before))

    const moved = await request(server).patch(`/api/mass-intentions/${id}`)
      .set(auth(tokenA))
      .send({ calendar_event_id: massB.body.id })
    expect(moved.status).toBe(409)
    expect(moved.body.code).toBe(STAMPED_HISTORY_CODE)

    const after = await stampBytes(id)
    expect(triple(after)).toEqual(triple(before))
    expect(after.status).toBe('fulfilled')
    expect(after.calendar_event_id).toBe(massA.body.id)
    expect(after.fulfilled_mass_date).toBe(before.fulfilled_mass_date)
    expect(after.fulfilled_mass_title).toBe(before.fulfilled_mass_title)
    expect(after.fulfilled_mass_time).toBe(before.fulfilled_mass_time)
  })

  it('reopen, the Mass moves, re-fulfil is 409 stamp_conflict and the stamp is byte-identical', async () => {
    const mass = await makeMass({ title: `Moves ${RUN_ID}`, date: '2034-06-03', start_time: '10:00' })
    const id = await offerThenFulfill(`† Moved day ${RUN_ID}`, mass.body)
    const before = await stampBytes(id)
    expect(before.fulfilled_mass_date).toBe('2034-06-03')

    const moved = await request(server).patch(`/api/calendar/${mass.body.id}`)
      .set(auth(tokenA))
      .send({
        title: `Moves ${RUN_ID}`,
        date: '2034-06-10',
        start_time: '10:00',
        end_time: '11:00',
        type: 'service',
        assigned_to: [],
      })
    expect(moved.status).toBe(200)

    const reopened = await request(server).patch(`/api/mass-intentions/${id}`)
      .set(auth(tokenA))
      .send({ status: 'open' })
    expect(reopened.status).toBe(200)
    expect(reopened.body.status).toBe('scheduled')
    expect(reopened.body.mass_date).toBe('2034-06-10')
    expect(triple(await stampBytes(id))).toEqual(triple(before))

    const again = await request(server).patch(`/api/mass-intentions/${id}`)
      .set(auth(tokenA))
      .send({ status: 'fulfilled' })
    expect(again.status).toBe(409)
    expect(again.body.code).toBe(STAMP_CONFLICT_CODE)

    const after = await stampBytes(id)
    expect(triple(after)).toEqual(triple(before))
    expect(after.status).toBe('scheduled')
    expect(after.calendar_event_id).toBe(mass.body.id)
    expect(after.fulfilled_mass_date).toBe('2034-06-03')
    expect(after.fulfilled_mass_title).toBe(`Moves ${RUN_ID}`)
    expect(after.fulfilled_mass_time).toBe('10:00:00')
  })

  it('same-Mass same-day re-fulfil passes and does not rewrite the stamp', async () => {
    const mass = await makeMass({ title: `Same day ${RUN_ID}`, date: '2034-07-07', start_time: '08:30' })
    const id = await offerThenFulfill(`† Same day ${RUN_ID}`, mass.body)
    const before = await stampBytes(id)

    const demote = await request(server).patch(`/api/mass-intentions/${id}`)
      .set(auth(tokenA))
      .send({ status: 'open' })
    expect(demote.status).toBe(200)

    const again = await request(server).patch(`/api/mass-intentions/${id}`)
      .set(auth(tokenA))
      .send({ status: 'fulfilled' })
    expect(again.status).toBe(200)
    expect(again.body.status).toBe('fulfilled')
    expect(again.body.mass_date).toBe('2034-07-07')
    expect(again.body.mass_title).toBe(`Same day ${RUN_ID}`)
    expect(again.body.mass_time).toBe('08:30')
    expect(triple(await stampBytes(id))).toEqual(triple(before))
  })

  it('a reopened stamped row is labeled previously recorded fulfilment, never plain fulfilled', async () => {
    const mass = await makeMass({ title: `Labeled ${RUN_ID}`, date: '2034-08-04', start_time: '07:00' })
    const id = await offerThenFulfill(`† Labeled ${RUN_ID}`, mass.body)

    const whileFulfilled = await request(server).get(`/api/mass-intentions/${id}`).set(auth(tokenA))
    expect(whileFulfilled.status).toBe(200)
    expect(whileFulfilled.body.status).toBe('fulfilled')
    expect(whileFulfilled.body.fulfilment_label).toBeNull()

    const reopened = await request(server).patch(`/api/mass-intentions/${id}`)
      .set(auth(tokenA))
      .send({ status: 'open' })
    expect(reopened.status).toBe(200)
    expect(reopened.body.status).not.toBe('fulfilled')
    expect(reopened.body.fulfilment_label).toBe(PREVIOUSLY_RECORDED_FULFILMENT)
    expect(reopened.body.fulfilment_label).not.toBe('fulfilled')

    const book = await request(server).get('/api/mass-intentions').set(auth(tokenA))
    const listed = book.body.intentions.find(r => r.id === id)
    expect(listed.fulfilment_label).toBe(PREVIOUSLY_RECORDED_FULFILMENT)
    expect(listed.status).not.toBe('fulfilled')

    const weekly = await request(server)
      .get('/api/mass-intentions/weekly?start=2034-08-04&end=2034-08-10')
      .set(auth(tokenA))
    const weekRow = weekly.body.intentions.find(r => r.id === id)
    expect(weekRow).toBeTruthy()
    expect(weekRow.fulfilment_label).toBe(PREVIOUSLY_RECORDED_FULFILMENT)
    expect(weekRow.status).not.toBe('fulfilled')

    const packet = await request(server).get('/api/packet?date=2034-08-04').set(auth(tokenA))
    expect(packet.status).toBe(200)
    const pktRow = packet.body.intentions.find(r =>
      String(r.formatted_intention || '').includes(`Labeled ${RUN_ID}`)
    )
    expect(pktRow).toBeTruthy()
    expect(pktRow.fulfilment_label).toBe(PREVIOUSLY_RECORDED_FULFILMENT)
    expect(pktRow.status).not.toBe('fulfilled')
    expect(pktRow.fulfilment_label).not.toBe('fulfilled')

    const { rows } = await pool.query(
      `SELECT status, fulfilment_label
         FROM ochr_sacristy_weekly_manifest
        WHERE id = $1 AND organization_id = $2`,
      [id, orgAId]
    )
    expect(rows[0].status).not.toBe('fulfilled')
    expect(rows[0].fulfilment_label).toBe(PREVIOUSLY_RECORDED_FULFILMENT)
  })

  it('reopen then unassign is 409 stamped_history and the link stays on that Mass', async () => {
    const mass = await makeMass({ title: `Own Mass ${RUN_ID}`, date: '2034-09-09', start_time: '09:00' })
    const id = await offerThenFulfill(`† Unlink ${RUN_ID}`, mass.body)
    const before = await stampBytes(id)

    const reopened = await request(server).patch(`/api/mass-intentions/${id}`)
      .set(auth(tokenA))
      .send({ status: 'open' })
    expect(reopened.status).toBe(200)
    expect(reopened.body.status).toBe('scheduled')

    const released = await request(server).post(`/api/mass-intentions/${id}/unassign`)
      .set(auth(tokenA))
      .send({ expected_calendar_event_id: mass.body.id })
    expect(released.status).toBe(409)
    expect(released.body.code).toBe(STAMPED_HISTORY_CODE)

    const after = await stampBytes(id)
    expect(triple(after)).toEqual(triple(before))
    expect(after.calendar_event_id).toBe(mass.body.id)
    expect(after.status).toBe('scheduled')

    const again = await request(server).post(`/api/mass-intentions/${id}/assign`)
      .set(auth(tokenA))
      .send({ calendar_event_id: mass.body.id })
    expect(again.status).toBe(200)
    expect(again.body.calendar_event_id).toBe(mass.body.id)
    expect(triple(await stampBytes(id))).toEqual(triple(before))
  })

  it('an already unlinked stamped intention is not offered in awaiting', async () => {
    const mass = await makeMass({ title: `Deleted Mass ${RUN_ID}`, date: '2034-10-10', start_time: '10:00' })
    const id = await offerThenFulfill(`† Orphan ${RUN_ID}`, mass.body)
    const reopened = await request(server).patch(`/api/mass-intentions/${id}`)
      .set(auth(tokenA))
      .send({ status: 'open' })
    expect(reopened.status).toBe(200)

    // The Mass FK is ON DELETE SET NULL. This is that row, without deleting
    // the calendar event the rest of the book still needs.
    await pool.query(
      `UPDATE ochr_mass_intentions
          SET calendar_event_id = NULL
        WHERE id = $1 AND organization_id = $2`,
      [id, orgAId]
    )

    const waiting = await request(server).post('/api/mass-intentions')
      .set(auth(tokenA))
      .send({ intention: `† Waiting ${RUN_ID}`, mass_date: '2034-10-10' })
    expect(waiting.status).toBe(201)

    const list = await request(server).get('/api/mass-intentions/awaiting?date=2034-10-10')
      .set(auth(tokenA))
    expect(list.status).toBe(200)
    const ids = list.body.intentions.map(r => r.id)
    expect(ids).toContain(waiting.body.id)
    expect(ids).not.toContain(id)
  })
})
