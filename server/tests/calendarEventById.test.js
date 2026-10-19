// GET /api/calendar/:id — the route that makes a deep link trustworthy.
//
// Check-in, and a member's attendance row, name a service by id. Those ids are
// authoritative (ochr_checkins.calendar_event_id is NOT NULL with a composite
// tenant FK) but the service can sit outside any window a picker loads — last
// Sunday's Mass, a Mass from March. This route resolves exactly one.
//
// Because it exists to be trusted, it is the one place that must not trust:
// a service belonging to another parish answers 404, identically to a service
// that does not exist. Anything less and a link becomes a way to read another
// church's schedule, or to take attendance against their Mass.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'

let server
const cleanupOrgIds = []
let ipSeq = 0
const auth = t => ({ Authorization: `Bearer ${t}` })

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
}, 60_000)

afterAll(async () => {
  for (const id of cleanupOrgIds) {
    await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
  }
  await closeServer(server)
  await pool.end()
})

async function parish(tag) {
  const res = await createOrg(server, {
    organizationName: `CEB ${tag} ${RUN_ID}`, name: 'Admin',
    email: `ceb_${tag}_${RUN_ID}@example.com`, password: 'ceb-verify-pw-1',
  }, `10.65.9.${++ipSeq}`)
  expect(res.status).toBe(201)
  cleanupOrgIds.push(res.body.user.organization.id)
  return res.body.token
}

const makeService = (token, title, date) => request(server).post('/api/calendar').set(auth(token))
  .send({ title, date, start_time: '10:30', end_time: '11:45', type: 'service' })

describe('one service, by id', () => {
  it('answers with the service the caller named', async () => {
    const token = await parish('a')
    const made = await makeService(token, 'Sunday Mass 10:30am', '2031-03-02')
    expect(made.status).toBe(201)
    const res = await request(server).get(`/api/calendar/${made.body.id}`).set(auth(token))
    expect(res.status).toBe(200)
    expect(res.body.id).toBe(made.body.id)
    expect(res.body.title).toBe('Sunday Mass 10:30am')
    // A calendar day, not a timestamp — the client reads it as a day.
    expect(res.body.date).toBe('2031-03-02')
  })

  it('answers for a service that has already happened', async () => {
    // The whole point: a picker starting today cannot name last Sunday.
    const token = await parish('b')
    const made = await makeService(token, 'Sunday Mass 8am', '2020-01-05')
    const res = await request(server).get(`/api/calendar/${made.body.id}`).set(auth(token))
    expect(res.status).toBe(200)
    expect(res.body.date).toBe('2020-01-05')
  })

  it('THE BOUNDARY: another parish\'s service is 404, not 200 and not 403', async () => {
    const mine = await parish('c')
    const theirs = await parish('d')
    const made = await makeService(theirs, 'FOREIGN Mass', '2031-04-04')
    expect(made.status).toBe(201)

    const res = await request(server).get(`/api/calendar/${made.body.id}`).set(auth(mine))
    expect(res.status).toBe(404)
    // Not a hint that it exists somewhere.
    expect(JSON.stringify(res.body)).not.toMatch(/FOREIGN/)

    // and the owner still sees it, so 404 above is the boundary, not a bug
    const owner = await request(server).get(`/api/calendar/${made.body.id}`).set(auth(theirs))
    expect(owner.status).toBe(200)
  })

  it('a service that does not exist is 404', async () => {
    const token = await parish('e')
    const res = await request(server).get('/api/calendar/99999999').set(auth(token))
    expect(res.status).toBe(404)
  })

  it('a non-numeric id is refused, not looked up', async () => {
    const token = await parish('f')
    const res = await request(server).get('/api/calendar/not-a-number').set(auth(token))
    expect(res.status).toBe(400)
  })

  it('does not shadow /api/calendar/conflicts', async () => {
    // ':id' is a greedy pattern; the conflicts routes are registered first and
    // must keep answering. A 400 "numeric id required" here would mean the new
    // route ate them.
    const token = await parish('g')
    const res = await request(server).get('/api/calendar/conflicts').set(auth(token))
    expect(res.status).toBe(200)
  })

  it('requires a session', async () => {
    const token = await parish('h')
    const made = await makeService(token, 'Sunday Mass', '2031-05-05')
    const res = await request(server).get(`/api/calendar/${made.body.id}`)
    expect(res.status).toBe(401)
  })
})
