// Stage 6 — profile minimization and organization HOLD are recorded as what
// they are, by the route that did the work. Generic POST logging would have
// said "Created client" / "Created organization". The request body can
// never choose the classification.
//
// Synthetic fixtures on the local database only.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'
import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'

let server
const orgIds = []
let sequence = 1
const auth = token => ({ Authorization: `Bearer ${token}` })
const CONFIRM = { confirm: 'DEIDENTIFY', acknowledge_history_retained: true }

beforeAll(async () => { await migrateOnce(); server = await bindServer() }, 60000)
afterAll(async () => {
  for (const id of orgIds) await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
  await closeServer(server); await pool.end()
})

async function parish(tag) {
  const name = `Steward ${tag} ${RUN_ID}`
  const res = await createOrg(server, { organizationName: name, name: 'Synthetic Admin', email: `steward_${tag}_${RUN_ID}@example.com`, password: 'steward-test-pw' }, `10.96.${sequence++}.1`)
  expect(res.status).toBe(201)
  const org = { id: res.body.user.organization.id, name, userId: res.body.user.id, token: res.body.token }
  orgIds.push(org.id)
  return org
}
async function member(org, tag) {
  const r = await request(server).post('/api/clients').set(auth(org.token)).send({ name: `Synthetic ${tag}`, email: `steward_member_${tag}_${org.id}@example.com` })
  expect(r.status).toBe(201)
  return r.body.id
}
async function rowsFor(orgId, method, path, n = 1) {
  let rows = []
  for (let i = 0; i < 40; i++) {
    ;({ rows } = await pool.query(
      `SELECT user_id, user_name, action, entity_type, entity_id, summary, metadata FROM ochr_audit_log
        WHERE organization_id = $1 AND request_method = $2 AND request_path = $3 ORDER BY id`,
      [orgId, method, path]))
    if (rows.length >= n) return rows
    await new Promise(r => setTimeout(r, 50))
  }
  return rows
}

describe('profile minimization is recorded as minimization', () => {
  it('canonical id through a zero-padded mixed-case route; a repeat says already; body cannot classify', async () => {
    const org = await parish('deid')
    const id = await member(org, 'deid')
    const path = `/API/Clients/00${id}/Deidentify`
    const res = await request(server).post(path).set(auth(org.token)).send({ ...CONFIRM, action: 'hold', op: 'close', via: 'self', summary: 'Forged' })
    expect(res.status).toBe(200)
    const [row] = await rowsFor(org.id, 'POST', path)
    expect(row).toMatchObject({
      action: 'deidentify', entity_type: 'client', entity_id: String(id),
      summary: `Minimized member contact details #${id}`, metadata: {}, user_id: org.userId,
    })
    const again = await request(server).post(`/api/clients/${id}/deidentify`).set(auth(org.token)).send(CONFIRM)
    expect(again.body.already).toBe(true)
    const [repeat] = await rowsFor(org.id, 'POST', `/api/clients/${id}/deidentify`)
    expect(repeat).toMatchObject({ action: 'deidentify', summary: `Minimized member contact details #${id} (already minimized)`, metadata: { already: true } })
    // The member's record history finds both by the canonical id.
    const read = await request(server).get(`/api/audit-log?entity_type=client&entity_id=${id}&action=deidentify`).set(auth(org.token))
    expect(read.status).toBe(200)
    expect(read.body.rows).toHaveLength(2)
  })

  it('a refused minimization (missing confirmation) and a cross-tenant attempt write no stewardship row', async () => {
    const org = await parish('deid_refused'), other = await parish('deid_other')
    const id = await member(org, 'refused')
    expect((await request(server).post(`/api/clients/${id}/deidentify`).set(auth(org.token)).send({})).status).toBe(400)
    expect((await request(server).post(`/api/clients/${id}/deidentify`).set(auth(other.token)).send(CONFIRM)).status).toBe(404)
    await new Promise(r => setTimeout(r, 300))
    const { rows } = await pool.query(
      `SELECT action FROM ochr_audit_log WHERE organization_id = ANY($1::int[]) AND action IN ('deidentify', 'hold')`, [[org.id, other.id]])
    expect(rows).toEqual([])
  })

  it('an ordinary member create is still a create; a body cannot make it a minimization', async () => {
    const org = await parish('ordinary')
    const r = await request(server).post('/api/clients').set(auth(org.token)).send({ name: 'Synthetic Ordinary', action: 'deidentify', op: 'deidentify' })
    expect(r.status).toBe(201)
    const [row] = await rowsFor(org.id, 'POST', '/api/clients')
    expect(row.action).toBe('create')
    expect(row.summary).toBe('Created client: Synthetic Ordinary')
  })
})

describe('organization HOLD is recorded as a hold', () => {
  it('records the hold with the organization id and its actor; not "Created organization"', async () => {
    const org = await parish('hold')
    const res = await request(server).post('/api/Organization/HOLD').set(auth(org.token)).send({ confirm: org.name, acknowledge_export_warning: true, action: 'create' })
    expect(res.status).toBe(200)
    const [row] = await rowsFor(org.id, 'POST', '/api/Organization/HOLD')
    expect(row).toMatchObject({
      action: 'hold', entity_type: 'organization', entity_id: String(org.id),
      summary: `Placed organization on hold #${org.id}`, metadata: {}, user_id: org.userId, user_name: 'Synthetic Admin',
    })
    expect(JSON.stringify(row.metadata)).not.toContain(org.name)
  })

  it('a refused hold (wrong confirmation) writes no row', async () => {
    const org = await parish('hold_refused')
    expect((await request(server).post('/api/organization/hold').set(auth(org.token)).send({ confirm: 'wrong', acknowledge_export_warning: true })).status).toBe(400)
    await new Promise(r => setTimeout(r, 300))
    expect((await pool.query(`SELECT COUNT(*)::int AS n FROM ochr_audit_log WHERE organization_id = $1 AND request_path = '/api/organization/hold'`, [org.id])).rows[0].n).toBe(0)
  })

  it('the action filter accepts the stewardship actions and rejects invented ones', async () => {
    const org = await parish('filter')
    const id = await member(org, 'filter')
    await request(server).post(`/api/clients/${id}/deidentify`).set(auth(org.token)).send(CONFIRM)
    await rowsFor(org.id, 'POST', `/api/clients/${id}/deidentify`)
    const ok = await request(server).get('/api/audit-log?action=deidentify').set(auth(org.token))
    expect(ok.status).toBe(200)
    expect(ok.body.rows.length).toBe(1)
    expect((await request(server).get('/api/audit-log?action=held').set(auth(org.token))).status).toBe(400)
  })
})
