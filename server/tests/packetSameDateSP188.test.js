// SP-188 — two service plans on one date. The packet used to LIMIT 1 by
// oldest id, so the second plan never printed, and the packet opened
// from plan 56's own button showed plan 55. The packet now carries every
// plan for the date, and ?plan_id= selects one plan (tenant-scoped).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'
import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'

let server, tokenA, tokenB, orgAId, orgBId
let p55, p56, pOther, pB
const DATE = '2031-11-02'

async function mkPlan(token, title, date = DATE) {
  const r = await request(server).post('/api/service-plans')
    .set('Authorization', `Bearer ${token}`).send({ date, title })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  return r.body.id
}
async function addEl(token, id, title) {
  const r = await request(server).post(`/api/service-plans/${id}/elements`)
    .set('Authorization', `Bearer ${token}`).send({ kind: 'hymn', title })
  expect(r.status).toBe(201)
}

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  const a = await createOrg(server, {
    organizationName: `SP188 Parish A ${RUN_ID}`, name: 'Ada Admin',
    email: `sp188_a_${RUN_ID}@example.com`, password: 'sp188-test-pw-1',
  })
  expect(a.status).toBe(201)
  tokenA = a.body.token; orgAId = a.body.user.organization.id
  const b = await createOrg(server, {
    organizationName: `SP188 Parish B ${RUN_ID}`, name: 'Bea Admin',
    email: `sp188_b_${RUN_ID}@example.com`, password: 'sp188-test-pw-2',
  })
  expect(b.status).toBe(201)
  tokenB = b.body.token; orgBId = b.body.user.organization.id

  p55 = await mkPlan(tokenA, 'Vigil Mass')
  p56 = await mkPlan(tokenA, 'Sunday 10:00 Mass')
  pOther = await mkPlan(tokenA, 'Other day', '2031-11-09')
  pB = await mkPlan(tokenB, 'Parish B plan')
  await addEl(tokenA, p55, 'Vigil opening hymn')
  await addEl(tokenA, p56, 'Ten o\u2019clock opening hymn')
  await addEl(tokenB, pB, 'B secret hymn')
}, 60_000)

afterAll(async () => {
  await closeServer(server)
  await pool.query('DELETE FROM ochr_organizations WHERE id = ANY($1::int[])', [[orgAId, orgBId]])
  await pool.end()
})

const get = (token, q) => request(server).get(`/api/packet?${q}`).set('Authorization', `Bearer ${token}`)

describe('SP-188 same-date plans in the Sunday Packet', () => {
  it('a date packet carries every plan for the date, oldest first', async () => {
    const r = await get(tokenA, `date=${DATE}`)
    expect(r.status).toBe(200)
    expect(Array.isArray(r.body.plans)).toBe(true)
    expect(r.body.plans.map(p => p.id)).toEqual([p55, p56])
    expect(r.body.plans[1].elements.map(e => e.title)).toEqual(['Ten o\u2019clock opening hymn'])
    expect(r.body.plan_id).toBe(null)
  })

  it('a packet opened from plan 56 shows plan 56, on its own date', async () => {
    const r = await get(tokenA, `plan_id=${p56}`)
    expect(r.status).toBe(200)
    expect(r.body.date).toBe(DATE)
    expect(r.body.plan.id).toBe(p56)
    expect(r.body.plan.title).toBe('Sunday 10:00 Mass')
    expect(r.body.plan_id).toBe(p56)
    expect(r.body.plans.map(p => p.id)).toEqual([p55, p56])
  })

  it('plan_id wins over a mismatched date param', async () => {
    const r = await get(tokenA, `date=2031-11-09&plan_id=${p56}`)
    expect(r.status).toBe(200)
    expect(r.body.date).toBe(DATE)
    expect(r.body.plan.id).toBe(p56)
  })

  it('another parish\u2019s plan id is 404, never its contents', async () => {
    const r = await get(tokenA, `plan_id=${pB}`)
    expect(r.status).toBe(404)
    expect(JSON.stringify(r.body)).not.toContain('B secret hymn')
  })

  it('a malformed plan_id is 400', async () => {
    const r = await get(tokenA, 'plan_id=abc')
    expect(r.status).toBe(400)
  })

  it('a single-plan date keeps plan and plans in step', async () => {
    const r = await get(tokenA, 'date=2031-11-09')
    expect(r.body.plan.id).toBe(pOther)
    expect(r.body.plans.map(p => p.id)).toEqual([pOther])
    const none = await get(tokenA, 'date=2031-11-16')
    expect(none.body.plan).toBe(null)
    expect(none.body.plans).toEqual([])
  })
})
