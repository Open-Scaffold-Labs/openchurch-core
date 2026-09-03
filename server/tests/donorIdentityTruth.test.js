// Donor identity is the email, matched CASE-INSENSITIVELY (F5).
//
// Before: donations were grouped and matched on the raw donor_email, so
// 'Juan@Example.org' and 'juan@example.org' were two different donors. One
// person received two year-end tax statements (each understating their
// giving), a pledge was credited only the gifts whose casing matched, and a
// member's own gifts under a different casing dropped out of their history.
// The fix compares lower(donor_email) at every read site — the same rule
// ochr_clients already uses for members (migration 095).
//
// Reproduced 3 Sep against the real routes on local Postgres before the fix:
// three gifts from one person under three casings produced two statement
// rows ($100 and $200) instead of one ($300).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'

let server
const cleanupOrgIds = []

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

let ipSeq = 0
async function signup() {
  const res = await request(server).post('/api/auth/signup')
    .set('X-Forwarded-For', `10.71.3.${++ipSeq}`)
    .send({ organizationName: `DonorId ${RUN_ID}-${ipSeq}`, name: 'Admin',
            email: `di_${RUN_ID}_${ipSeq}@example.com`, password: 'donor-test-pw-1' })
  expect(res.status).toBe(201)
  cleanupOrgIds.push(res.body.user.organization.id)
  return res.body.token
}
const auth = t => ({ Authorization: `Bearer ${t}` })

describe('donor identity is case-insensitive (F5)', () => {
  let token
  // One person, three casings of the same address.
  const gift = (email, amount, date) => request(server).post('/api/donations')
    .set(auth(token)).send({ donor_name: 'Juan Delgado', donor_email: email, amount, date })

  beforeAll(async () => {
    token = await signup()
    expect((await gift('Juan@Example.org', 100, '2024-03-01')).status).toBe(201)
    expect((await gift('juan@example.org', 150, '2024-06-01')).status).toBe(201)
    expect((await gift('JUAN@EXAMPLE.ORG', 50,  '2024-09-01')).status).toBe(201)
  }, 30_000)

  it('the year-end preview shows ONE donor, not one statement per casing', async () => {
    const res = await request(server).get('/api/giving-statements/preview?year=2024').set(auth(token))
    expect(res.status).toBe(200)
    const juan = res.body.donors.filter(d => d.donor_name === 'Juan Delgado')
    expect(juan, 'the three casings must collapse to a single donor').toHaveLength(1)
    expect(Number(juan[0].total)).toBe(300)
    expect(juan[0].gift_count).toBe(3)
    expect(juan[0].donor_key).toBe('juan@example.org')  // canonical, lower-cased
  })

  it('the per-donor statement returns every gift regardless of key casing', async () => {
    for (const key of ['juan@example.org', 'Juan@Example.org', 'JUAN@EXAMPLE.ORG']) {
      const res = await request(server)
        .get(`/api/giving-statements/donor?year=2024&by=email&key=${encodeURIComponent(key)}`)
        .set(auth(token))
      expect(res.status, `key ${key}`).toBe(200)
      expect(Number(res.body.total), `key ${key}`).toBe(300)
      expect(res.body.gift_count, `key ${key}`).toBe(3)
    }
  })

  it("a member's history includes gifts recorded under a different casing", async () => {
    const created = await request(server).post('/api/clients').set(auth(token))
      .send({ name: 'Juan Delgado', email: 'JUAN@example.ORG' })
    expect(created.status).toBe(201)
    const res = await request(server).get(`/api/clients/${created.body.id}/donations`).set(auth(token))
    expect(res.status).toBe(200)
    expect(res.body.gift_count).toBe(3)
    expect(Number(res.body.total)).toBe(300)
  })
})
