// José, 2026-10-23:
//  (1) A parish running AI on its own key has NO monthly AI limit. The
//      20 (Free) / 500 (Parish) plan limits apply only to platform-paid AI.
//      Usage is still recorded.
//  (2) Cancelling a recurring gift and cancelling an invoice are admin-only.
//      Staff get 403 and the row is unchanged.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'
import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'
import { encryptApiKey } from '../src/ai/orgProvider.js'
import { quotaFor, reserveSlot } from '../src/billing/aiQuota.js'

let server
const cleanup = []
let ipSeq = 0
const ip = () => `10.126.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`
const auth = t => ({ Authorization: `Bearer ${t}` })

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
}, 60_000)

afterAll(async () => {
  for (const id of cleanup) {
    await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
  }
  await closeServer(server)
  await pool.end()
})

async function signup(tag) {
  const res = await createOrg(server, {
    organizationName: `OwnKey ${tag} ${RUN_ID}`,
    name: 'Ada Admin',
    email: `ok_${tag}_${RUN_ID}@example.com`,
    password: 'ok-pw-1234',
  }, ip())
  expect(res.status).toBe(201)
  cleanup.push(res.body.user.organization.id)
  return { token: res.body.token, orgId: res.body.user.organization.id, userId: res.body.user.id }
}

async function addStaff(org, tag) {
  const email = `ok_staff_${tag}_${RUN_ID}@example.com`
  const created = await request(server).post('/api/users').set(auth(org.token)).set('X-Forwarded-For', ip())
    .send({ name: 'Sam Staff', email, password: 'ok-pw-1234', role: 'staff' })
  expect(created.status).toBe(201)
  const logged = await request(server).post('/api/auth/login').set('X-Forwarded-For', ip())
    .send({ email, password: 'ok-pw-1234' })
  expect(logged.status).toBe(200)
  return { token: logged.body.token }
}

async function fillUsage(orgId, n) {
  await pool.query(
    `INSERT INTO ochr_ai_usage (organization_id, endpoint, type)
     SELECT $1, 'generate', 'message' FROM generate_series(1, $2)`,
    [orgId, n]
  )
}

const usageCount = async orgId =>
  (await pool.query('SELECT COUNT(*)::int AS n FROM ochr_ai_usage WHERE organization_id = $1', [orgId])).rows[0].n

describe('own-key AI has no monthly limit', () => {
  it('free plan, own key, past 20: quota reports no limit and a slot is still reserved and recorded', async () => {
    const org = await signup('own')
    await pool.query(
      `UPDATE ochr_organizations SET plan = 'free', ai_provider = 'anthropic', ai_api_key_enc = $2 WHERE id = $1`,
      [org.orgId, encryptApiKey('sk-test-not-real-0000')]
    )
    await fillUsage(org.orgId, 25)

    const q = await request(server).get('/api/ai/quota').set(auth(org.token))
    expect(q.status).toBe(200)
    expect(q.body.used).toBe(25)
    expect(q.body.limit).toBeNull()
    expect(q.body.remaining).toBeNull()
    expect(q.body.exceeded).toBe(false)
    expect(q.body.own_key).toBe(true)

    const r = await reserveSlot(org.orgId, { endpoint: 'generate', type: 'message' })
    expect(r.reserved).toBe(true)
    expect(await usageCount(org.orgId)).toBe(26) // usage still recorded
  })

  it('free plan, no own key: the 20 limit still applies to platform AI', async () => {
    const org = await signup('nokey')
    await pool.query(`UPDATE ochr_organizations SET plan = 'free', ai_provider = NULL, ai_api_key_enc = NULL WHERE id = $1`, [org.orgId])
    await fillUsage(org.orgId, 20)
    const q = await quotaFor(org.orgId)
    expect(q.limit).toBe(20)
    expect(q.exceeded).toBe(true)
    expect(q.own_key).toBe(false)
    const r = await reserveSlot(org.orgId, { endpoint: 'generate', type: 'message' })
    expect(r.reserved).toBe(false)
    expect(await usageCount(org.orgId)).toBe(20)
  })
})

describe('cancelling a recurring gift or an invoice is admin-only', () => {
  it('staff get 403 on recurring-gift cancel; the gift stays active; admin can cancel', async () => {
    const org = await signup('rec')
    const staff = await addStaff(org, 'rec')
    const { rows } = await pool.query(
      `INSERT INTO ochr_recurring_gifts (organization_id, donor_name, amount, frequency, next_charge_date)
       VALUES ($1, 'Dee Donor', 25, 'monthly', CURRENT_DATE + 7) RETURNING id`,
      [org.orgId]
    )
    const id = rows[0].id
    const s = await request(server).post(`/api/donations/recurring/${id}/cancel`).set(auth(staff.token))
    expect(s.status).toBe(403)
    expect((await pool.query('SELECT status FROM ochr_recurring_gifts WHERE id = $1', [id])).rows[0].status).toBe('active')

    const a = await request(server).post(`/api/donations/recurring/${id}/cancel`).set(auth(org.token))
    expect(a.status).toBe(200)
    expect(a.body.status).toBe('cancelled')
  })

  it('staff get 403 on invoice cancel; the invoice stays issued; admin can cancel', async () => {
    const org = await signup('inv')
    const staff = await addStaff(org, 'inv')
    const { rows } = await pool.query(
      `INSERT INTO ochr_invoices (organization_id, invoice_no, title, payer_name, status, subtotal, total, issued_at)
       VALUES ($1, 'T-1', 'Hall rental', 'Pat Payer', 'issued', 100, 100, NOW()) RETURNING id`,
      [org.orgId]
    )
    const id = rows[0].id
    const s = await request(server).post(`/api/invoices/${id}/cancel`).set(auth(staff.token))
    expect(s.status).toBe(403)
    expect((await pool.query('SELECT status FROM ochr_invoices WHERE id = $1', [id])).rows[0].status).toBe('issued')

    const a = await request(server).post(`/api/invoices/${id}/cancel`).set(auth(org.token))
    expect(a.status).toBe(200)
    expect((await pool.query('SELECT status FROM ochr_invoices WHERE id = $1', [id])).rows[0].status).toBe('cancelled')
  })
})
