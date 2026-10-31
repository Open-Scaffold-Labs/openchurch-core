// #285 F3/F5: mass_intention audit rows.
// F3: an idempotent no-op assign/unassign changes nothing and writes no audit row.
// F5: every mass_intention write puts its audit row on the SAME transaction,
//     so the change and its audit row commit or roll back together. Proven by
//     making the audit INSERT fail (test-only trigger scoped to one test org):
//     the change must not be saved. On main the write succeeded and the audit
//     row was silently lost (post-response, error swallowed).
// Real PG, synthetic data.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'
import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'

let server, A, F, massId
const PW = 'f3f5-test-pw-0001'
let ip = 10
const nextIp = () => `10.253.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}`
const auth = t => ({ Authorization: `Bearer ${t}` })
const TRIG = `f3f5_fail_audit_${String(RUN_ID).replace(/\W/g, '_')}`.slice(0, 60)

async function org(label) {
  const r = await createOrg(server, { organizationName: `F3F5 ${label} ${RUN_ID}`, name: `Admin ${label}`, email: `f3f5_${label}_${RUN_ID}@example.com`, password: PW }, nextIp())
  expect(r.status).toBe(201)
  return { token: r.body.token, id: r.body.user.organization.id }
}
async function mass(o, date) {
  const r = await request(server).post('/api/calendar').set(auth(o.token))
    .send({ title: `MASS F3F5 ${RUN_ID}`, date, start_time: '08:00', end_time: '09:00', type: 'service' })
  expect(r.status).toBe(201)
  return r.body.id
}
const auditRows = async (orgId, id) => (await pool.query(
  "SELECT action, summary, metadata FROM ochr_audit_log WHERE organization_id=$1 AND entity_type='mass_intention' AND entity_id=$2 ORDER BY id",
  [orgId, String(id)])).rows
const make = (o, intention) => request(server).post('/api/mass-intentions').set(auth(o.token)).send({ intention })

beforeAll(async () => {
  await migrateOnce(); server = await bindServer()
  A = await org('a'); F = await org('fail')
  massId = await mass(A, '2028-03-05')
}, 60_000)
afterAll(async () => {
  await pool.query(`DROP TRIGGER IF EXISTS ${TRIG} ON ochr_audit_log`)
  await pool.query(`DROP FUNCTION IF EXISTS ${TRIG}()`)
  await closeServer(server); await pool.end()
})

describe('F3: no-op assign/unassign write no audit row', () => {
  it('assign twice to the same Mass: one row; unassign twice: one row', async () => {
    const made = await make(A, `† F3 ${RUN_ID}`); expect(made.status).toBe(201)
    const id = made.body.id
    const base = (await auditRows(A.id, id)).length // the create row
    expect(base).toBe(1)

    const a1 = await request(server).post(`/api/mass-intentions/${id}/assign`).set(auth(A.token)).send({ calendar_event_id: massId })
    expect(a1.status).toBe(200)
    const a2 = await request(server).post(`/api/mass-intentions/${id}/assign`).set(auth(A.token)).send({ calendar_event_id: massId })
    expect(a2.status).toBe(200); expect(a2.body.calendar_event_id).toBe(massId)
    // Rows are on the transaction now: present when the response arrives, no polling.
    let rows = await auditRows(A.id, id)
    expect(rows.map(r => r.metadata.op)).toEqual([undefined, 'assign'])

    const u1 = await request(server).post(`/api/mass-intentions/${id}/unassign`).set(auth(A.token)).send({})
    expect(u1.status).toBe(200)
    const u2 = await request(server).post(`/api/mass-intentions/${id}/unassign`).set(auth(A.token)).send({})
    expect(u2.status).toBe(200); expect(u2.body.calendar_event_id).toBeNull()
    rows = await auditRows(A.id, id)
    expect(rows.map(r => r.metadata.op)).toEqual([undefined, 'assign', 'unassign'])
    // Real rows keep the closed id-only projection.
    expect(rows[1].metadata).toMatchObject({ intention_id: Number(id), calendar_event_id: massId, op: 'assign', status: 'scheduled' })
    expect(JSON.stringify(rows)).not.toContain('F3 ')
  })
})

describe('F5: the change and its audit row commit together', () => {
  let fMass, assignId, patchId, deleteId
  beforeAll(async () => {
    fMass = await mass(F, '2028-03-06')
    assignId = (await make(F, `† F5 assign ${RUN_ID}`)).body.id
    patchId = (await make(F, `† F5 patch ${RUN_ID}`)).body.id
    deleteId = (await make(F, `† F5 delete ${RUN_ID}`)).body.id
    // Test-only: any mass_intention audit INSERT for org F now fails.
    await pool.query(`CREATE FUNCTION ${TRIG}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'f3f5 synthetic audit failure'; END $$`)
    await pool.query(`CREATE TRIGGER ${TRIG} BEFORE INSERT ON ochr_audit_log FOR EACH ROW
      WHEN (NEW.organization_id = ${Number(F.id)} AND NEW.entity_type = 'mass_intention') EXECUTE FUNCTION ${TRIG}()`)
  })
  const row = async id => (await pool.query('SELECT id, intention, calendar_event_id FROM ochr_mass_intentions WHERE id=$1', [id])).rows[0]

  it('create: no intention is saved when its audit row cannot be', async () => {
    const intention = `† F5 create ${RUN_ID}`
    const r = await make(F, intention)
    expect(r.status).toBe(500)
    const { rows } = await pool.query('SELECT 1 FROM ochr_mass_intentions WHERE organization_id=$1 AND intention=$2', [F.id, intention])
    expect(rows.length).toBe(0)
  })
  it('assign: stays unassigned', async () => {
    const r = await request(server).post(`/api/mass-intentions/${assignId}/assign`).set(auth(F.token)).send({ calendar_event_id: fMass })
    expect(r.status).toBe(500)
    expect((await row(assignId)).calendar_event_id).toBeNull()
  })
  it('PATCH: text unchanged', async () => {
    const r = await request(server).patch(`/api/mass-intentions/${patchId}`).set(auth(F.token)).send({ intention: `† F5 patched ${RUN_ID}` })
    expect(r.status).toBe(500)
    expect((await row(patchId)).intention).toBe(`† F5 patch ${RUN_ID}`)
  })
  it('DELETE: row still exists', async () => {
    const r = await request(server).delete(`/api/mass-intentions/${deleteId}`).set(auth(F.token))
    expect(r.status).toBe(500)
    expect(await row(deleteId)).toBeTruthy()
  })
})
