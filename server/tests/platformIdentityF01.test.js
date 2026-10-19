// F-01 (ARGUS PART 0; TARS #62 6228025968): founder/vendor privilege is
// granted ONLY by SUPER_ADMIN_USER_IDS / VENDOR_ADMIN_USER_IDS. No email
// path, no binding table, no automatic grant. Synthetic data, local DB only.
// Red on main (email match grants founder/vendor) and red on the original
// PR1 patch (migration auto-binds the configured address; email+binding
// grants).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'
import { runAllMigrations } from '../src/migrations/index.js'

let server
const orgIds = []
let ip = 1
const saved = {}
const ENV = ['SUPER_ADMIN_EMAIL', 'VENDOR_ADMIN_EMAILS', 'SUPER_ADMIN_USER_IDS', 'VENDOR_ADMIN_USER_IDS']
const auth = (t) => ({ Authorization: `Bearer ${t}` })

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k] }
}, 60_000)

afterAll(async () => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  for (const id of orgIds) await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
  await closeServer(server)
  await pool.end()
})

async function signup(tag, email) {
  const res = await createOrg(server, {
    organizationName: `F01 ${tag} ${RUN_ID}`, name: 'Admin', email, password: 'f01-test-pw',
  }, `10.91.${ip++}.1`)
  expect(res.status).toBe(201)
  orgIds.push(res.body.user.organization.id)
  return { token: res.body.token, id: res.body.user.id, orgId: res.body.user.organization.id, email }
}

async function addAdmin(token, email) {
  const res = await request(server).post('/api/users').set(auth(token))
    .send({ name: 'Co Admin', email, password: 'f01-test-pw', role: 'admin' })
  expect(res.status).toBe(201)
  const login = await request(server).post('/api/auth/login').send({ email, password: 'f01-test-pw' })
  expect(login.status).toBe(200)
  return { token: login.body.token, id: res.body.id }
}

async function ticket(token, text) {
  const res = await request(server).post('/api/support-tickets').set(auth(token))
    .send({ description: `F01 probe ticket ${text} ${RUN_ID}`, page_route: '/x' })
  expect(res.status).toBe(201)
  return res.body.id
}

const founderGate = (t) => request(server).get('/api/admin/feedback').set(auth(t))
const tickets = async (t) => { const r = await request(server).get('/api/support-tickets').set(auth(t)); expect(r.status).toBe(200); return r.body }

describe('F-01 founder/vendor identity is granted by user id only', () => {
  it('nothing configured: nobody is founder or vendor', async () => {
    const a = await signup('none', `f01_none_${RUN_ID}@example.com`)
    expect((await founderGate(a.token)).status).toBe(404)
    expect((await tickets(a.token)).vendor).toBe(false)
  })

  it('a configured founder/vendor EMAIL grants nothing, even to its live holder, even after migrations run', async () => {
    const email = `f01_email_${RUN_ID}@example.com`
    const holder = await signup('email', email)
    const other = await signup('email_other', `f01_email_other_${RUN_ID}@example.com`)
    const otherTicket = await ticket(other.token, 'email-other')
    process.env.SUPER_ADMIN_EMAIL = email
    process.env.VENDOR_ADMIN_EMAILS = `x@example.com, ${email.toUpperCase()}`
    await runAllMigrations() // no migration may grant from the configured address
    for (let i = 0; i < 2; i++) {
      expect((await founderGate(holder.token)).status).toBe(404)
      const st = await tickets(holder.token)
      expect(st.vendor).toBe(false)
      expect(st.tickets.some(t => t.id === otherTicket)).toBe(false)
      expect((await request(server).get(`/api/support-tickets/${otherTicket}`).set(auth(holder.token))).status).toBe(404)
    }
    const { rows } = await pool.query("SELECT to_regclass('ochr_platform_identity_bindings') AS t")
    expect(rows[0].t).toBeNull()
    delete process.env.SUPER_ADMIN_EMAIL; delete process.env.VENDOR_ADMIN_EMAILS
  })

  it('SUPER_ADMIN_USER_IDS grants founder (and vendor) to exactly that id', async () => {
    const f = await signup('byid', `f01_byid_${RUN_ID}@example.com`)
    const other = await signup('byid_other', `f01_byid_other_${RUN_ID}@example.com`)
    const otherTicket = await ticket(other.token, 'byid-other')
    process.env.SUPER_ADMIN_USER_IDS = ` ${f.id} `
    expect((await founderGate(f.token)).status).toBe(200)
    const st = await tickets(f.token)
    expect(st.vendor).toBe(true); expect(st.tickets.some(t => t.id === otherTicket)).toBe(true)
    // A look-alike address cannot even register (normalized uniqueness on
    // main), so the listed id can never be shared with a second holder.
    const dup = await createOrg(server, { organizationName: `F01 imp ${RUN_ID}`, name: 'Imp',
      email: `  F01_BYID_${RUN_ID}@EXAMPLE.COM `, password: 'f01-test-pw' }, `10.91.${ip++}.1`)
    expect(dup.status).toBe(409)
    delete process.env.SUPER_ADMIN_USER_IDS
    expect((await founderGate(f.token)).status).toBe(404)
  })

  it('VENDOR_ADMIN_USER_IDS grants vendor scope, not founder', async () => {
    const host = await signup('vhost', `f01_vhost_${RUN_ID}@example.com`)
    const vendor = await addAdmin(host.token, `f01_vendor_${RUN_ID}@example.com`)
    const other = await signup('vother', `f01_vother_${RUN_ID}@example.com`)
    const otherTicket = await ticket(other.token, 'vendor-other')
    process.env.VENDOR_ADMIN_USER_IDS = `999999999,${vendor.id}`
    const ok = await tickets(vendor.token)
    expect(ok.vendor).toBe(true); expect(ok.tickets.some(t => t.id === otherTicket)).toBe(true)
    expect((await founderGate(vendor.token)).status).toBe(404)
    delete process.env.VENDOR_ADMIN_USER_IDS
  })

  it('a listed id whose login is closed or deactivated gets 401; the re-registered address gets nothing', async () => {
    const founderEmail = `f01_closed_${RUN_ID}@example.com`
    const founder = await signup('closed', founderEmail)
    const co = await addAdmin(founder.token, `f01_co_${RUN_ID}@example.com`)
    const deact = await signup('deact', `f01_deact_${RUN_ID}@example.com`)
    process.env.SUPER_ADMIN_USER_IDS = `${founder.id},${deact.id}`
    process.env.SUPER_ADMIN_EMAIL = founderEmail
    expect((await founderGate(founder.token)).status).toBe(200)
    expect((await request(server).post(`/api/users/${founder.id}/close`).set(auth(co.token))).status).toBe(200)
    expect((await founderGate(founder.token)).status).toBe(401)
    await pool.query('UPDATE ochr_users SET deactivated_at = NOW() WHERE id = $1', [deact.id])
    expect((await founderGate(deact.token)).status).toBe(401)
    const attacker = await signup('attacker', `  ${founderEmail.toUpperCase()} `)
    expect(attacker.id).not.toBe(founder.id)
    expect((await founderGate(attacker.token)).status).toBe(404)
    expect((await tickets(attacker.token)).vendor).toBe(false)
    delete process.env.SUPER_ADMIN_USER_IDS; delete process.env.SUPER_ADMIN_EMAIL
  })

  it('malformed id-list entries grant nothing', async () => {
    const a = await signup('malformed', `f01_malformed_${RUN_ID}@example.com`)
    for (const raw of [`${a.id}.0`, `0${a.id}`, `+${a.id}`, `${a.id}e0`, `-${a.id}`, 'abc', '99999999999', '']) {
      process.env.SUPER_ADMIN_USER_IDS = raw
      expect([raw, (await founderGate(a.token)).status]).toEqual([raw, 404])
    }
    delete process.env.SUPER_ADMIN_USER_IDS
  })
})
