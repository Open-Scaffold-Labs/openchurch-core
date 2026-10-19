// False success around money — four places where the server said "done"
// (or "nothing happened") and money disagreed. Each was reproduced at
// runtime on 4 Sep, before anything was touched, with the same chaos
// technique used here: a BEFORE trigger that RAISEs on a marker donor
// name, or a one-shot sequence, so the failure lands on exactly the
// statement under test and nowhere else.
//
//   D1  REFUND. The provider refund succeeded, then the UPDATE failed →
//       500, and the client toast said "nothing was lost". The retry sent
//       the provider a SECOND refund (two refund ids at the stub; Stripe
//       rejects the second, and the row is then stuck 'succeeded' with the
//       money already returned). Closed by a per-refund idempotency key
//       (`refund-{org}-{donation}-{refundId}`): the pending fact is committed
//       before the provider call, so a retry is the SAME refund.
//   D2  PUBLIC GIVE (stub path). The donation INSERT and the recurring
//       INSERT were two autocommits. The second failing → 500 "Failed to
//       process gift" with the donation row already written; the client
//       re-enables submit; the donor gives again; two charges, two rows.
//       Closed by one transaction: 201 with both rows, or 500 with neither.
//   D3  WEBHOOK DISCARD. Giving live (PAYMENTS_PROVIDER_SECRET) with
//       billing still stub (BILLING_PROVIDER_SECRET unset) → handleWebhook
//       answered {received:true, stub:true} 200 before parsing, so every
//       checkout.session.completed donation was acknowledged and dropped.
//       Stripe never retries a 2xx: money moved, no row, no receipt.
//   D4  WEBHOOK FUND GONE. The parish deleted the fund between Checkout
//       and the webhook → FK 23503 on the INSERT → 500 on every redelivery
//       → after Stripe's retry window the gift was lost. Closed by
//       resolving the fund first: a missing fund is recorded as fund_id
//       NULL with the designation kept in category, and the operator told.
//
// Every block signs up its own orgs and shares nothing with the rest of
// the suite, in the pattern of financialTruth.test.js.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import request from 'supertest'
import 'dotenv/config'
import crypto from 'node:crypto'

import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'
import { handleWebhook } from '../src/billing/provider.js'

let server
const cleanupOrgIds = []

// Every stub refund call is one `[pay:stub] refund (charge and amount not logged) → <ref>` line.
// Capturing it is how a test can say "the provider was called N times with
// these refs" without adding a seam to production code for the purpose.
const refundLog = []
const origLog = console.log

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  await pool.query(`
    CREATE SEQUENCE IF NOT EXISTS zz_fsm_refund_seq;
    -- One-shot: the FIRST refund UPDATE of the marker donor fails, the
    -- second succeeds. nextval is non-transactional, so the ROLLBACK the
    -- failure causes does not re-arm it.
    CREATE OR REPLACE FUNCTION zz_fsm_boom_refund() RETURNS trigger AS $$
    BEGIN
      IF NEW.donor_name = 'FSM Update Fail Donor' AND NEW.refund_ref IS NOT NULL AND OLD.refund_ref IS NULL THEN
        IF nextval('zz_fsm_refund_seq') = 1 THEN RAISE EXCEPTION 'chaos: refund update refused'; END IF;
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS zz_fsm_boom_refund ON ochr_donations;
    CREATE TRIGGER zz_fsm_boom_refund BEFORE UPDATE ON ochr_donations FOR EACH ROW EXECUTE FUNCTION zz_fsm_boom_refund();

    -- Marker donor: every recurring-schedule INSERT for them is refused.
    CREATE OR REPLACE FUNCTION zz_fsm_boom_rg() RETURNS trigger AS $$
    BEGIN
      IF NEW.donor_name = 'FSM BOOM-RG' THEN RAISE EXCEPTION 'chaos: recurring insert refused'; END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS zz_fsm_boom_rg ON ochr_recurring_gifts;
    CREATE TRIGGER zz_fsm_boom_rg BEFORE INSERT ON ochr_recurring_gifts FOR EACH ROW EXECUTE FUNCTION zz_fsm_boom_rg();
  `)
  console.log = (...a) => {
    const s = a.join(' ')
    if (/\[pay:stub\] refund/.test(s)) refundLog.push(s)
    origLog(...a)
  }
}, 60_000)

afterAll(async () => {
  console.log = origLog
  await pool.query(`
    DROP TRIGGER IF EXISTS zz_fsm_boom_refund ON ochr_donations;
    DROP TRIGGER IF EXISTS zz_fsm_boom_rg ON ochr_recurring_gifts;
    DROP FUNCTION IF EXISTS zz_fsm_boom_refund();
    DROP FUNCTION IF EXISTS zz_fsm_boom_rg();
    DROP SEQUENCE IF EXISTS zz_fsm_refund_seq;
  `).catch(() => {})
  for (const id of cleanupOrgIds) {
    await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
  }
  await closeServer(server)
  await pool.end()
})

let ipSeq = 0
const ip = () => `10.63.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`
async function signup(payload) {
  const res = await createOrg(server, payload, ip())
  expect(res.status).toBe(201)
  cleanupOrgIds.push(res.body.user.organization.id)
  return { token: res.body.token, orgId: res.body.user.organization.id, slug: res.body.user.organization.slug }
}
const auth = t => ({ Authorization: `Bearer ${t}` })

async function mkFund(par, name) {
  const r = await request(server).post('/api/funds').set(auth(par.token)).send({ name })
  expect(r.status).toBe(201)
  return r.body
}
const give = (slug, body) => request(server).post(`/api/public/${slug}/give`).set('X-Forwarded-For', ip()).send(body)
const refund = (par, id) => request(server).post(`/api/donations/${id}/refund`).set(auth(par.token)).send({})
const donationRow = id => pool.query(
  'SELECT payment_status, refund_ref, fund_id, category, notes FROM ochr_donations WHERE id = $1', [id]
).then(r => r.rows[0])
const refOf = line => line.split('→')[1]?.trim().split('|')[0].trim()

// A stub-charged public gift, the way the ledger actually acquires one.
async function chargedGift(par, fund, donorName, amount = 100) {
  const r = await give(par.slug, { fund_id: fund.id, amount, donor_name: donorName })
  expect(r.status).toBe(201)
  const { rows } = await pool.query(
    'SELECT id FROM ochr_donations WHERE organization_id = $1 AND payment_ref = $2', [par.orgId, r.body.receipt.reference])
  return rows[0].id
}

// Stripe-style signature over `${t}.${body}` with the webhook secret.
const signed = (bodyStr, secret, t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${bodyStr}`).digest('hex')}`
const postWebhook = (body, sig) => request(server).post('/api/billing/webhook')
  .set('Content-Type', 'application/json').set('stripe-signature', sig).send(body)

// Env is process-global and other blocks in this file need it in different
// states, so every block restores exactly what it found.
const ENV_KEYS = ['PAYMENTS_PROVIDER', 'PAYMENTS_PROVIDER_SECRET', 'BILLING_PROVIDER_SECRET', 'BILLING_WEBHOOK_SECRET']
function snapshotEnv() {
  const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
  return () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// D1 — a refund is one provider refund, however many times the route runs
// ─────────────────────────────────────────────────────────────────────────
describe('D1 — refund carries a deterministic idempotency key, so money moves once', () => {
  let par, fund, restoreEnv

  beforeAll(async () => {
    restoreEnv = snapshotEnv()
    process.env.PAYMENTS_PROVIDER = 'stub'
    par = await signup({ organizationName: `FSM d1 Parish ${RUN_ID}`, name: 'Bookkeeper',
      email: `fsm_d1_${RUN_ID}@example.com`, password: 'fsm-pw-d1-1' })
    fund = await mkFund(par, `General ${RUN_ID}`)
  }, 30_000)
  afterAll(() => restoreEnv())
  beforeEach(() => { refundLog.length = 0 })

  const expectedRef = (donationId, refundId) =>
    `stubref_refund-${par.orgId}-${donationId}-${refundId}`

  it('provider refund succeeds, UPDATE fails → 500; the retry is the SAME provider refund → 200', async () => {
    const id = await chargedGift(par, fund, 'FSM Update Fail Donor')
    await pool.query(`SELECT setval('zz_fsm_refund_seq', 1, false)`)

    const first = await refund(par, id)
    expect(first.status).toBe(500)
    const afterFail = await donationRow(id)
    expect(afterFail.payment_status).toBe('succeeded')
    expect(afterFail.refund_ref).toBeNull()
    const { rows: pending } = await pool.query(
      `SELECT id FROM ochr_donation_refunds WHERE donation_id = $1 AND status = 'pending'`, [id])
    expect(pending).toHaveLength(1)
    const keyRef = expectedRef(id, pending[0].id)

    const retry = await refund(par, id)
    expect(retry.status).toBe(200)
    expect(retry.body.payment_status).toBe('refunded')
    expect(retry.body.refund_ref).toBe(keyRef)

    // Two calls reached the provider — and they were the same refund.
    expect(refundLog.length).toBe(2)
    const refs = new Set(refundLog.map(refOf))
    expect([...refs]).toEqual([keyRef])
  })

  it('two concurrent full refunds → [200, 409]; the loser never mints a second provider key', async () => {
    const id = await chargedGift(par, fund, 'FSM Race Donor')
    const [a, b] = await Promise.all([refund(par, id), refund(par, id)])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    const { rows: facts } = await pool.query(
      `SELECT id, status FROM ochr_donation_refunds WHERE donation_id = $1 ORDER BY id`, [id])
    expect(facts.filter(r => r.status === 'posted')).toHaveLength(1)
    const posted = facts.find(r => r.status === 'posted')
    const refs = new Set(refundLog.map(refOf))
    expect([...refs]).toEqual([expectedRef(id, posted.id)])
    expect((await donationRow(id)).refund_ref).toBe(expectedRef(id, posted.id))
  })

  it('control: a second refund of an already-refunded gift → 409 before the provider', async () => {
    const id = await chargedGift(par, fund, 'FSM Twice Refund')
    expect((await refund(par, id)).status).toBe(200)
    refundLog.length = 0
    const again = await refund(par, id)
    expect(again.status).toBe(409)
    expect(refundLog.length).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// D2 — public give writes both rows or neither
// ─────────────────────────────────────────────────────────────────────────
describe('D2 — public give (stub): the donation and the recurring schedule land together or not at all', () => {
  let par, fund, restoreEnv

  beforeAll(async () => {
    restoreEnv = snapshotEnv()
    process.env.PAYMENTS_PROVIDER = 'stub'
    par = await signup({ organizationName: `FSM d2 Parish ${RUN_ID}`, name: 'Bookkeeper',
      email: `fsm_d2_${RUN_ID}@example.com`, password: 'fsm-pw-d2-1' })
    fund = await mkFund(par, `Building ${RUN_ID}`)
  }, 30_000)
  afterAll(() => restoreEnv())

  const donationsFor = name => pool.query(
    'SELECT id FROM ochr_donations WHERE organization_id = $1 AND donor_name = $2', [par.orgId, name]).then(r => r.rows)
  const schedulesFor = name => pool.query(
    'SELECT id FROM ochr_recurring_gifts WHERE organization_id = $1 AND donor_name = $2', [par.orgId, name]).then(r => r.rows)

  it('recurring INSERT fails → 500 and ZERO donation rows', async () => {
    const r = await give(par.slug, { fund_id: fund.id, amount: 30, donor_name: 'FSM BOOM-RG', frequency: 'monthly' })
    expect(r.status).toBe(500)
    expect(await donationsFor('FSM BOOM-RG')).toHaveLength(0)
    expect(await schedulesFor('FSM BOOM-RG')).toHaveLength(0)
  })

  it('control: a recurring gift → 201 with both rows', async () => {
    const r = await give(par.slug, { fund_id: fund.id, amount: 30, donor_name: 'FSM Steady Donor', frequency: 'monthly' })
    expect(r.status).toBe(201)
    expect(r.body.receipt.recurring).toBe('monthly')
    expect(await donationsFor('FSM Steady Donor')).toHaveLength(1)
    expect(await schedulesFor('FSM Steady Donor')).toHaveLength(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// D3 — giving live with billing stub must not discard donation webhooks
// ─────────────────────────────────────────────────────────────────────────
describe('D3 — the webhook records live gifts even when billing is still the stub', () => {
  let par, restoreEnv
  const WH_SECRET = 'whsec_fsm_secret'

  const donationEvent = (suffix, extraMeta = {}) => JSON.stringify({
    type: 'checkout.session.completed',
    data: { object: {
      id: `cs_fsm_${suffix}_${RUN_ID}`, mode: 'payment', payment_intent: `pi_fsm_${suffix}_${RUN_ID}`, amount_total: 4200,
      metadata: { kind: 'donation', organization_id: String(par.orgId), donor_name: 'Split Config Donor', fund: 'General', ...extraMeta },
    } },
  })
  const rowsFor = suffix => pool.query(
    'SELECT 1 FROM ochr_donations WHERE payment_ref = $1', [`pi_fsm_${suffix}_${RUN_ID}`]).then(r => r.rows)

  beforeAll(async () => {
    restoreEnv = snapshotEnv()
    par = await signup({ organizationName: `FSM d3 Parish ${RUN_ID}`, name: 'Admin',
      email: `fsm_d3_${RUN_ID}@example.com`, password: 'fsm-pw-d3-1' })
  }, 30_000)
  afterAll(() => restoreEnv())

  function givingLiveBillingStub() {
    delete process.env.PAYMENTS_PROVIDER
    process.env.PAYMENTS_PROVIDER_SECRET = 'sk_test_fsm_giving'
    delete process.env.BILLING_PROVIDER_SECRET
  }

  it('giving stripe, billing unset, NO webhook secret → 503 naming the variable, not a 200 ack', async () => {
    givingLiveBillingStub()
    delete process.env.BILLING_WEBHOOK_SECRET
    const body = donationEvent('nosecret')
    // The module says 503 — "not configured", not "bad event" (400) and
    // not "done" (200)…
    await expect(handleWebhook({ rawBody: Buffer.from(body), signature: 't=1,v1=deadbeef' }))
      .rejects.toMatchObject({ statusCode: 503, message: expect.stringContaining('BILLING_WEBHOOK_SECRET') })
    // …and the route answers non-2xx with the same message. routes/billing.js
    // folds every non-400 into 500 today (out of scope for this pass); to
    // Stripe both are "redeliver", which is what matters here. Pinned as
    // >= 500 so passing the 503 through later does not break this.
    const res = await postWebhook(body, 't=1,v1=deadbeef')
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(res.body.received).toBe(false)
    expect(res.body.error).toContain('BILLING_WEBHOOK_SECRET')
    expect(await rowsFor('nosecret')).toHaveLength(0)
  })

  it('giving stripe, billing unset, webhook secret set → a signed donation event is RECORDED', async () => {
    givingLiveBillingStub()
    process.env.BILLING_WEBHOOK_SECRET = WH_SECRET
    const body = donationEvent('recorded', { donor_email: `fsm_d3_donor_${RUN_ID}@example.com` })
    const res = await postWebhook(body, signed(body, WH_SECRET))
    expect(res.status).toBe(200)
    expect(res.body.handled).toBe('donation')
    expect(res.body.stub).toBeUndefined()
    const { rows } = await pool.query(
      'SELECT amount, payment_status FROM ochr_donations WHERE payment_ref = $1', [`pi_fsm_recorded_${RUN_ID}`])
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].amount)).toBe(42)
    expect(rows[0].payment_status).toBe('succeeded')
  })

  it('…and the signature is still verified in that mode (bad signature → 400, no row)', async () => {
    givingLiveBillingStub()
    process.env.BILLING_WEBHOOK_SECRET = WH_SECRET
    const body = donationEvent('badsig')
    const res = await postWebhook(body, signed(body, 'whsec_wrong'))
    expect(res.status).toBe(400)
    expect(await rowsFor('badsig')).toHaveLength(0)
  })

  it('…while a verified SUBSCRIPTION event is still acknowledged as stub, and applies nothing', async () => {
    givingLiveBillingStub()
    process.env.BILLING_WEBHOOK_SECRET = WH_SECRET
    const body = JSON.stringify({
      type: 'checkout.session.completed',
      data: { object: { id: `cs_fsm_sub_${RUN_ID}`, mode: 'subscription', customer: `cus_fsm_${RUN_ID}`,
        subscription: `sub_fsm_${RUN_ID}`, metadata: { organization_id: String(par.orgId), plan: 'pro' } } },
    })
    const res = await postWebhook(body, signed(body, WH_SECRET))
    expect(res.status).toBe(200)
    expect(res.body.received).toBe(true)
    expect(res.body.stub).toBe(true)
    const { rows } = await pool.query('SELECT plan FROM ochr_organizations WHERE id = $1', [par.orgId])
    expect(rows[0].plan).not.toBe('pro')
  })

  it('control: both giving and billing stub → the stub ack is unchanged (200, stub:true, nothing parsed)', async () => {
    process.env.PAYMENTS_PROVIDER = 'stub'
    delete process.env.PAYMENTS_PROVIDER_SECRET
    delete process.env.BILLING_PROVIDER_SECRET
    delete process.env.BILLING_WEBHOOK_SECRET
    const res = await postWebhook(donationEvent('allstub'), 't=1,v1=deadbeef')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ received: true, stub: true })
    expect(await rowsFor('allstub')).toHaveLength(0)
  })

  it('/api/health: giving stripe without a webhook secret is NOT capable; with one it is', async () => {
    givingLiveBillingStub()
    delete process.env.BILLING_WEBHOOK_SECRET
    let res = await request(server).get('/api/health')
    expect(res.status).toBe(200)
    expect(res.body.payments_provider).toBe('stripe')
    expect(res.body.payments_webhook_ready).toBe(false)
    expect(res.body.payments_capable).toBe(false)

    process.env.BILLING_WEBHOOK_SECRET = WH_SECRET
    res = await request(server).get('/api/health')
    expect(res.body.payments_webhook_ready).toBe(true)
    expect(res.body.payments_capable).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// D4 — a fund deleted between Checkout and the webhook does not lose the gift
// ─────────────────────────────────────────────────────────────────────────
describe('D4 — a donation webhook whose fund is gone is recorded undesignated, not refused forever', () => {
  let par, restoreEnv
  const WH_SECRET = 'whsec_fsm_d4'

  const donationEvent = (suffix, fundId, fundName) => JSON.stringify({
    type: 'checkout.session.completed',
    data: { object: {
      id: `cs_fsm_d4_${suffix}_${RUN_ID}`, mode: 'payment', payment_intent: `pi_fsm_d4_${suffix}_${RUN_ID}`, amount_total: 7500,
      metadata: { kind: 'donation', organization_id: String(par.orgId), fund_id: String(fundId), fund: fundName, donor_name: 'Late Webhook Donor' },
    } },
  })
  const rowFor = suffix => pool.query(
    'SELECT fund_id, category, notes, payment_status FROM ochr_donations WHERE payment_ref = $1', [`pi_fsm_d4_${suffix}_${RUN_ID}`]
  ).then(r => r.rows[0])

  beforeAll(async () => {
    restoreEnv = snapshotEnv()
    par = await signup({ organizationName: `FSM d4 Parish ${RUN_ID}`, name: 'Admin',
      email: `fsm_d4_${RUN_ID}@example.com`, password: 'fsm-pw-d4-1' })
    process.env.BILLING_PROVIDER_SECRET = 'sk_test_fsm_billing'
    process.env.BILLING_WEBHOOK_SECRET = WH_SECRET
  }, 30_000)
  afterAll(() => restoreEnv())

  it('fund vault-deleted after Checkout → 200, row with fund_id NULL and the designation kept', async () => {
    const fundName = `Youth Trip ${RUN_ID}`
    const fund = await mkFund(par, fundName)
    // Built while the fund existed — exactly what Checkout stamped.
    const body = donationEvent('gone', fund.id, fundName)
    // A fund with no gifts deletes (into the vault). This is the window.
    const del = await request(server).delete(`/api/funds/${fund.id}`).set(auth(par.token))
    expect(del.status).toBe(204)

    const res = await postWebhook(body, signed(body, WH_SECRET))
    expect(res.status).toBe(200)
    expect(res.body.handled).toBe('donation')

    const row = await rowFor('gone')
    expect(row).toBeTruthy()
    expect(row.fund_id).toBeNull()
    expect(row.payment_status).toBe('succeeded')
    expect(row.category).toBe(fundName)
    expect(row.notes).toContain(fundName)

    // Redelivery is still a no-op, not a second row.
    const again = await postWebhook(body, signed(body, WH_SECRET))
    expect(again.status).toBe(200)
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM ochr_donations WHERE payment_ref = $1', [`pi_fsm_d4_gone_${RUN_ID}`])
    expect(rows[0].n).toBe(1)
  })

  it('control: fund present → the row carries fund_id', async () => {
    const fundName = `Roof ${RUN_ID}`
    const fund = await mkFund(par, fundName)
    const body = donationEvent('present', fund.id, fundName)
    const res = await postWebhook(body, signed(body, WH_SECRET))
    expect(res.status).toBe(200)
    const row = await rowFor('present')
    expect(Number(row.fund_id)).toBe(Number(fund.id))
    expect(row.category).toBe(fundName)
    expect(row.notes).toBeNull()
  })

  it("a fund id belonging to ANOTHER parish is treated as gone, not borrowed", async () => {
    const other = await signup({ organizationName: `FSM d4 Other ${RUN_ID}`, name: 'Admin',
      email: `fsm_d4_other_${RUN_ID}@example.com`, password: 'fsm-pw-d4-2' })
    const theirs = await mkFund(other, `Theirs ${RUN_ID}`)
    const body = donationEvent('foreign', theirs.id, 'Theirs')
    const res = await postWebhook(body, signed(body, WH_SECRET))
    expect(res.status).toBe(200)
    const row = await rowFor('foreign')
    expect(row.fund_id).toBeNull()
    expect(row.category).toBe('Theirs')
  })
})
