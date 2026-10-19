// A gift's `date` is a calendar day and must leave this API as one.
//
// node-postgres parses a Postgres DATE into a JS Date at the SERVER's local
// midnight, and JSON serialises that as a full ISO timestamp. So a column
// whose entire meaning is '2031-04-04' shipped as '2031-04-04T00:00:00.000Z',
// and the donation log rendered "Invalid Date" on every row (13 of 13,
// measured against the real client on 4 Sep; live on production at the time).
// A reader west of the server would have been shown the previous day even
// once it parsed.
//
// The page is now tolerant of both shapes, which is what stops the blank
// screen — and is exactly why this test exists separately. With the client
// forgiving, a regression here would be invisible until someone west of UTC
// noticed their gifts were dated a day early.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'

let server
const cleanupOrgIds = []
const YMD = /^\d{4}-\d{2}-\d{2}$/
let ipSeq = 0

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

const auth = t => ({ Authorization: `Bearer ${t}` })

async function parish(tag) {
  const res = await createOrg(server, {
    organizationName: `DD ${tag} ${RUN_ID}`, name: 'Admin',
    email: `dd_${tag}_${RUN_ID}@example.com`, password: 'dd-verify-pw-1',
  }, `10.64.9.${ipSeq++ % 250 + 1}`)
  if (res.status !== 201) throw new Error(`signup ${res.status}: ${JSON.stringify(res.body)}`)
  cleanupOrgIds.push(res.body.user.organization.id)
  return res.body.token
}

describe('the shape of a gift date on the wire', () => {
  it('POST /api/donations answers with a calendar day, not a timestamp', async () => {
    const token = await parish('a')
    const res = await request(server).post('/api/donations').set(auth(token))
      .send({ donor_name: 'Date Donor', amount: 120.00, date: '2031-04-04', category: 'General', method: 'cash' })
    expect(res.status).toBe(201)
    expect(res.body.date).toMatch(YMD)
    expect(res.body.date).toBe('2031-04-04')
  })

  it('GET /api/donations lists calendar days', async () => {
    const token = await parish('b')
    await request(server).post('/api/donations').set(auth(token))
      .send({ donor_name: 'Date Donor', amount: 55.00, date: '2031-12-31', category: 'General', method: 'cash' })
    const res = await request(server).get('/api/donations').set(auth(token))
    expect(res.status).toBe(200)
    const rows = Array.isArray(res.body) ? res.body : res.body.donations
    const mine = rows.find(r => r.donor_name === 'Date Donor')
    expect(mine.date).toMatch(YMD)
    expect(mine.date).toBe('2031-12-31')
    // Nothing in the list may carry a time component.
    for (const r of rows) expect(String(r.date)).toMatch(YMD)
  })

  it('a cash count answers with a calendar service_date', async () => {
    const token = await parish('c')
    const res = await request(server).post('/api/donations/cash-counts').set(auth(token))
      .send({ service_name: 'Sunday', service_date: '2031-05-05', category: 'Offering',
              counted_by: 'A. Counter', denominations: { 20: 3 }, total: 60 })
    expect(res.status).toBe(201)
    expect(res.body.service_date).toMatch(YMD)
    expect(res.body.service_date).toBe('2031-05-05')
  })
})
