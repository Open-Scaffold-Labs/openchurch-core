// SP-191. Adding an element was audited as "Created service_plan: <element>".
// The row must name the plan and the element. Another parish's plan is
// untouched, and a refused write leaves no audit row.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'

let server, tokenA, orgA, tokenB

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  const a = await createOrg(server, {
    organizationName: `Audit Plan ${RUN_ID}`,
    name: 'Ada Admin',
    email: `sp191_${RUN_ID}@example.com`,
    password: 'sp191-test-pw-0001',
  }, '10.254.2.1')
  expect(a.status).toBe(201)
  tokenA = a.body.token
  orgA = a.body.user.organization.id
  const b = await createOrg(server, {
    organizationName: `Audit Plan Other ${RUN_ID}`,
    name: 'Bea Admin',
    email: `sp191b_${RUN_ID}@example.com`,
    password: 'sp191-test-pw-0001',
  }, '10.254.2.2')
  expect(b.status).toBe(201)
  tokenB = b.body.token
}, 60_000)

afterAll(async () => {
  await closeServer(server)
  await pool.end()
})

const auth = token => ({ Authorization: `Bearer ${token}` })

async function auditFor(path, pred = () => true) {
  const start = Date.now()
  while (Date.now() - start < 2000) {
    const { rows } = await pool.query(
      `SELECT action, entity_type, entity_id, summary
         FROM ochr_audit_log
        WHERE organization_id = $1 AND request_path = $2
        ORDER BY id DESC LIMIT 1`,
      [orgA, path],
    )
    if (rows[0] && pred(rows[0])) return rows[0]
    await new Promise(r => setTimeout(r, 40))
  }
  return null
}

describe('SP-191 element audit names the plan and the element', () => {
  it('create, update, reorder, and delete name both, and a cross-tenant write does not', async () => {
    const planTitle = `Sunday Mass ${RUN_ID}`
    const elementTitle = `Entrance Hymn ${RUN_ID}`
    const plan = await request(server).post('/api/service-plans').set(auth(tokenA)).send({
      date: '2026-11-01', title: planTitle,
    })
    expect(plan.status).toBe(201)
    const planId = plan.body.id

    const created = await request(server).post(`/api/service-plans/${planId}/elements`).set(auth(tokenA)).send({
      kind: 'hymn', title: elementTitle,
    })
    expect(created.status).toBe(201)
    const createPath = `/api/service-plans/${planId}/elements`
    const createRow = await auditFor(createPath)
    expect(createRow).toBeTruthy()
    expect(createRow.entity_type).toBe('service_plan')
    expect(createRow.summary).toContain(planTitle)
    expect(createRow.summary).toContain(elementTitle)
    expect(createRow.summary).not.toBe(`Created service_plan: ${elementTitle}`)
    expect(createRow.entity_id).toBe(String(created.body.id))

    const nextTitle = `Processional Hymn ${RUN_ID}`
    const patched = await request(server).patch(`/api/service-plans/${planId}/elements/${created.body.id}`)
      .set(auth(tokenA)).send({ title: nextTitle })
    expect(patched.status).toBe(200)
    const patchRow = await auditFor(`/api/service-plans/${planId}/elements/${created.body.id}`)
    expect(patchRow.summary).toContain(planTitle)
    expect(patchRow.summary).toContain(nextTitle)
    expect(patchRow.summary).not.toBe(`Updated service_plan: ${nextTitle}`)

    const second = await request(server).post(`/api/service-plans/${planId}/elements`).set(auth(tokenA)).send({
      kind: 'reading', title: `First Reading ${RUN_ID}`,
    })
    expect(second.status).toBe(201)
    const reordered = await request(server).put(`/api/service-plans/${planId}/elements/reorder`)
      .set(auth(tokenA)).send({ ids: [second.body.id, created.body.id] })
    expect(reordered.status).toBe(204)
    const reorderRow = await auditFor(`/api/service-plans/${planId}/elements/reorder`)
    expect(reorderRow.summary).toContain(planTitle)
    expect(reorderRow.summary.toLowerCase()).toContain('reorder')

    const foreign = await request(server).post(`/api/service-plans/${planId}/elements`).set(auth(tokenB)).send({
      kind: 'hymn', title: `Foreign Hymn ${RUN_ID}`,
    })
    expect(foreign.status).toBe(404)
    const leaked = await pool.query(
      `SELECT count(*)::int AS n FROM ochr_audit_log
        WHERE organization_id = $1 AND summary LIKE $2`,
      [orgA, `%Foreign Hymn ${RUN_ID}%`],
    )
    expect(leaked.rows[0].n).toBe(0)

    const removed = await request(server).delete(`/api/service-plans/${planId}/elements/${created.body.id}`)
      .set(auth(tokenA))
    expect(removed.status).toBe(204)
    const deleteRow = await auditFor(
      `/api/service-plans/${planId}/elements/${created.body.id}`,
      row => row.action === 'delete',
    )
    expect(deleteRow.action).toBe('delete')
    expect(deleteRow.summary).toContain(planTitle)
    expect(deleteRow.summary).toContain(nextTitle)
    expect(deleteRow.summary).not.toMatch(/^Deleted service_plan #/)
  })
})
