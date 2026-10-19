// Stage 6 — verified billing/giving webhook events are stored durably and
// idempotently before they are applied or acknowledged (TARS #278 review,
// 14 Oct, finding 2).
//
// Before: an event for an organization on hold was answered 503 with a log
// line, and once the provider stopped retrying it was gone. Now: stored
// first, applied unless the organization is on hold, outcome recorded,
// reconcilable by the operator. No provider is contacted; no money moves.
//
// Synthetic fixtures on the local database only.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import request from 'supertest'
import crypto from 'node:crypto'
import 'dotenv/config'
import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'
import { holdOrganization } from '../src/auth/organizationHold.js'

let server
const orgIds = []
let sequence = 1, seq = 0
const WH = `whsec_s6_${RUN_ID}`
const auth = t => ({ Authorization: `Bearer ${t}` })
const ENV_KEYS = ['PAYMENTS_PROVIDER', 'PAYMENTS_PROVIDER_SECRET', 'BILLING_PROVIDER_SECRET', 'BILLING_WEBHOOK_SECRET', 'SUPER_ADMIN_EMAIL', 'SUPER_ADMIN_USER_IDS']
const savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))

beforeAll(async () => {
  await migrateOnce(); server = await bindServer()
  for (const k of ENV_KEYS) delete process.env[k]
  process.env.BILLING_WEBHOOK_SECRET = WH
}, 60000)
afterAll(async () => {
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k] }
  for (const id of orgIds) await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
  await closeServer(server); await pool.end()
})
afterEach(() => { vi.restoreAllMocks() })

async function parish(tag) {
  const name = `BillRcpt ${tag} ${RUN_ID}`
  const email = `billrcpt_${tag}_${RUN_ID}@example.com`
  const res = await createOrg(server, { organizationName: name, name: 'Synthetic Admin', email, password: 'billrcpt-test-pw' }, `10.98.${sequence++}.1`)
  expect(res.status).toBe(201)
  const org = { id: res.body.user.organization.id, name, email, userId: res.body.user.id, token: res.body.token }
  orgIds.push(org.id)
  const fund = await request(server).post('/api/funds').set(auth(org.token)).send({ name: `General ${tag} ${RUN_ID}` })
  expect(fund.status).toBe(201)
  org.fund = fund.body
  return org
}
const hold = org => holdOrganization({ organizationId: org.id, actorId: org.userId, confirm: org.name, acknowledgeExportWarning: true })

function donationEvent(org, tag) {
  const suffix = `${tag}_${RUN_ID}_${seq++}`
  const object = {
    id: `cs_s6_${suffix}`, object: 'checkout.session', mode: 'payment', status: 'complete', payment_status: 'paid',
    payment_intent: `pi_s6_${suffix}`, amount_total: 2500, currency: 'usd',
    metadata: { kind: 'donation', organization_id: String(org.id), fund_id: String(org.fund.id), fund: org.fund.name, donor_name: 'Synthetic Donor' },
  }
  return { eventId: `evt_s6_${suffix}`, pi: object.payment_intent, body: JSON.stringify({ id: `evt_s6_${suffix}`, type: 'checkout.session.completed', data: { object } }) }
}
const sign = (body, secret = WH, t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`
const post = (body, sig = sign(body)) => {
  const r = request(server).post('/api/billing/webhook').set('Content-Type', 'application/json')
  if (sig) r.set('stripe-signature', sig)
  return r.send(body)
}
const receipt = eventId => pool.query(
  `SELECT id::int AS id, status, attempts, organization_id, event_type, last_error FROM ochr_billing_event_receipts WHERE provider = 'stripe' AND event_id = $1`, [eventId]).then(r => r.rows)
const gifts = pi => pool.query('SELECT id, organization_id FROM ochr_donations WHERE payment_ref = $1', [pi]).then(r => r.rows)

describe('stored before acknowledged, applied once', () => {
  it('a verified event is stored and applied; a redelivery is acknowledged without applying again', async () => {
    const org = await parish('dup')
    const ev = donationEvent(org, 'dup')
    const first = await post(ev.body)
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({ received: true, handled: 'donation' })
    const again = await post(ev.body)
    expect(again.status).toBe(200)
    expect(again.body).toMatchObject({ received: true, duplicate: true })
    expect(await gifts(ev.pi)).toHaveLength(1)
    expect(await receipt(ev.eventId)).toEqual([expect.objectContaining({ status: 'applied', attempts: 1, organization_id: org.id, event_type: 'checkout.session.completed' })])
  })

  it('concurrent duplicate deliveries: one receipt, one gift; a delivery that finds it in flight is asked to come back', async () => {
    const org = await parish('concurrent')
    const ev = donationEvent(org, 'conc')
    const results = await Promise.all([post(ev.body), post(ev.body), post(ev.body)])
    for (const r of results) {
      if (r.status === 200) expect(r.body.received).toBe(true)
      else expect({ status: r.status, body: r.body }).toEqual({ status: 503, body: { received: false, stored: true, in_progress: true } })
    }
    expect(results.some(r => r.status === 200 && !r.body.duplicate)).toBe(true)
    expect(await gifts(ev.pi)).toHaveLength(1)
    expect(await receipt(ev.eventId)).toEqual([expect.objectContaining({ status: 'applied', attempts: 1 })])
    const later = await post(ev.body)
    expect(later.status).toBe(200)
    expect(later.body.duplicate).toBe(true)
  })

  it('billing not switched on: a verified subscription event is stored as deferred, not applied, and stays open', async () => {
    const org = await parish('deferred')
    const body = JSON.stringify({ id: `evt_s6_sub_${RUN_ID}_${seq++}`, type: 'checkout.session.completed', data: { object: {
      id: `cs_s6_sub_${RUN_ID}`, mode: 'subscription', customer: 'cus_synthetic', subscription: 'sub_synthetic',
      metadata: { organization_id: String(org.id), plan: 'pro' } } } })
    const res = await post(body)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ received: true, stub: true })
    const [r] = await receipt(JSON.parse(body).id)
    expect(r).toMatchObject({ status: 'deferred', organization_id: org.id })
    expect((await pool.query('SELECT plan FROM ochr_organizations WHERE id = $1', [org.id])).rows[0].plan).not.toBe('pro')
  })

  it('an invalid signature is refused and nothing is stored', async () => {
    const org = await parish('badsig')
    const ev = donationEvent(org, 'badsig')
    expect((await post(ev.body, sign(ev.body, 'whsec_wrong'))).status).toBe(400)
    expect((await post(ev.body, null)).status).toBe(400)
    expect((await post(ev.body.replace('2500', '250000'), sign(ev.body))).status).toBe(400)
    expect(await receipt(ev.eventId)).toEqual([])
    expect(await gifts(ev.pi)).toEqual([])
  })
})

describe('organization on hold', () => {
  it('stored and acknowledged, not applied; redelivery keeps it held; the parish stays held', async () => {
    const org = await parish('held')
    const ev = donationEvent(org, 'held')
    expect((await hold(org)).status).toBe(200)
    const res = await post(ev.body)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ received: true, stored: true, applied: false, reason: 'organization_on_hold' })
    expect(await gifts(ev.pi)).toEqual([])
    expect(await receipt(ev.eventId)).toEqual([expect.objectContaining({ status: 'held', attempts: 1, organization_id: org.id })])
    expect((await post(ev.body)).status).toBe(200)
    expect(await receipt(ev.eventId)).toEqual([expect.objectContaining({ status: 'held', attempts: 2 })])
    expect(await gifts(ev.pi)).toEqual([])
    expect((await pool.query('SELECT held_at FROM ochr_organizations WHERE id = $1', [org.id])).rows[0].held_at).not.toBeNull()
  })

  it('a HOLD placed while an event is being applied waits for it; the gift is recorded once and the receipt applied', async () => {
    const org = await parish('race')
    const ev = donationEvent(org, 'race')
    // Barrier on the fund row: the gift INSERT has taken the organization
    // admission lock and then waits on its fund foreign-key check.
    const barrier = await pool.connect()
    let delivery, holding
    try {
      await barrier.query('BEGIN')
      await barrier.query('SELECT 1 FROM ochr_funds WHERE id = $1 FOR UPDATE', [org.fund.id])
      delivery = post(ev.body).then(r => r)
      for (let i = 0; i < 200; i++) {
        const { rows } = await pool.query(`SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%INSERT INTO ochr_donations%'`)
        if (rows.length) break
        await new Promise(r => setTimeout(r, 15))
      }
      holding = hold(org)
      await new Promise(r => setTimeout(r, 200))
      expect((await pool.query('SELECT held_at FROM ochr_organizations WHERE id = $1', [org.id])).rows[0].held_at).toBeNull()
      await barrier.query('COMMIT')
      expect((await delivery).status).toBe(200)
      expect((await holding).status).toBe(200)
    } finally {
      await barrier.query('ROLLBACK').catch(() => {}); barrier.release()
      await delivery?.catch(() => {}); await holding?.catch(() => {})
    }
    expect(await gifts(ev.pi)).toHaveLength(1)
    expect(await receipt(ev.eventId)).toEqual([expect.objectContaining({ status: 'applied' })])
  })
})

describe('failures', () => {
  it('storage failure: not acknowledged, nothing applied; the redelivery stores and applies', async () => {
    const org = await parish('storefail')
    const ev = donationEvent(org, 'storefail')
    const query = pool.query.bind(pool)
    const spy = vi.spyOn(pool, 'query').mockImplementation((sql, ...rest) =>
      typeof sql === 'string' && sql.includes('INSERT INTO ochr_billing_event_receipts')
        ? Promise.reject(new Error('synthetic storage failure'))
        : query(sql, ...rest))
    const res = await post(ev.body)
    spy.mockRestore()
    expect(res.status).toBe(500)
    expect(res.body.received).toBe(false)
    expect(await receipt(ev.eventId)).toEqual([])
    expect(await gifts(ev.pi)).toEqual([])
    const retry = await post(ev.body)
    expect(retry.status).toBe(200)
    expect(await gifts(ev.pi)).toHaveLength(1)
    expect(await receipt(ev.eventId)).toEqual([expect.objectContaining({ status: 'applied', attempts: 1 })])
  })

  it('apply failure: stored as failed and answered 5xx; the operator reconciles it; payload never listed', async () => {
    const org = await parish('applyfail')
    const operator = await parish('operator')
    const other = await parish('notoperator')
    const ev = donationEvent(org, 'applyfail')
    const query = pool.query.bind(pool)
    vi.spyOn(pool, 'query').mockImplementation((sql, ...rest) =>
      typeof sql === 'string' && sql.includes('INSERT INTO ochr_donations') && rest[0]?.includes?.(ev.pi)
        ? Promise.reject(new Error('synthetic apply failure'))
        : query(sql, ...rest))
    const res = await post(ev.body)
    vi.restoreAllMocks()
    expect(res.status).toBe(500)
    expect(res.body).toMatchObject({ received: false, stored: true })
    const [stored] = await receipt(ev.eventId)
    expect(stored).toMatchObject({ status: 'failed', attempts: 1, last_error: 'synthetic apply failure' })
    expect(await gifts(ev.pi)).toEqual([])

    process.env.SUPER_ADMIN_USER_IDS = String(operator.userId) // F-01: by id only
    try {
      expect((await request(server).get('/api/admin/maintenance/billing-events').set(auth(other.token))).status).not.toBe(200)
      const list = await request(server).get('/api/admin/maintenance/billing-events?status=failed').set(auth(operator.token))
      expect(list.status).toBe(200)
      const row = list.body.events.find(e => Number(e.id) === stored.id)
      expect(row).toMatchObject({ event_id: ev.eventId, status: 'failed', organization_id: org.id })
      expect(row).not.toHaveProperty('payload')
      expect((await request(server).get('/api/admin/maintenance/billing-events?status=nope').set(auth(operator.token))).status).toBe(400)

      const fixed = await request(server).post(`/api/admin/maintenance/billing-events/${stored.id}/reprocess`).set(auth(operator.token))
      expect(fixed.status).toBe(200)
      expect(fixed.body).toEqual({ id: stored.id, status: 'applied' })
      expect(await gifts(ev.pi)).toHaveLength(1)
      const again = await request(server).post(`/api/admin/maintenance/billing-events/${stored.id}/reprocess`).set(auth(operator.token))
      expect(again.body).toEqual({ id: stored.id, status: 'applied', already_applied: true })
      expect(await gifts(ev.pi)).toHaveLength(1)
      expect((await request(server).post('/api/admin/maintenance/billing-events/999999999/reprocess').set(auth(operator.token))).status).toBe(404)

      // A held organization's event stays held on reprocess.
      const heldOrg = await parish('reconheld')
      const hev = donationEvent(heldOrg, 'reconheld')
      expect((await hold(heldOrg)).status).toBe(200)
      expect((await post(hev.body)).status).toBe(200)
      const [h] = await receipt(hev.eventId)
      const heldList = await request(server).get('/api/admin/maintenance/billing-events?status=held').set(auth(operator.token))
      expect(heldList.body.events.map(e => Number(e.id))).toContain(h.id)
      const re = await request(server).post(`/api/admin/maintenance/billing-events/${h.id}/reprocess`).set(auth(operator.token))
      expect(re.body).toMatchObject({ id: h.id, status: 'held' })
      expect(await gifts(hev.pi)).toEqual([])
    } finally { delete process.env.SUPER_ADMIN_USER_IDS }
  })
})
