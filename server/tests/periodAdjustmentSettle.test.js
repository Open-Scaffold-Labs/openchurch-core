// GIV-08 M4 — SETTLED is the chancery decision; APPLIED is the durable
// economic effect. The bill is approved frozen gross minus APPLIED
// credits. totals_json, the gift, and the refund fact are not rewritten.
//
// Stamp-only UPDATE of resolved_at cannot clear OPEN while pretending
// money moved: the deferred trigger refuses the COMMIT, and computeBases
// subtracts credits, not resolved_at.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'
import { computeBases } from '../src/finance/assessmentBases.js'

let server
const cleanupOrgIds = []

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

let ipSeq = 0
const auth = t => ({ Authorization: `Bearer ${t}` })

async function signup(payload) {
  const res = await createOrg(server, payload, `10.64.8.${++ipSeq}`)
  expect(res.status).toBe(201)
  const org = res.body.user?.organization ?? res.body.organization
  cleanupOrgIds.push(org.id)
  let token = res.body.token
  if (!token) {
    const login = await request(server).post('/api/auth/login')
      .set('X-Forwarded-For', `10.64.8.${++ipSeq}`)
      .send({ email: payload.email, password: payload.password })
    token = login.body.token
  }
  return { token, orgId: org.id }
}

async function affiliatedPair(tag) {
  const email = `pas_${tag}_par_${RUN_ID}@example.com`
  const dio = await signup({
    organizationName: `PAS ${tag} Diocese ${RUN_ID}`, name: 'Canon',
    email: `pas_${tag}_dio_${RUN_ID}@example.com`, password: 'pas-pw-dio-1',
    organizationType: 'diocese',
  })
  const par = await signup({
    organizationName: `PAS ${tag} Parish ${RUN_ID}`, name: 'Parish Admin',
    email, password: 'pas-pw-par-1',
  })
  const inv = await request(server).post('/api/diocese/parishes/invite').set(auth(dio.token)).send({ email })
  expect(inv.status).toBeLessThan(300)
  const acc = await request(server).post('/api/affiliation/accept').set(auth(par.token)).send({ grant_level: 'detail' })
  expect(acc.status).toBe(200)
  return { dio, par }
}

async function chargedGift(par, amount, date) {
  const res = await request(server).post('/api/donations').set(auth(par.token))
    .send({ donor_name: 'Frozen Donor', amount, date, category: 'General', method: 'cash' })
  expect(res.status).toBe(201)
  const id = res.body.id
  await pool.query(
    `UPDATE ochr_donations SET source='online', payment_ref=$1, payment_status='succeeded' WHERE id=$2`,
    [`pi_pas_${RUN_ID}_${id}`, id])
  return id
}

async function approvedPeriod(dio, par, start, end) {
  const sub = await request(server).post('/api/finance/submissions').set(auth(par.token))
    .send({ period_start: start, period_end: end })
  expect(sub.status).toBe(201)
  const list = await request(server).get('/api/diocese/submissions').set(auth(dio.token))
  const row = list.body.submissions.find(s => Number(s.id) === Number(sub.body.submission?.id ?? sub.body.id))
  const appr = await request(server).patch(`/api/diocese/submissions/${row.id}`).set(auth(dio.token))
    .send({ status: 'approved', expected_submitted_at: row.submitted_at })
  expect(appr.status).toBe(200)
  return Number(row.id)
}

async function refundInPeriod(par, gift, amount) {
  const res = await request(server).post(`/api/donations/${gift}/refund`)
    .set(auth(par.token)).send({ amount })
  expect(res.status).toBe(200)
  expect(res.body.period_adjustment).toBeTruthy()
  return res
}

const openOf = id => pool.query(
  `SELECT count(*)::int AS n, COALESCE(sum(amount), 0)::text AS total
     FROM ochr_period_adjustments WHERE submission_id = $1 AND resolved_at IS NULL`, [id]
).then(r => r.rows[0])

const creditsOf = id => pool.query(
  `SELECT id, adjustment_id, donation_refund_id, amount::text AS amount
     FROM ochr_period_adjustment_credits WHERE submission_id = $1 ORDER BY id`, [id]
).then(r => r.rows)

const giftFact = id => pool.query(
  `SELECT amount::text AS amount, payment_status FROM ochr_donations WHERE id = $1`, [id]
).then(r => r.rows[0])

const refundFacts = id => pool.query(
  `SELECT id, amount::text AS amount, status FROM ochr_donation_refunds WHERE donation_id = $1 ORDER BY id`, [id]
).then(r => r.rows)

const frozen = id => pool.query(
  `SELECT totals_json, status FROM ochr_report_submissions WHERE id = $1`, [id]
).then(r => r.rows[0])

async function payableBase(dio, year) {
  const rows = await computeBases(dio.orgId, String(year))
  return rows.reduce((s, r) => s + Number(r.base), 0)
}

describe('GIV-08 M4 settlement lifecycle', () => {
  it('records APPLIED + SETTLED together; gift, refund fact, and totals_json stay put', async () => {
    const { dio, par } = await affiliatedPair('happy')
    const gift = await chargedGift(par, 200.00, '2071-03-03')
    const subId = await approvedPeriod(dio, par, '2071-01-01', '2071-12-31')
    const before = await frozen(subId)
    const giftBefore = await giftFact(gift)
    const refund = await refundInPeriod(par, gift, 50)
    const refundId = refund.body.refund.id
    expect((await openOf(subId)).n).toBe(1)
    expect(await payableBase(dio, 2071)).toBeCloseTo(Number(before.totals_json?.totals?.assessable_base), 2)

    const { rows: adj } = await pool.query(
      `SELECT id FROM ochr_period_adjustments WHERE submission_id = $1 AND resolved_at IS NULL`, [subId])
    const settle = await request(server).post(`/api/diocese/adjustments/${adj[0].id}/settle`)
      .set(auth(dio.token)).send({ note: 'Credit the refunded gift against the bill.' })
    expect(settle.status).toBe(200)
    expect(settle.body.already_recorded).toBe(false)
    expect(Number(settle.body.credit.amount)).toBeCloseTo(50, 2)
    expect(Number(settle.body.credit.donation_refund_id)).toBe(Number(refundId))
    expect(settle.body.adjustment.resolved_at).toBeTruthy()

    expect((await openOf(subId)).n).toBe(0)
    expect(await creditsOf(subId)).toHaveLength(1)
    expect(await payableBase(dio, 2071)).toBeCloseTo(
      Number(before.totals_json?.totals?.assessable_base) - 50, 2)

    const after = await frozen(subId)
    expect(after.totals_json).toEqual(before.totals_json)
    expect(after.status).toBe('approved')
    expect(await giftFact(gift)).toEqual(giftBefore)
    const facts = await refundFacts(gift)
    expect(facts).toHaveLength(1)
    expect(Number(facts[0].id)).toBe(Number(refundId))
    expect(Number(facts[0].amount)).toBeCloseTo(50, 2)

    const list = await request(server).get('/api/diocese/submissions').set(auth(dio.token))
    const row = list.body.submissions.find(s => Number(s.id) === subId)
    expect(Number(row.open_adjustment_count)).toBe(0)
    expect(Number(row.applied_credit_count)).toBe(1)
    expect(Number(row.applied_credit_amount)).toBeCloseTo(50, 2)
    expect(Number(row.payable_base)).toBeCloseTo(Number(row.totals.assessable_base) - 50, 2)
    expect(Number(row.totals.assessable_base)).toBeCloseTo(Number(before.totals_json?.totals?.assessable_base), 2)
  })

  it('duplicate settle is safe and does not double-apply', async () => {
    const { dio, par } = await affiliatedPair('idemp')
    const gift = await chargedGift(par, 80.00, '2072-04-04')
    const subId = await approvedPeriod(dio, par, '2072-01-01', '2072-12-31')
    await refundInPeriod(par, gift, 20)
    const { rows: adj } = await pool.query(
      `SELECT id FROM ochr_period_adjustments WHERE submission_id = $1`, [subId])

    const first = await request(server).post(`/api/diocese/adjustments/${adj[0].id}/settle`)
      .set(auth(dio.token)).send({})
    expect(first.status).toBe(200)
    const second = await request(server).post(`/api/diocese/adjustments/${adj[0].id}/settle`)
      .set(auth(dio.token)).send({})
    expect(second.status).toBe(200)
    expect(second.body.already_recorded).toBe(true)
    expect(Number(second.body.credit.id)).toBe(Number(first.body.credit.id))
    expect(await creditsOf(subId)).toHaveLength(1)

    const batch = await request(server).post(`/api/diocese/submissions/${subId}/adjustments/settle`)
      .set(auth(dio.token)).send({})
    expect(batch.status).toBe(200)
    expect(batch.body.already_recorded).toBe(true)
    expect(await creditsOf(subId)).toHaveLength(1)
  })

  it('stamp-only cannot clear OPEN while pretending money moved', async () => {
    const { dio, par } = await affiliatedPair('stamp')
    const gift = await chargedGift(par, 120.00, '2073-05-05')
    const subId = await approvedPeriod(dio, par, '2073-01-01', '2073-12-31')
    const before = await frozen(subId)
    await refundInPeriod(par, gift, 30)
    const { rows: adj } = await pool.query(
      `SELECT id, organization_id FROM ochr_period_adjustments WHERE submission_id = $1`, [subId])

    await expect(pool.query(
      `UPDATE ochr_period_adjustments SET resolved_at = NOW() WHERE id = $1`, [adj[0].id]
    )).rejects.toMatchObject({ code: '23514' })

    expect((await openOf(subId)).n).toBe(1)
    expect(await creditsOf(subId)).toHaveLength(0)
    expect(await payableBase(dio, 2073)).toBeCloseTo(Number(before.totals_json?.totals?.assessable_base), 2)
    expect((await frozen(subId)).totals_json).toEqual(before.totals_json)

    const assertMutationApplied = async () => {
      const { rows } = await pool.query(
        `SELECT tgenabled FROM pg_trigger
          WHERE tgname = 'ochr_period_adjustments_settled_requires_applied'
            AND NOT tgisinternal`)
      expect(rows[0]?.tgenabled, 'stamp-only mutation was not applied').toBe('D')
    }

    try {
      await pool.query(
        `ALTER TABLE ochr_period_adjustments
           DISABLE TRIGGER ochr_period_adjustments_settled_requires_applied`)
      await assertMutationApplied()
      await pool.query(
        `UPDATE ochr_period_adjustments SET resolved_at = NOW() WHERE id = $1`, [adj[0].id])
      expect((await openOf(subId)).n).toBe(0)
      expect(await creditsOf(subId)).toHaveLength(0)
      // The bill still uses APPLIED, not the SETTLED stamp — so money
      // did not move. A reader that treated resolved_at as the bill
      // signal would now be lying.
      expect(await payableBase(dio, 2073)).toBeCloseTo(Number(before.totals_json?.totals?.assessable_base), 2)
    } finally {
      await pool.query(
        `UPDATE ochr_period_adjustments SET resolved_at = NULL
          WHERE id = $1 AND organization_id = $2`, [adj[0].id, adj[0].organization_id])
      await pool.query(
        `ALTER TABLE ochr_period_adjustments
           ENABLE TRIGGER ochr_period_adjustments_settled_requires_applied`)
    }

    expect((await openOf(subId)).n).toBe(1)
    const settle = await request(server).post(`/api/diocese/adjustments/${adj[0].id}/settle`)
      .set(auth(dio.token)).send({})
    expect(settle.status).toBe(200)
    expect(await creditsOf(subId)).toHaveLength(1)
    expect(await payableBase(dio, 2073)).toBeCloseTo(
      Number(before.totals_json?.totals?.assessable_base) - 30, 2)
  })

  it('another diocese cannot settle this parish\'s adjustment; a parish token is 403', async () => {
    const { dio, par } = await affiliatedPair('iso')
    const other = await affiliatedPair('iso2')
    const gift = await chargedGift(par, 60.00, '2074-06-06')
    const subId = await approvedPeriod(dio, par, '2074-01-01', '2074-12-31')
    await refundInPeriod(par, gift, 15)
    const { rows: adj } = await pool.query(
      `SELECT id FROM ochr_period_adjustments WHERE submission_id = $1`, [subId])

    const asParish = await request(server).post(`/api/diocese/adjustments/${adj[0].id}/settle`)
      .set(auth(par.token)).send({})
    expect(asParish.status).toBe(403)

    const asOther = await request(server).post(`/api/diocese/adjustments/${adj[0].id}/settle`)
      .set(auth(other.dio.token)).send({})
    expect(asOther.status).toBe(404)
    expect((await openOf(subId)).n).toBe(1)
    expect(await creditsOf(subId)).toHaveLength(0)

    const steal = await pool.query(
      `INSERT INTO ochr_period_adjustment_credits
         (organization_id, diocese_org_id, adjustment_id, submission_id,
          donation_id, donation_refund_id, amount)
       SELECT $1, $2, a.id, a.submission_id, a.donation_id, a.donation_refund_id, a.amount
         FROM ochr_period_adjustments a WHERE a.id = $3
       RETURNING id`,
      [other.par.orgId, other.dio.orgId, adj[0].id]
    ).catch(err => err)
    expect(steal.code).toBe('23503')
  })

  it('resubmit DELETE of OPEN is invalidation, not settlement', async () => {
    const { dio, par } = await affiliatedPair('resub')
    const gift = await chargedGift(par, 90.00, '2075-07-07')
    await request(server).post('/api/finance/submissions').set(auth(par.token))
      .send({ period_start: '2075-01-01', period_end: '2075-12-31' })
    const list = await request(server).get('/api/diocese/submissions').set(auth(dio.token))
    const row = list.body.submissions.find(s => s.period_start === '2075-01-01')
    const subId = Number(row.id)
    await request(server).patch(`/api/diocese/submissions/${subId}`).set(auth(dio.token))
      .send({ status: 'returned', note: 'Please review the figures.', expected_submitted_at: row.submitted_at })

    // Refund while returned does not create OPEN (totals are not frozen).
    // Freeze again, refund, then return-and-resubmit to DELETE the OPEN.
    const again = await request(server).post('/api/finance/submissions').set(auth(par.token))
      .send({ period_start: '2075-01-01', period_end: '2075-12-31' })
    expect(again.status).toBe(201)
    await refundInPeriod(par, gift, 25)
    expect((await openOf(subId)).n).toBe(1)

    const list2 = await request(server).get('/api/diocese/submissions').set(auth(dio.token))
    const row2 = list2.body.submissions.find(s => Number(s.id) === subId)
    await request(server).patch(`/api/diocese/submissions/${subId}`).set(auth(dio.token))
      .send({ status: 'returned', note: 'One more look.', expected_submitted_at: row2.submitted_at })
    const resub = await request(server).post('/api/finance/submissions').set(auth(par.token))
      .send({ period_start: '2075-01-01', period_end: '2075-12-31' })
    expect(resub.status).toBe(201)
    expect((await openOf(subId)).n).toBe(0)
    expect(await creditsOf(subId)).toHaveLength(0)
    const { rows: settled } = await pool.query(
      `SELECT count(*)::int AS n FROM ochr_period_adjustments
        WHERE submission_id = $1 AND resolved_at IS NOT NULL`, [subId])
    expect(settled[0].n).toBe(0)
  })

  it('a draft assessment uses payable net after a credit is recorded', async () => {
    const { dio, par } = await affiliatedPair('bill')
    const gift = await chargedGift(par, 400.00, '2076-08-08')
    const subId = await approvedPeriod(dio, par, '2076-01-01', '2076-12-31')
    const before = await frozen(subId)
    const gross = Number(before.totals_json?.totals?.assessable_base)
    await refundInPeriod(par, gift, 40)

    const draftOpen = await request(server).post('/api/diocese/assessments')
      .set(auth(dio.token)).send({ fiscal_year: '2076', rate_bps: 800 })
    expect(draftOpen.status).toBe(201)
    expect(draftOpen.body.payable_rule).toBe('approved_frozen_gross_minus_applied_credits')
    const lineOpen = draftOpen.body.lines.find(l => l.parish_org_id === par.orgId)
    expect(Number(lineOpen.base)).toBeCloseTo(gross, 2)

    const { rows: adj } = await pool.query(
      `SELECT id FROM ochr_period_adjustments WHERE submission_id = $1`, [subId])
    expect((await request(server).post(`/api/diocese/adjustments/${adj[0].id}/settle`)
      .set(auth(dio.token)).send({})).status).toBe(200)

    const recompute = await request(server).post(`/api/diocese/assessments/${draftOpen.body.id}/recompute`)
      .set(auth(dio.token))
    expect(recompute.status).toBe(200)
    const linePaid = recompute.body.lines.find(l => l.parish_org_id === par.orgId)
    expect(Number(linePaid.base)).toBeCloseTo(gross - 40, 2)
    expect((await frozen(subId)).totals_json).toEqual(before.totals_json)
  })
})
