// P1 lane B — account deletion REQUEST plumbing. Synthetic local data only.
// Mutate any of these back and the matching test goes red:
//   1. the routes disappear (404)
//   2. opening or withdrawing a request deletes or closes anything
//   3. confirmation accepts a wrong or missing password
//   4. a response stops disclosing what deletion keeps
//   5. one person's request is visible to another login or parish
// Successful confirmation is the C3 deletion path (loginDeletion.test.js).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'

let server
const orgs = []
const auth = (t) => ({ Authorization: `Bearer ${t}` })
const PW = 'adr-test-pw-123'

async function signup(tag, ip) {
  const res = await request(server).post('/api/auth/signup').set('X-Forwarded-For', ip)
    .send({ organizationName: `ADR ${tag} ${RUN_ID}`, name: `Admin ${tag}`, email: `adr_${tag}_${RUN_ID}@example.com`, password: PW })
  expect(res.status).toBe(201)
  orgs.push(res.body.user.organization.id)
  return { token: res.body.token, userId: res.body.user.id, orgId: res.body.user.organization.id }
}

let a, staff, other
beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  a = await signup('a', '10.93.1.1')
  const u = await request(server).post('/api/users').set(auth(a.token))
    .send({ name: 'Staff ADR', email: `adr_staff_${RUN_ID}@example.com`, password: PW, role: 'staff' })
  expect(u.status).toBe(201)
  const login = await request(server).post('/api/auth/login').set('X-Forwarded-For', '10.93.1.2')
    .send({ email: `adr_staff_${RUN_ID}@example.com`, password: PW })
  expect(login.status).toBe(200)
  staff = { token: login.body.token, userId: u.body.id }
  other = await signup('b', '10.93.1.3')
}, 60_000)

afterAll(async () => {
  for (const id of orgs) await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
  await closeServer(server)
  await pool.end()
})

const FACTS = {
  data_deleted: false,
  personal_login_deleted: false,
  purge_performed: false,
  fulfilment_implemented: true,
  processing_owner: 'signed_in_user',
  disposition_policy: 'c3_self_serve_login_deletion',
  sacramental_registers_retained: true,
  financial_ledger_retained: true,
  financial_retention_years: 7,
  exception_contact: 'support@openscaffoldlabs.com',
}

async function userRow(id) {
  const { rows } = await pool.query(
    'SELECT email, name, closed_at, deactivated_at, password_hash FROM ochr_users WHERE id = $1', [id])
  return rows[0]
}

describe('account deletion request plumbing', () => {
  it('requires a signed-in login', async () => {
    expect((await request(server).get('/api/auth/deletion-request')).status).toBe(401)
    expect((await request(server).post('/api/auth/deletion-request')).status).toBe(401)
  })

  it('status starts empty and says nothing has been deleted', async () => {
    const r = await request(server).get('/api/auth/deletion-request').set(auth(staff.token))
    expect(r.status).toBe(200)
    expect(r.body.request).toBeNull()
    expect(r.body).toMatchObject(FACTS)
    expect(r.body.last_active_admin).toBe(false)
  })

  it('a request does not delete the login, and a wrong password does not either', async () => {
    const before = await userRow(staff.userId)

    const c = await request(server).post('/api/auth/deletion-request').set(auth(staff.token))
    expect(c.status).toBe(201)
    expect(c.body.request).toMatchObject({ status: 'requested', fulfilment_status: 'not_started', confirmed_at: null })
    expect(c.body).toMatchObject(FACTS)

    const again = await request(server).post('/api/auth/deletion-request').set(auth(staff.token))
    expect(again.status).toBe(200)
    expect(again.body.already).toBe(true)
    expect(again.body.request.id).toBe(c.body.request.id)

    expect((await request(server).post('/api/auth/deletion-request/confirm').set(auth(staff.token)).send({})).status).toBe(400)
    expect((await request(server).post('/api/auth/deletion-request/confirm').set(auth(staff.token)).send({ password: 'wrong-pw-000' })).status).toBe(403)

    expect(await userRow(staff.userId)).toEqual(before)
    expect((await request(server).get('/api/auth/me').set(auth(staff.token))).status).toBe(200)
    const s = await request(server).get('/api/auth/deletion-request').set(auth(staff.token))
    expect(s.body.request.status).toBe('requested')
    expect(s.body).toMatchObject(FACTS)
  })

  it('withdraw closes the request; a new one can be opened later', async () => {
    const w = await request(server).post('/api/auth/deletion-request/withdraw').set(auth(staff.token))
    expect(w.status).toBe(200)
    expect(w.body.request.status).toBe('withdrawn')
    expect(w.body).toMatchObject(FACTS)
    expect((await request(server).post('/api/auth/deletion-request/withdraw').set(auth(staff.token))).status).toBe(404)
    expect((await request(server).post('/api/auth/deletion-request/confirm').set(auth(staff.token)).send({ password: PW })).status).toBe(404)
    const n = await request(server).post('/api/auth/deletion-request').set(auth(staff.token))
    expect(n.status).toBe(201)
    expect(n.body.request.id).not.toBe(w.body.request.id)
  })

  it('flags the only active admin without closing or refusing the request', async () => {
    const c = await request(server).post('/api/auth/deletion-request').set(auth(other.token))
    expect(c.status).toBe(201)
    expect(c.body.last_active_admin).toBe(true)
    expect((await userRow(other.userId)).closed_at).toBeNull()
  })

  it('one login cannot see another login\'s or parish\'s request', async () => {
    const adminView = await request(server).get('/api/auth/deletion-request').set(auth(a.token))
    expect(adminView.body.request).toBeNull()
    const { rows } = await pool.query(
      'SELECT organization_id, user_id FROM ochr_account_deletion_requests WHERE user_id = ANY($1)',
      [[staff.userId, other.userId]])
    for (const r of rows) {
      if (r.user_id === staff.userId) expect(r.organization_id).toBe(a.orgId)
      if (r.user_id === other.userId) expect(r.organization_id).toBe(other.orgId)
    }
  })

  it('the schema allows completed fulfilment and rejects an unknown state', async () => {
    const c = await pool.connect()
    try {
      await c.query('BEGIN')
      const updated = await c.query(
        `UPDATE ochr_account_deletion_requests SET fulfilment_status = 'completed' WHERE user_id = $1`,
        [staff.userId])
      expect(updated.rowCount).toBeGreaterThan(0)
      await c.query('ROLLBACK')
    } finally {
      c.release()
    }
    await expect(pool.query(
      `UPDATE ochr_account_deletion_requests SET fulfilment_status = 'purged' WHERE user_id = $1`,
      [staff.userId])).rejects.toThrow(/ochr_adr_fulfilment_check/)
  })
})
