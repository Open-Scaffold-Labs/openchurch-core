// Public give: the Stripe Connect destination account.
//
// Defects closed (both introduced with Parish Pricing Floor v2.1):
//   HIGH   POST /api/public/:slug/give took `stripe_connect_account_id` from
//          the request body when the parish had none saved, and echoed the
//          account id back as `stripe_account`. Any caller could route a
//          parish's gifts to an account of their choosing.
//   MEDIUM resolveStripeConnectAccountId fell back to a deployment-wide
//          STRIPE_CONNECT_ACCOUNT_ID, pooling every unconfigured parish's
//          gifts into one account.
// The destination is now only the parish's own saved account; without one
// the route answers 409 and no Checkout session is created.

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
import { bindServer, closeServer, migrateOnce, RUN_ID } from './support/harness.js'
import { createOrg } from './support/provision.js'
import { resolveStripeConnectAccountId } from '../src/payments/index.js'

let server
const cleanupOrgIds = []
let ipSeq = 0
const ip = () => `10.77.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`

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

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.PAYMENTS_PROVIDER
  delete process.env.PAYMENTS_PROVIDER_SECRET
  delete process.env.STRIPE_CONNECT_ACCOUNT_ID
  delete process.env.OC_BETA_BILLING
  delete process.env.OC_ALLOW_PLATFORM_DONATION_FALLBACK
})

async function parish(label) {
  const res = await createOrg(server, { organizationName: `Give Guard ${label} ${RUN_ID}`, name: 'Bookkeeper',
    email: `give_guard_${label.toLowerCase()}_${RUN_ID}@example.com`, password: `gg-pw-${label}-1` }, ip())
  expect(res.status).toBe(201)
  const org = res.body.user.organization
  cleanupOrgIds.push(org.id)
  const f = await request(server).post('/api/funds')
    .set('Authorization', `Bearer ${res.body.token}`).send({ name: `General ${label}` })
  expect(f.status).toBe(201)
  return { slug: org.slug, fundId: f.body.id }
}

// Stripe live mode with a fake key; every outbound Stripe call is captured
// so a test can see which account (if any) a session would be created on.
function liveStripe() {
  process.env.PAYMENTS_PROVIDER = 'stripe'
  process.env.PAYMENTS_PROVIDER_SECRET = 'sk_test_give_guard_fake'
  const calls = []
  vi.stubGlobal('fetch', async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers || {} })
    return new Response(JSON.stringify({ id: 'cs_test_x', url: 'https://checkout.stripe.test/x' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  return calls
}

const give = (slug, body) =>
  request(server).post(`/api/public/${slug}/give`).set('X-Forwarded-For', ip()).send(body)

describe('public give — Connect destination account', () => {
  let A, B
  beforeAll(async () => { A = await parish('A'); B = await parish('B') })
  // Account-routing tests need the payments hold off so a missing Connect
  // account (not the hold) is what produces the 409.
  beforeEach(() => { process.env.OC_BETA_BILLING = 'off' })

  it('ignores a body-supplied account: no Checkout on it, honest 409, no id echoed', async () => {
    const calls = liveStripe()
    const res = await give(A.slug, {
      fund_id: A.fundId, amount: 20, donor_name: 'Guard Donor',
      stripe_connect_account_id: 'acct_ATTACKER123',
    })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/not set up/i)
    expect(JSON.stringify(res.body)).not.toMatch(/acct_/)
    expect(calls.filter(c => c.headers['Stripe-Account'] === 'acct_ATTACKER123')).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })

  it('does not fall back to a global STRIPE_CONNECT_ACCOUNT_ID (no cross-parish pooling)', async () => {
    process.env.STRIPE_CONNECT_ACCOUNT_ID = 'acct_GLOBALPOOL1'
    expect(resolveStripeConnectAccountId(null)).toBeNull()
    expect(resolveStripeConnectAccountId({})).toBeNull()
    const calls = liveStripe()
    for (const p of [A, B]) {
      const res = await give(p.slug, { fund_id: p.fundId, amount: 10, donor_name: 'Pool Donor' })
      expect(res.status).toBe(409)
      expect(JSON.stringify(res.body)).not.toMatch(/acct_/)
    }
    expect(calls).toHaveLength(0)
  })

  it('an explicit account passed by a server caller still resolves', () => {
    expect(resolveStripeConnectAccountId('acct_PARISHOWN1')).toBe('acct_PARISHOWN1')
    expect(resolveStripeConnectAccountId({ stripe_connect_account_id: 'acct_PARISHOWN1' })).toBe('acct_PARISHOWN1')
  })

  it('tenant isolation: parish B cannot give to parish A\'s fund, with or without a body account', async () => {
    const calls = liveStripe()
    const res = await give(B.slug, {
      fund_id: A.fundId, amount: 10, donor_name: 'Cross Donor',
      stripe_connect_account_id: 'acct_ATTACKER123',
    })
    expect(res.status).toBe(400)
    expect(JSON.stringify(res.body)).not.toMatch(/acct_/)
    expect(calls).toHaveLength(0)
  })

  it('stub mode still records the gift and ignores/never echoes a body account', async () => {
    process.env.PAYMENTS_PROVIDER = 'stub'
    const res = await give(A.slug, {
      fund_id: A.fundId, amount: 12.5, donor_name: 'Stub Donor',
      stripe_connect_account_id: 'acct_ATTACKER123',
    })
    expect(res.status).toBe(201)
    expect(res.body.ok).toBe(true)
    expect(JSON.stringify(res.body)).not.toMatch(/acct_/)
  })
})

describe('public give — payments hold (OC_BETA_BILLING)', () => {
  let A
  beforeAll(async () => { A = await parish('Hold') })

  it('default hold blocks Checkout before Stripe is touched, even with a forged body account', async () => {
    delete process.env.OC_BETA_BILLING // hold ON (default)
    const calls = liveStripe()
    const res = await give(A.slug, {
      fund_id: A.fundId, amount: 20, donor_name: 'Hold Donor',
      stripe_connect_account_id: 'acct_ATTACKER123',
    })
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'beta_billing_disabled' })
    expect(JSON.stringify(res.body)).not.toMatch(/acct_/)
    expect(calls).toHaveLength(0)
  })

  it('hold off still refuses when the parish has no saved Connect account', async () => {
    process.env.OC_BETA_BILLING = 'off'
    const calls = liveStripe()
    const res = await give(A.slug, {
      fund_id: A.fundId, amount: 20, donor_name: 'NoAcct Donor',
      stripe_connect_account_id: 'acct_ATTACKER123',
    })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/not set up/i)
    expect(calls).toHaveLength(0)
  })
})

describe('public give — N443-1 saved Connect account (findOrgBySlug SELECT)', () => {
  // Regression for N443-1: findOrgBySlug omitted stripe_connect_account_id
  // from its SELECT, so savedConnectAccountId(org) was always null even
  // when the column was populated. Without the SELECT fix this suite goes
  // red (409 "not set up"); with it, Checkout receives Stripe-Account.
  // Payments stay held by default — the positive path only runs with the
  // hold explicitly off for this test.
  let A
  beforeAll(async () => { A = await parish('N4431') })

  async function saveConnectAccount(slug, acct) {
    const { rows } = await pool.query(
      `UPDATE ochr_organizations SET stripe_connect_account_id = $2 WHERE slug = $1 RETURNING id, stripe_connect_account_id`,
      [slug, acct],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].stripe_connect_account_id).toBe(acct)
  }

  it('hold off + saved acct_… → Checkout created with Stripe-Account only for that parish', async () => {
    process.env.OC_BETA_BILLING = 'off'
    await saveConnectAccount(A.slug, 'acct_N4431PARISH1')
    const calls = liveStripe()
    const res = await give(A.slug, {
      fund_id: A.fundId, amount: 25, donor_name: 'N4431 Donor',
      stripe_connect_account_id: 'acct_ATTACKER999', // body must still be ignored
    })
    // Live Stripe path returns 200 + checkout_url (not 201 — the donation
    // row is written by the webhook after Checkout completes).
    expect(res.status).toBe(200)
    expect(res.body.checkout_url).toMatch(/^https:\/\/checkout\.stripe\.test\//)
    expect(JSON.stringify(res.body)).not.toMatch(/acct_/)
    const checkout = calls.filter(c => String(c.url).includes('checkout/sessions'))
    expect(checkout.length).toBeGreaterThanOrEqual(1)
    expect(checkout.every(c => c.headers['Stripe-Account'] === 'acct_N4431PARISH1')).toBe(true)
    expect(calls.filter(c => c.headers['Stripe-Account'] === 'acct_ATTACKER999')).toHaveLength(0)
  })

  it('default hold still blocks Checkout even when a Connect account is saved', async () => {
    delete process.env.OC_BETA_BILLING
    await saveConnectAccount(A.slug, 'acct_N4431PARISH1')
    const calls = liveStripe()
    const res = await give(A.slug, {
      fund_id: A.fundId, amount: 25, donor_name: 'Hold+Acct Donor',
    })
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'beta_billing_disabled' })
    expect(calls).toHaveLength(0)
  })
})
