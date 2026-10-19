// Stage 6 — webhook receipts must not hold a pooled connection while the
// event is applied (independent review, 15 Oct). With a two-connection pool,
// three different events delivered together must all be applied promptly.
// Before the claim/lease design each apply held its receipt's connection
// while the apply needed another, and a third delivery starved the pool.
//
// Synthetic fixtures on the local database only.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

vi.hoisted(() => { process.env.PG_POOL_MAX = '2' })

const { default: request } = await import('supertest')
const crypto = await import('node:crypto')
await import('dotenv/config')
const { default: pool } = await import('../src/db.js')
const { RUN_ID, bindServer, closeServer, migrateOnce } = await import('./support/harness.js')
const { createOrg } = await import('./support/provision.js')

let server, org
const WH = `whsec_pool_${RUN_ID}`
const saved = process.env.BILLING_WEBHOOK_SECRET

beforeAll(async () => {
  await migrateOnce(); server = await bindServer()
  process.env.BILLING_WEBHOOK_SECRET = WH
  const res = await createOrg(server, { organizationName: `BillPool ${RUN_ID}`, name: 'Synthetic Admin', email: `billpool_${RUN_ID}@example.com`, password: 'billpool-test-pw' }, '10.99.1.1')
  expect(res.status).toBe(201)
  org = { id: res.body.user.organization.id, token: res.body.token }
  const fund = await request(server).post('/api/funds').set({ Authorization: `Bearer ${org.token}` }).send({ name: `General ${RUN_ID}` })
  org.fund = fund.body
}, 60000)
afterAll(async () => {
  if (saved === undefined) delete process.env.BILLING_WEBHOOK_SECRET; else process.env.BILLING_WEBHOOK_SECRET = saved
  await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [org.id]).catch(() => {})
  await closeServer(server); await pool.end()
})

describe('receipts under a small pool', () => {
  it('three different events delivered together are all stored and applied', async () => {
    expect(pool.options.max).toBe(2)
    const events = [0, 1, 2].map(i => {
      const object = { id: `cs_pool_${RUN_ID}_${i}`, mode: 'payment', status: 'complete', payment_status: 'paid',
        payment_intent: `pi_pool_${RUN_ID}_${i}`, amount_total: 1000, currency: 'usd',
        metadata: { kind: 'donation', organization_id: String(org.id), fund_id: String(org.fund.id), fund: org.fund.name, donor_name: 'Synthetic Donor' } }
      return JSON.stringify({ id: `evt_pool_${RUN_ID}_${i}`, type: 'checkout.session.completed', data: { object } })
    })
    const sign = body => { const t = Math.floor(Date.now() / 1000); return `t=${t},v1=${crypto.createHmac('sha256', WH).update(`${t}.${body}`).digest('hex')}` }
    const started = Date.now()
    const results = await Promise.all(events.map(body =>
      request(server).post('/api/billing/webhook').set('Content-Type', 'application/json').set('stripe-signature', sign(body)).send(body)))
    expect(results.map(r => r.status)).toEqual([200, 200, 200])
    expect(Date.now() - started).toBeLessThan(8000)
    const { rows } = await pool.query(`SELECT status FROM ochr_billing_event_receipts WHERE event_id LIKE $1`, [`evt_pool_${RUN_ID}_%`])
    expect(rows.map(r => r.status)).toEqual(['applied', 'applied', 'applied'])
  }, 30000)
})
