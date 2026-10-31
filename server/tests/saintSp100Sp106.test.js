// Saint 2026-10-22 day-of probe.
// SP-106: POST/PATCH /api/calendar accepted an end time before the start.
// SP-100: nearest-outside measured distance from the window START, so an
//   empty Oct 24–30 pointed back to Oct 18 (6 days before) instead of
//   Nov 1 (2 days after the window).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'

let server
let token
const auth = () => ({ Authorization: `Bearer ${token}` })

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  const a = await createOrg(server, {
    organizationName: `SP106 Parish ${RUN_ID}`,
    name: 'Ada Admin',
    email: `sp106_${RUN_ID}@example.com`,
    password: 'sp106-test-pw-1',
  })
  expect(a.status).toBe(201)
  token = a.body.token
}, 60_000)

afterAll(async () => { await closeServer(server) })

const base = { title: `Choir ${RUN_ID}`, date: '2026-10-25', type: 'event', assigned_to: [] }

describe('SP-106 calendar end time must be after start', () => {
  it('POST rejects end before start and end equal to start, accepts a real range', async () => {
    const before = await request(server).post('/api/calendar').set(auth())
      .send({ ...base, start_time: '10:00', end_time: '09:45' })
    expect(before.status).toBe(400)
    expect(before.body.error).toBe('End time must be after the start time')

    const equal = await request(server).post('/api/calendar').set(auth())
      .send({ ...base, start_time: '10:00', end_time: '10:00' })
    expect(equal.status).toBe(400)

    const good = await request(server).post('/api/calendar').set(auth())
      .send({ ...base, start_time: '10:00', end_time: '11:00' })
    expect(good.status).toBe(201)
  })

  it('PATCH rejects end before start and leaves the row unchanged', async () => {
    const created = await request(server).post('/api/calendar').set(auth())
      .send({ ...base, start_time: '08:00', end_time: '09:00' })
    expect(created.status).toBe(201)
    const id = created.body.id ?? created.body.event?.id ?? created.body[0]?.id
    expect(id).toBeTruthy()

    const bad = await request(server).patch(`/api/calendar/${id}`).set(auth())
      .send({ ...base, start_time: '09:00', end_time: '08:30' })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe('End time must be after the start time')

    const read = await request(server).get(`/api/calendar/${id}`).set(auth())
    expect(String(read.body.end_time ?? read.body.event?.end_time).slice(0, 5)).toBe('09:00')
  })
})

describe('SP-100 nearest-outside measures from the nearer window edge', () => {
  it('Oct 24–30 points to Nov 1, not Oct 18', async () => {
    for (const mass_date of ['2026-10-18', '2026-11-01']) {
      const r = await request(server).post('/api/mass-intentions').set(auth())
        .send({ intention: `edge ${mass_date} ${RUN_ID}`, mass_date, status: 'open' })
      expect(r.status).toBe(201)
    }
    const res = await request(server)
      .get('/api/mass-intentions/nearest-outside?start=2026-10-24&end=2026-10-30').set(auth())
    expect(res.status).toBe(200)
    expect(res.body.date).toBe('2026-11-01')
  })
})
