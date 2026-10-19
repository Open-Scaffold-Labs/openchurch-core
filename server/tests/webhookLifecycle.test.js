// Webhook lifecycle truth — two ways a correctly signed Stripe event could
// still fail to become (or wrongly become) a donation row.
//
//   W1  A signed event was acknowledged into silence because of which
//       provider was SELECTED. PAYMENTS_PROVIDER_SECRET removed (rotation,
//       rollback) while BILLING_WEBHOOK_SECRET stayed → handleWebhook took
//       the stub short-circuit before looking at the signing secret →
//       {received:true, stub:true} 200, no row, and bad signatures were
//       200 too. The ability to VERIFY decides, not the provider switch.
//
//   W2  A database row is not a settled payment. Stripe sends
//       checkout.session.completed with payment_status 'unpaid' for
//       delayed-notification methods (ACH debit, SEPA, OXXO…) and the
//       money arrives — or does not — days later as
//       checkout.session.async_payment_succeeded / _failed. The recorder
//       wrote 'succeeded' and sent a receipt on the 'unpaid' event.
//
// Every assertion here is on durable state — the ochr_donations row and the
// receipt in ochr_notification_log — not only on the response body. A 200
// is what Stripe sees; the row is what the parish sees.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import request from 'supertest'
import crypto from 'node:crypto'
import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'
import { _setDispatchForTests } from '../src/monitoring/index.js'

let server
const cleanupOrgIds = []
const WH = `whsec_wl_${RUN_ID}`

// Keep the stub transports' console chatter out of the run without
// suppressing anything that is not theirs.
const origLog = console.log
beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  console.log = (...a) => {
    const s = a.join(' ')
    if (!/\[notify:stub\]|\[pay:stub\]|\[billing:stub\]/.test(s)) origLog(...a)
  }
}, 60_000)

afterAll(async () => {
  console.log = origLog
  for (const id of cleanupOrgIds) {
    await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
  }
  await closeServer(server)
  await pool.end()
})

let ipSeq = 0
const ip = () => `10.64.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`
const auth = t => ({ Authorization: `Bearer ${t}` })
async function signup(payload) {
  const res = await createOrg(server, payload, ip())
  expect(res.status).toBe(201)
  cleanupOrgIds.push(res.body.user.organization.id)
  return { token: res.body.token, orgId: res.body.user.organization.id, slug: res.body.user.organization.slug }
}
async function mkFund(par, name) {
  const r = await request(server).post('/api/funds').set(auth(par.token)).send({ name })
  expect(r.status).toBe(201)
  return r.body
}

// Stripe-style signature over `${t}.${body}` with the endpoint secret.
const signed = (bodyStr, secret, t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${bodyStr}`).digest('hex')}`
const postWebhook = (body, sig) => {
  const r = request(server).post('/api/billing/webhook').set('Content-Type', 'application/json')
  if (sig) r.set('stripe-signature', sig)
  return r.send(body)
}

// Env is process-global. Every block sets exactly the variables its row of
// the matrix names and clears the rest, then restores what it found.
const ENV_KEYS = ['PAYMENTS_PROVIDER', 'PAYMENTS_PROVIDER_SECRET', 'BILLING_PROVIDER_SECRET', 'BILLING_WEBHOOK_SECRET']
function snapshotEnv() {
  const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
  return () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]
    }
  }
}
function setEnv(obj) {
  for (const k of ENV_KEYS) delete process.env[k]
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) process.env[k] = v
}

const rowsFor = ref => pool.query(
  `SELECT id, organization_id, amount::text, payment_status, fund_id FROM ochr_donations WHERE payment_ref = $1 ORDER BY id`, [ref]
).then(r => r.rows)
const receiptsFor = email => pool.query(
  `SELECT id, status FROM ochr_notification_log WHERE notification_type = 'donation_receipt' AND recipient_email = $1 ORDER BY id`, [email]
).then(r => r.rows)
const planOf = orgId => pool.query('SELECT plan, billing_status FROM ochr_organizations WHERE id = $1', [orgId]).then(r => r.rows[0])

// A Stripe checkout.session object the way createDonationCheckout stamps it,
// with the event envelope around it. `type` and `payment_status` are the
// two knobs W2 turns.
let seq = 0
function donationEvent({ par, fund, tag, type = 'checkout.session.completed', paymentStatus = 'paid', amount = 4200, email = true }) {
  const suffix = `${tag}_${RUN_ID}_${seq++}`
  const pi = `pi_wl_${suffix}`
  const donorEmail = email ? `wl_${suffix}@example.com` : undefined
  const object = {
    id: `cs_wl_${suffix}`, object: 'checkout.session', mode: 'payment', status: 'complete',
    payment_intent: pi, amount_total: amount, currency: 'usd',
    metadata: {
      kind: 'donation', organization_id: String(par.orgId), fund_id: String(fund.id), fund: fund.name,
      donor_name: `Donor ${tag}`, ...(donorEmail ? { donor_email: donorEmail } : {}),
    },
  }
  if (paymentStatus !== undefined) object.payment_status = paymentStatus
  const mk = t => JSON.stringify({ id: `evt_wl_${suffix}_${t}`, type: t, data: { object } })
  return { pi, donorEmail, object, body: mk(type), withType: mk }
}
function subscriptionEvent(par, tag) {
  const suffix = `${tag}_${RUN_ID}_${seq++}`
  return JSON.stringify({ type: 'checkout.session.completed', data: { object: {
    id: `cs_wl_${suffix}`, mode: 'subscription', customer: `cus_wl_${suffix}`, subscription: `sub_wl_${suffix}`,
    metadata: { organization_id: String(par.orgId), plan: 'pro' } } } })
}

// ─────────────────────────────────────────────────────────────────────────
// W1 — the signing secret decides, not the selected provider
// ─────────────────────────────────────────────────────────────────────────
describe('W1 — a signed event is verified and recorded whenever a signing secret exists', () => {
  let par, fund, restoreEnv

  beforeAll(async () => {
    restoreEnv = snapshotEnv()
    par = await signup({ organizationName: `WL w1 Parish ${RUN_ID}`, name: 'Admin',
      email: `wl_w1_${RUN_ID}@example.com`, password: 'wl-pw-w1-1' })
    fund = await mkFund(par, `General ${RUN_ID}`)
  }, 30_000)
  afterAll(() => restoreEnv())

  // THE ROLLBACK ROW. Giving was live, the parish took gifts, and then the
  // secret was removed — rotation, or a rollback that pulled the whole
  // variable. Stripe still delivers the sessions donors already completed,
  // and the endpoint still has the secret that can verify them.
  it('PAYMENTS_PROVIDER_SECRET removed, BILLING_WEBHOOK_SECRET kept → a signed donation is RECORDED', async () => {
    setEnv({ BILLING_WEBHOOK_SECRET: WH })
    const ev = donationEvent({ par, fund, tag: 'rollback' })
    const res = await postWebhook(ev.body, signed(ev.body, WH))
    expect(res.status).toBe(200)
    expect(res.body.stub).toBeUndefined()
    expect(res.body.handled).toBe('donation')
    const rows = await rowsFor(ev.pi)
    expect(rows).toHaveLength(1)
    expect(rows[0].organization_id).toBe(par.orgId)
    expect(rows[0].amount).toBe('42.00')
    expect(rows[0].payment_status).toBe('succeeded')
    expect(await receiptsFor(ev.donorEmail)).toHaveLength(1)
  })

  it('…and in that state a BAD signature is refused (400), not acknowledged', async () => {
    setEnv({ BILLING_WEBHOOK_SECRET: WH })
    const ev = donationEvent({ par, fund, tag: 'rollbackbad' })
    const wrong = await postWebhook(ev.body, signed(ev.body, 'whsec_wrong'))
    expect(wrong.status).toBe(400)
    const tampered = ev.body.replace('"amount_total":4200', '"amount_total":420000')
    const tamperedRes = await postWebhook(tampered, signed(ev.body, WH))
    expect(tamperedRes.status).toBe(400)
    const none = await postWebhook(ev.body, null)
    expect(none.status).toBe(400)
    expect(await rowsFor(ev.pi)).toHaveLength(0)
  })

  // With NO signing secret anywhere there is nothing to verify against, so
  // "signed" and "unsigned" are indistinguishable to this deployment — the
  // stub acknowledgement is the only honest answer, and the fact that it
  // never parses the body is the point (nothing unverified is applied).
  it('nothing set at all → stub ack 200, nothing recorded (there is no secret to verify with)', async () => {
    setEnv({})
    const ev = donationEvent({ par, fund, tag: 'nothing' })
    const res = await postWebhook(ev.body, signed(ev.body, WH))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ received: true, stub: true })
    expect(await rowsFor(ev.pi)).toHaveLength(0)
    const bad = await postWebhook(ev.body, signed(ev.body, 'whsec_wrong'))
    expect(bad.status).toBe(200)
    expect(bad.body).toEqual({ received: true, stub: true })
    expect(await rowsFor(ev.pi)).toHaveLength(0)
  })

  // The documented M6 case: switching giving OFF with the secret still in
  // the environment does not discard gifts already in flight.
  it('PAYMENTS_PROVIDER=stub with the giving secret retained + whsec → still recorded (M6)', async () => {
    setEnv({ PAYMENTS_PROVIDER: 'stub', PAYMENTS_PROVIDER_SECRET: 'sk_test_wl_giving', BILLING_WEBHOOK_SECRET: WH })
    const ev = donationEvent({ par, fund, tag: 'm6' })
    const res = await postWebhook(ev.body, signed(ev.body, WH))
    expect(res.status).toBe(200)
    expect(res.body.handled).toBe('donation')
    expect(await rowsFor(ev.pi)).toHaveLength(1)
  })

  // Unchanged: live without a signing secret is a deployment fault, and
  // the answer is a retry (non-2xx), never a 200 that ends the delivery.
  it('giving live, NO BILLING_WEBHOOK_SECRET → non-2xx naming the variable, 0 rows', async () => {
    setEnv({ PAYMENTS_PROVIDER_SECRET: 'sk_test_wl_giving' })
    const ev = donationEvent({ par, fund, tag: 'nowhsec' })
    const res = await postWebhook(ev.body, signed(ev.body, WH))
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(res.body.received).toBe(false)
    expect(res.body.error).toContain('BILLING_WEBHOOK_SECRET')
    expect(await rowsFor(ev.pi)).toHaveLength(0)
  })

  // Subscription events with billing in stub mode keep today's behaviour:
  // verified (a bad signature is still 400), then acknowledged as stub and
  // NOT applied — billing has not been switched on, so there is nothing
  // to apply a plan change to.
  it('subscription event, billing stub, whsec → verified, then stub-acknowledged and NOT applied', async () => {
    setEnv({ BILLING_WEBHOOK_SECRET: WH })
    const before = await planOf(par.orgId)
    const body = subscriptionEvent(par, 'sub')
    const res = await postWebhook(body, signed(body, WH))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ received: true, stub: true })
    expect(await planOf(par.orgId)).toEqual(before)
    const bad = await postWebhook(body, signed(body, 'whsec_wrong'))
    expect(bad.status).toBe(400)
    expect(await planOf(par.orgId)).toEqual(before)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// W2 — a row is written when the money moved, not when the session closed
// ─────────────────────────────────────────────────────────────────────────
describe('W2 — checkout.session.completed with payment_status unpaid is not a gift yet', () => {
  let par, fund, restoreEnv, restoreMonitor
  const captured = []

  beforeAll(async () => {
    restoreEnv = snapshotEnv()
    par = await signup({ organizationName: `WL w2 Parish ${RUN_ID}`, name: 'Admin',
      email: `wl_w2_${RUN_ID}@example.com`, password: 'wl-pw-w2-1' })
    fund = await mkFund(par, `Building ${RUN_ID}`)
    restoreMonitor = _setDispatchForTests((level, scope, message, context) => captured.push({ level, scope, message, context }))
  }, 30_000)
  afterAll(() => { restoreMonitor(); restoreEnv() })
  beforeEach(() => {
    captured.length = 0
    setEnv({ PAYMENTS_PROVIDER_SECRET: 'sk_test_wl_giving', BILLING_WEBHOOK_SECRET: WH })
  })

  it('unpaid completed → 200 (Stripe will follow up), 0 rows, 0 receipts, and the operator is told', async () => {
    const ev = donationEvent({ par, fund, tag: 'unpaid', paymentStatus: 'unpaid' })
    const res = await postWebhook(ev.body, signed(ev.body, WH))
    expect(res.status).toBe(200)
    expect(res.body.received).toBe(true)
    expect(await rowsFor(ev.pi)).toHaveLength(0)
    expect(await receiptsFor(ev.donorEmail)).toHaveLength(0)
    expect(captured.some(c => c.level === 'warn' && /payments\.webhook/.test(c.scope) && /unpaid/.test(c.message))).toBe(true)
  })

  it('…then async_payment_succeeded for the same session → 1 row, 1 receipt; redelivered → still 1 and 1', async () => {
    const ev = donationEvent({ par, fund, tag: 'ach', paymentStatus: 'unpaid' })
    await postWebhook(ev.body, signed(ev.body, WH))
    expect(await rowsFor(ev.pi)).toHaveLength(0)

    // Days later the bank confirms; Stripe sends the same session object,
    // now paid, under the follow-up event type.
    ev.object.payment_status = 'paid'
    const settled = ev.withType('checkout.session.async_payment_succeeded')
    const res = await postWebhook(settled, signed(settled, WH))
    expect(res.status).toBe(200)
    expect(res.body.handled).toBe('donation')
    let rows = await rowsFor(ev.pi)
    expect(rows).toHaveLength(1)
    expect(rows[0].payment_status).toBe('succeeded')
    expect(rows[0].amount).toBe('42.00')
    expect(Number(rows[0].fund_id)).toBe(Number(fund.id))
    expect(await receiptsFor(ev.donorEmail)).toHaveLength(1)

    // Redelivery: dedup by payment_ref still holds across event types.
    const again = await postWebhook(settled, signed(settled, WH))
    expect(again.status).toBe(200)
    rows = await rowsFor(ev.pi)
    expect(rows).toHaveLength(1)
    expect(await receiptsFor(ev.donorEmail)).toHaveLength(1)
  })

  it('async_payment_failed → 200, nothing recorded, logged', async () => {
    const ev = donationEvent({ par, fund, tag: 'achfail', paymentStatus: 'unpaid' })
    await postWebhook(ev.body, signed(ev.body, WH))
    const failed = ev.withType('checkout.session.async_payment_failed')
    const res = await postWebhook(failed, signed(failed, WH))
    expect(res.status).toBe(200)
    expect(res.body.received).toBe(true)
    expect(await rowsFor(ev.pi)).toHaveLength(0)
    expect(await receiptsFor(ev.donorEmail)).toHaveLength(0)
    expect(captured.some(c => /payments\.webhook/.test(c.scope) && /failed/.test(c.message))).toBe(true)
  })

  it('paid completed is unchanged → 1 row, 1 receipt; redelivered → still 1', async () => {
    const ev = donationEvent({ par, fund, tag: 'card' })
    const res = await postWebhook(ev.body, signed(ev.body, WH))
    expect(res.status).toBe(200)
    expect(res.body.handled).toBe('donation')
    expect(await rowsFor(ev.pi)).toHaveLength(1)
    expect(await receiptsFor(ev.donorEmail)).toHaveLength(1)
    await postWebhook(ev.body, signed(ev.body, WH))
    expect(await rowsFor(ev.pi)).toHaveLength(1)
    expect(await receiptsFor(ev.donorEmail)).toHaveLength(1)
  })

  it('no_payment_required (a 100%-discounted session) is recorded like paid', async () => {
    const ev = donationEvent({ par, fund, tag: 'free', paymentStatus: 'no_payment_required' })
    const res = await postWebhook(ev.body, signed(ev.body, WH))
    expect(res.status).toBe(200)
    expect(await rowsFor(ev.pi)).toHaveLength(1)
  })

  // A payment_status this code has never heard of is neither "paid" nor
  // "not yet". Acknowledging it would end the delivery on a guess; the
  // honest answer is a retry, so the operator sees it and Stripe keeps it.
  it('an unknown payment_status is neither recorded nor acknowledged (non-2xx, 0 rows)', async () => {
    const ev = donationEvent({ par, fund, tag: 'weird', paymentStatus: 'partially_settled' })
    const res = await postWebhook(ev.body, signed(ev.body, WH))
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(await rowsFor(ev.pi)).toHaveLength(0)
    expect(await receiptsFor(ev.donorEmail)).toHaveLength(0)
  })
})
