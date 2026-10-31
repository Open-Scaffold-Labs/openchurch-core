// SP-092 — the cash-count list takes an optional service-date range
// (?from, ?to; inclusive), stays inside the caller's parish, and refuses
// malformed dates instead of silently returning everything.
// Synthetic tenants only. Runs against the real Postgres in DATABASE_URL.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'
import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'

let server, tokenA, orgA, tokenB, orgB
const as = t => ({ Authorization: `Bearer ${t}` })

async function count(token, name, service_date) {
  const r = await request(server).post('/api/donations/cash-counts').set(as(token))
    .send({ service_name: name, service_date, counted_by: 'Margaret', total: 25 })
  expect(r.status).toBe(201)
  return r.body.id
}
const list = (token, qs = '') => request(server).get(`/api/donations/cash-counts${qs}`).set(as(token))

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  const a = await createOrg(server, {
    organizationName: `SP092 Parish ${RUN_ID}`, name: 'Synthetic Admin',
    email: `sp092_${RUN_ID}@example.com`, password: 'sp092-test-pw',
  }, '10.92.0.1')
  expect(a.status).toBe(201)
  tokenA = a.body.token; orgA = a.body.user.organization.id
  const b = await createOrg(server, {
    organizationName: `SP092 Other ${RUN_ID}`, name: 'Synthetic Other',
    email: `sp092b_${RUN_ID}@example.com`, password: 'sp092-test-pw',
  }, '10.92.0.2')
  expect(b.status).toBe(201)
  tokenB = b.body.token; orgB = b.body.user.organization.id
  await count(tokenA, 'Sep Mass', '2026-09-06')
  await count(tokenA, 'Oct Mass', '2026-10-04')
  await count(tokenA, 'Oct Late', '2026-10-18')
  await count(tokenB, 'Other Oct', '2026-10-11')
}, 60_000)

afterAll(async () => {
  for (const o of [orgA, orgB]) if (o) await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [o]).catch(() => {})
  await closeServer(server)
  await pool.end()
})

describe('SP-092 cash-count date filter', () => {
  it('no range returns all of this parish only', async () => {
    const r = await list(tokenA)
    expect(r.status).toBe(200)
    expect(r.body.map(s => s.service_name)).toEqual(['Oct Late', 'Oct Mass', 'Sep Mass'])
  })

  it('from and to are inclusive', async () => {
    const r = await list(tokenA, '?from=2026-10-04&to=2026-10-18')
    expect(r.status).toBe(200)
    expect(r.body.map(s => s.service_name)).toEqual(['Oct Late', 'Oct Mass'])
  })

  it('from alone and to alone work', async () => {
    expect((await list(tokenA, '?from=2026-10-05')).body.map(s => s.service_name)).toEqual(['Oct Late'])
    expect((await list(tokenA, '?to=2026-09-30')).body.map(s => s.service_name)).toEqual(['Sep Mass'])
  })

  it('never returns another parish\u2019s counts inside the range', async () => {
    const r = await list(tokenA, '?from=2026-10-01&to=2026-10-31')
    expect(r.body.map(s => s.service_name)).not.toContain('Other Oct')
    const b = await list(tokenB, '?from=2026-10-01&to=2026-10-31')
    expect(b.body.map(s => s.service_name)).toEqual(['Other Oct'])
  })

  it('refuses malformed, impossible, and reversed dates', async () => {
    for (const qs of ['?from=10/04/2026', '?to=2026-02-30', '?from=2026-10-1', '?from=x&to=y',
      '?from=2026-10-18&to=2026-10-04', '?from=2026-10-01&from=2026-10-02']) {
      const r = await list(tokenA, qs)
      expect(r.status, qs).toBe(400)
    }
  })
})
