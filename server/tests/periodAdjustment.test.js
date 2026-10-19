// A refund that lands inside a FROZEN period — submitted or approved; the
// totals are frozen at submit and approval copies nothing (8 Sep).
//
// THE CONTRADICTION. Live books now net posted refunds (GIV-06 Option A).
// A submission's totals_json does not — it is frozen at submit time, and
// computeBases() sums it for status='approved'. So a gift given in-period,
// approved, then refunded leaves the parish's live giving truth at $0 while the
// diocesan roll-up and the bill derived from it still counted the money, and
// the sidecar is what says so.
//
// FOUNDER SEMANTIC FOR 1.0, and the whole of what these tests pin:
//   the refund is NOT blocked because the period is frozen;
//   the frozen period is NOT reopened, recomputed, or rewritten;
//   the fact that it now carries an unresolved financial adjustment IS
//   recorded, and IS visible to both the parish and the chancery.
//
// It deliberately does not settle the adjustment. Six candidate settlement
// models are written up in the open findings register and the choice belongs
// to the founder and the chancery; recording the fact commits to none of them
// and is a precondition for all six.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'
import { backfillAdjustmentRefundIds } from '../src/migrations/105-period-adjustment-per-refund.js'
import { refundIdempotencyKey } from '../src/finance/donationRefunds.js'

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
  const res = await createOrg(server, payload, `10.63.9.${++ipSeq}`)
  expect(res.status).toBe(201)
  const org = res.body.user?.organization ?? res.body.organization
  cleanupOrgIds.push(org.id)
  let token = res.body.token
  if (!token) {
    const login = await request(server).post('/api/auth/login')
      .set('X-Forwarded-For', `10.63.9.${++ipSeq}`)
      .send({ email: payload.email, password: payload.password })
    token = login.body.token
  }
  return { token, orgId: org.id }
}

async function affiliatedPair(tag) {
  const email = `pa_${tag}_par_${RUN_ID}@example.com`
  const dio = await signup({ organizationName: `PA ${tag} Diocese ${RUN_ID}`, name: 'Canon',
    email: `pa_${tag}_dio_${RUN_ID}@example.com`, password: 'pa-pw-dio-1', organizationType: 'diocese' })
  const par = await signup({ organizationName: `PA ${tag} Parish ${RUN_ID}`, name: 'Parish Admin',
    email, password: 'pa-pw-par-1' })
  const inv = await request(server).post('/api/diocese/parishes/invite').set(auth(dio.token)).send({ email })
  expect(inv.status).toBeLessThan(300)
  const acc = await request(server).post('/api/affiliation/accept').set(auth(par.token)).send({ grant_level: 'detail' })
  expect(acc.status).toBe(200)
  return { dio, par }
}

/** A gift that looks like it was charged through the provider, so it can be refunded. */
async function chargedGift(par, amount, date, donorName = 'Frozen Donor') {
  const res = await request(server).post('/api/donations').set(auth(par.token))
    .send({ donor_name: donorName, amount, date, category: 'General', method: 'cash' })
  expect(res.status).toBe(201)
  const id = res.body.id
  await pool.query(
    `UPDATE ochr_donations SET source='online', payment_ref=$1, payment_status='succeeded' WHERE id=$2`,
    [`pi_pa_${RUN_ID}_${id}`, id])
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

/** Freeze the period; returns the submission id (a returned period resubmits in place). */
async function submitPeriod(par, start, end) {
  const sub = await request(server).post('/api/finance/submissions').set(auth(par.token))
    .send({ period_start: start, period_end: end })
  expect(sub.status).toBe(201)
  return Number(sub.body.submission?.id ?? sub.body.id)
}

/** The chancery's review, sent the way the client sends it (with the row's submitted_at). */
async function review(dio, subId, status, note) {
  const list = await request(server).get('/api/diocese/submissions').set(auth(dio.token))
  const row = list.body.submissions.find(s => Number(s.id) === subId)
  const r = await request(server).patch(`/api/diocese/submissions/${subId}`).set(auth(dio.token))
    .send({ status, note, expected_submitted_at: row.submitted_at })
  expect(r.status).toBe(200)
  return r.body
}

const openAdjustments = id => pool.query(
  `SELECT count(*)::int AS n, COALESCE(sum(amount), 0)::text AS total
     FROM ochr_period_adjustments WHERE submission_id = $1 AND resolved_at IS NULL`, [id]
).then(r => r.rows[0])

describe('a refund inside an approved period', () => {
  it('is not blocked, does not rewrite the frozen period, and is recorded against it', async () => {
    const { dio, par } = await affiliatedPair('a1')
    const gift = await chargedGift(par, 400.00, '2031-06-15')
    const subId = await approvedPeriod(dio, par, '2031-01-01', '2031-12-31')

    const before = await pool.query(
      `SELECT totals_json, status FROM ochr_report_submissions WHERE id = $1`, [subId])

    const refund = await request(server).post(`/api/donations/${gift}/refund`).set(auth(par.token)).send({})
    // A real refund must not be refused because a period is frozen.
    expect(refund.status).toBe(200)

    const after = await pool.query(
      `SELECT totals_json, status FROM ochr_report_submissions WHERE id = $1`, [subId])
    // Frozen history stays history.
    expect(after.rows[0].totals_json).toEqual(before.rows[0].totals_json)
    expect(after.rows[0].status).toBe('approved')

    const adj = await openAdjustments(subId)
    expect(adj.n).toBe(1)
    expect(Number(adj.total)).toBeCloseTo(400.00, 2)
  })

  it('tells the person who pressed Refund, rather than letting a bill do it', async () => {
    const { dio, par } = await affiliatedPair('a2')
    const gift = await chargedGift(par, 125.00, '2032-04-04')
    await approvedPeriod(dio, par, '2032-01-01', '2032-12-31')

    const refund = await request(server).post(`/api/donations/${gift}/refund`).set(auth(par.token)).send({})
    expect(refund.status).toBe(200)
    expect(refund.body.period_adjustment).toBeTruthy()
    expect(Number(refund.body.period_adjustment.amount)).toBeCloseTo(125.00, 2)
    // It must not imply the approved totals now reflect the refund.
    expect(refund.body.period_adjustment.message).toMatch(/still include it|not changed/i)
  })

  it('is visible to the parish and to the chancery on the submission they each read', async () => {
    const { dio, par } = await affiliatedPair('a3')
    const gift = await chargedGift(par, 220.00, '2033-09-09')
    const subId = await approvedPeriod(dio, par, '2033-01-01', '2033-12-31')
    await request(server).post(`/api/donations/${gift}/refund`).set(auth(par.token)).send({})

    const dioList = await request(server).get('/api/diocese/submissions').set(auth(dio.token))
    const dioRow = dioList.body.submissions.find(s => Number(s.id) === subId)
    expect(Number(dioRow.open_adjustment_count)).toBe(1)
    expect(Number(dioRow.open_adjustment_amount)).toBeCloseTo(220.00, 2)

    const parList = await request(server).get('/api/finance/submissions').set(auth(par.token))
    const parRow = parList.body.submissions.find(s => Number(s.id) === subId)
    expect(Number(parRow.open_adjustment_count)).toBe(1)
    expect(Number(parRow.open_adjustment_amount)).toBeCloseTo(220.00, 2)
  })

  it('records nothing when the gift is not inside any approved period', async () => {
    const { dio, par } = await affiliatedPair('a4')
    await approvedPeriod(dio, par, '2034-01-01', '2034-12-31')
    // dated well outside the approved period
    const loose = await chargedGift(par, 60.00, '2038-02-02')
    const refund = await request(server).post(`/api/donations/${loose}/refund`).set(auth(par.token)).send({})
    expect(refund.status).toBe(200)
    expect(refund.body.period_adjustment).toBeFalsy()
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM ochr_period_adjustments WHERE donation_id = $1`, [loose])
    expect(rows[0].n).toBe(0)
  })

  it('records one adjustment per gift however many times the refund is attempted', async () => {
    const { dio, par } = await affiliatedPair('a5')
    const gift = await chargedGift(par, 90.00, '2036-05-05')
    const subId = await approvedPeriod(dio, par, '2036-01-01', '2036-12-31')

    const first = await request(server).post(`/api/donations/${gift}/refund`).set(auth(par.token)).send({})
    expect(first.status).toBe(200)
    const replay = await request(server).post(`/api/donations/${gift}/refund`).set(auth(par.token)).send({})
    expect(replay.status).toBe(409)

    const adj = await openAdjustments(subId)
    expect(adj.n).toBe(1)
  })

  it('records against a submitted-but-not-yet-approved period too', async () => {
    // INVERTED (8 Sep). This test used to pin "submitted → no adjustment":
    // nothing had been relied on yet, so there was nothing to contradict.
    // That reasoning missed what the totals ARE. They are frozen at submit,
    // not at approval — and the approve step copies nothing, it only flips
    // the status. So a refund while the period sat in the chancery's queue
    // left refunded money in the totals that were then approved, with no
    // adjustment and no signal at approve time (reproduced: frozen 500.00,
    // live 0.00, approved 500.00, open_adjustment_count 0). The invariant
    // is about what the FROZEN totals contain, and a submitted period's
    // totals already contain the gift.
    const { par } = await affiliatedPair('a6')
    const gift = await chargedGift(par, 70.00, '2037-07-07')
    const subId = await submitPeriod(par, '2037-01-01', '2037-12-31')
    expect(await pool.query(`SELECT status FROM ochr_report_submissions WHERE id=$1`, [subId])
      .then(r => r.rows[0].status)).toBe('submitted')

    const refund = await request(server).post(`/api/donations/${gift}/refund`).set(auth(par.token)).send({})
    expect(refund.status).toBe(200)
    expect(refund.body.period_adjustment).toBeTruthy()
    expect(Number(refund.body.period_adjustment.submission_id)).toBe(subId)
    const adj = await openAdjustments(subId)
    expect(adj.n).toBe(1)
    expect(Number(adj.total)).toBeCloseTo(70.00, 2)
  })
})

// THE INVARIANT these pin: an open adjustment exists for a submission iff
// that submission's FROZEN totals include money that has since been
// refunded. Two ways the first cut broke it, both reproduced by audit:
//   - submit → refund → approve carried refunded money into an approved
//     period with no adjustment (the INSERT only looked at 'approved');
//   - a gift CREATED after the freeze but DATED inside the period got an
//     adjustment on refund although the frozen totals never held it, so
//     open_adjustment_amount exceeded the frozen total itself.
describe('the adjustment follows the frozen totals, not the status', () => {
  const frozenRevenue = id => pool.query(
    `SELECT status, totals_json->'totals'->>'revenue' AS revenue FROM ochr_report_submissions WHERE id = $1`, [id]
  ).then(r => r.rows[0])

  it('submit → refund → approve: the approved period carries exactly one open adjustment', async () => {
    const { dio, par } = await affiliatedPair('b1')
    const gift = await chargedGift(par, 500.00, '2051-06-06')
    const subId = await submitPeriod(par, '2051-01-01', '2051-12-31')
    const frozen = await frozenRevenue(subId)
    expect(Number(frozen.revenue)).toBeCloseTo(500.00, 2)

    const refund = await request(server).post(`/api/donations/${gift}/refund`).set(auth(par.token)).send({})
    expect(refund.status).toBe(200)
    expect(refund.body.period_adjustment).toBeTruthy()

    await review(dio, subId, 'approved')

    // The frozen totals still include the gift — approval copied nothing.
    const approved = await frozenRevenue(subId)
    expect(approved.status).toBe('approved')
    expect(approved.revenue).toBe(frozen.revenue)

    // ...and the durable record says so: one row, this gift, this period.
    const { rows } = await pool.query(
      `SELECT submission_id, donation_id, amount::text AS amount, resolved_at
         FROM ochr_period_adjustments WHERE submission_id = $1`, [subId])
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].donation_id)).toBe(gift)
    expect(Number(rows[0].amount)).toBeCloseTo(500.00, 2)
    expect(rows[0].resolved_at).toBeNull()

    const dioList = await request(server).get('/api/diocese/submissions').set(auth(dio.token))
    const dioRow = dioList.body.submissions.find(s => Number(s.id) === subId)
    expect(Number(dioRow.open_adjustment_count)).toBe(1)
    expect(Number(dioRow.open_adjustment_amount)).toBeCloseTo(500.00, 2)
  })

  it('a gift created after the freeze, dated inside the period, gets no adjustment', async () => {
    const { dio, par } = await affiliatedPair('b2')
    // Control: in the snapshot. Refunding it must produce an adjustment.
    const before = await chargedGift(par, 300.00, '2052-03-03')
    const subId = await submitPeriod(par, '2052-01-01', '2052-12-31')
    await review(dio, subId, 'approved')
    const frozen = await frozenRevenue(subId)
    expect(Number(frozen.revenue)).toBeCloseTo(300.00, 2)

    // Phantom: dated inside, but the totals were frozen before it existed.
    const after = await chargedGift(par, 200.00, '2052-04-04')
    const { rows: order } = await pool.query(
      `SELECT d.created_at > s.submitted_at AS after_freeze
         FROM ochr_donations d, ochr_report_submissions s WHERE d.id = $1 AND s.id = $2`, [after, subId])
    expect(order[0].after_freeze).toBe(true)

    const phantom = await request(server).post(`/api/donations/${after}/refund`).set(auth(par.token)).send({})
    expect(phantom.status).toBe(200)
    expect(phantom.body.period_adjustment).toBeFalsy()
    expect(await openAdjustments(subId).then(a => a.n)).toBe(0)

    const real = await request(server).post(`/api/donations/${before}/refund`).set(auth(par.token)).send({})
    expect(real.status).toBe(200)
    expect(real.body.period_adjustment).toBeTruthy()
    const adj = await openAdjustments(subId)
    expect(adj.n).toBe(1)
    // Open adjustments can never exceed what the period froze.
    expect(Number(adj.total)).toBeLessThanOrEqual(Number(frozen.revenue))
  })

  it('a resubmit recomputes without the refund, so the adjustment goes with it', async () => {
    const { dio, par } = await affiliatedPair('b3')
    const gift = await chargedGift(par, 250.00, '2053-05-05')
    const subId = await submitPeriod(par, '2053-01-01', '2053-12-31')

    const refund = await request(server).post(`/api/donations/${gift}/refund`).set(auth(par.token)).send({})
    expect(refund.status).toBe(200)
    expect(await openAdjustments(subId).then(a => a.n)).toBe(1)

    await review(dio, subId, 'returned', 'please resubmit without the refunded gift')
    const again = await submitPeriod(par, '2053-01-01', '2053-12-31')
    // Resubmitted in place: same row, fresh totals.
    expect(again).toBe(subId)

    // The recomputed totals exclude the refunded gift; an adjustment kept
    // here would count the refund twice.
    const { rows: all } = await pool.query(
      `SELECT count(*)::int AS n FROM ochr_period_adjustments WHERE submission_id = $1`, [subId])
    expect(all[0].n).toBe(0)

    await review(dio, subId, 'approved')
    const dioList = await request(server).get('/api/diocese/submissions').set(auth(dio.token))
    const dioRow = dioList.body.submissions.find(s => Number(s.id) === subId)
    expect(Number(dioRow.open_adjustment_count)).toBe(0)

    // Frozen equals live: the approved period and the parish's own summary
    // now say the same number.
    const approved = await frozenRevenue(subId)
    const live = await request(server).get('/api/finance/summary?start=2053-01-01&end=2053-12-31').set(auth(par.token))
    expect(live.status).toBe(200)
    expect(approved.revenue).toBe(live.body.totals.revenue)
    expect(Number(approved.revenue)).toBeCloseTo(0, 2)
  })
})

// GIV-07 — sidecar identity is the refund fact, not (gift, kind).
// F3 first post-approval partial creates a sidecar.
// F4 a second DISTINCT partial creates a SECOND sidecar; both amounts;
//    live net is correct; totals_json is unchanged.
// F5 retry of the SAME refund does not duplicate the adjustment.
// F11 restoring unique-on-kind makes F4 go RED; restoring per-refund
//    unique makes it GREEN again.

async function sidecarRows(subId) {
  const { rows } = await pool.query(
    `SELECT id, donation_id, donation_refund_id, amount::text AS amount, resolved_at
       FROM ochr_period_adjustments
      WHERE submission_id = $1
      ORDER BY id`, [subId])
  return rows
}

describe('GIV-07 period adjustments are per refund fact', () => {
  it('F3: the first post-approval partial refund creates one sidecar row', async () => {
    const { dio, par } = await affiliatedPair('f3')
    const gift = await chargedGift(par, 100.00, '2061-03-03')
    const subId = await approvedPeriod(dio, par, '2061-01-01', '2061-12-31')

    const refund = await request(server).post(`/api/donations/${gift}/refund`)
      .set(auth(par.token)).send({ amount: 30 })
    expect(refund.status).toBe(200)
    expect(refund.body.period_adjustment).toBeTruthy()
    expect(Number(refund.body.period_adjustment.amount)).toBeCloseTo(30.00, 2)

    const rows = await sidecarRows(subId)
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].donation_id)).toBe(gift)
    expect(rows[0].donation_refund_id).toBeTruthy()
    expect(Number(rows[0].amount)).toBeCloseTo(30.00, 2)
    expect(Number(refund.body.refund.id)).toBe(Number(rows[0].donation_refund_id))
  })

  it('F4: a second distinct partial creates a second sidecar; live net moves; totals_json does not', async () => {
    const { dio, par } = await affiliatedPair('f4')
    const gift = await chargedGift(par, 100.00, '2062-04-04')
    const subId = await approvedPeriod(dio, par, '2062-01-01', '2062-12-31')

    const before = await pool.query(
      `SELECT totals_json, status FROM ochr_report_submissions WHERE id = $1`, [subId])
    const frozenRevenue = Number(before.rows[0].totals_json?.totals?.revenue)

    const first = await request(server).post(`/api/donations/${gift}/refund`)
      .set(auth(par.token)).send({ amount: 30 })
    expect(first.status).toBe(200)
    const second = await request(server).post(`/api/donations/${gift}/refund`)
      .set(auth(par.token)).send({ amount: 20 })
    expect(second.status).toBe(200)
    expect(second.body.period_adjustment).toBeTruthy()
    expect(Number(second.body.live_amount)).toBeCloseTo(50.00, 2)

    const after = await pool.query(
      `SELECT totals_json, status FROM ochr_report_submissions WHERE id = $1`, [subId])
    expect(after.rows[0].totals_json).toEqual(before.rows[0].totals_json)
    expect(after.rows[0].status).toBe('approved')
    expect(Number(after.rows[0].totals_json?.totals?.revenue)).toBeCloseTo(frozenRevenue, 2)

    const rows = await sidecarRows(subId)
    expect(rows).toHaveLength(2)
    expect(Number(rows[0].donation_refund_id)).not.toBe(Number(rows[1].donation_refund_id))
    expect(rows.map(r => Number(r.amount)).sort((a, b) => a - b)).toEqual([20, 30])
    expect(rows.every(r => r.resolved_at == null)).toBe(true)

    const adj = await openAdjustments(subId)
    expect(adj.n).toBe(2)
    expect(Number(adj.total)).toBeCloseTo(50.00, 2)

    const dioList = await request(server).get('/api/diocese/submissions').set(auth(dio.token))
    const dioRow = dioList.body.submissions.find(s => Number(s.id) === subId)
    expect(Number(dioRow.open_adjustment_count)).toBe(2)
    expect(Number(dioRow.open_adjustment_amount)).toBeCloseTo(50.00, 2)

    const parList = await request(server).get('/api/finance/submissions').set(auth(par.token))
    const parRow = parList.body.submissions.find(s => Number(s.id) === subId)
    expect(Number(parRow.open_adjustment_count)).toBe(2)
    expect(Number(parRow.open_adjustment_amount)).toBeCloseTo(50.00, 2)

    const live = await request(server)
      .get('/api/finance/summary?start=2062-01-01&end=2062-12-31').set(auth(par.token))
    expect(live.status).toBe(200)
    expect(live.body.basis).toBe('live')
    expect(live.body).not.toHaveProperty('approved')
    expect(Number(live.body.totals.revenue)).toBeCloseTo(50.00, 2)
    expect(Number(live.body.totals.revenue)).not.toBeCloseTo(frozenRevenue, 2)

    const { rows: facts } = await pool.query(
      `SELECT count(*)::int AS n FROM ochr_donation_refunds WHERE donation_id = $1`, [gift])
    expect(facts[0].n).toBe(2)
  })

  it('F5: retrying the SAME refund does not duplicate the adjustment', async () => {
    const { dio, par } = await affiliatedPair('f5')
    const gift = await chargedGift(par, 100.00, '2063-05-05')
    const subId = await approvedPeriod(dio, par, '2063-01-01', '2063-12-31')

    const first = await request(server).post(`/api/donations/${gift}/refund`)
      .set(auth(par.token)).send({ amount: 30 })
    expect(first.status).toBe(200)
    const refundId = first.body.refund.id
    expect(refundId).toBeTruthy()
    expect(await sidecarRows(subId)).toHaveLength(1)

    // The write path's ON CONFLICT DO NOTHING on refund identity.
    const replay = await pool.query(
      `INSERT INTO ochr_period_adjustments
         (organization_id, diocese_org_id, submission_id, donation_id,
          donation_refund_id, kind, amount)
       SELECT s.organization_id, s.diocese_org_id, s.id, d.id, $3, 'refund', 30
         FROM ochr_report_submissions s
         JOIN ochr_donations d
           ON d.id = $1 AND d.organization_id = s.organization_id
        WHERE s.id = $2
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [gift, subId, refundId])
    expect(replay.rows).toHaveLength(0)
    expect(await sidecarRows(subId)).toHaveLength(1)

    // HTTP retry of the same pending fact (already posted → pending) reuses
    // the refund identity; it must not invent a second sidecar or a second
    // refund row.
    await pool.query(
      `UPDATE ochr_donation_refunds SET status = 'pending' WHERE id = $1`, [refundId])
    const retry = await request(server).post(`/api/donations/${gift}/refund`)
      .set(auth(par.token)).send({ amount: 30 })
    expect(retry.status).toBe(200)
    expect(Number(retry.body.refund.id)).toBe(Number(refundId))

    const rows = await sidecarRows(subId)
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].donation_refund_id)).toBe(Number(refundId))
    const { rows: facts } = await pool.query(
      `SELECT count(*)::int AS n FROM ochr_donation_refunds WHERE donation_id = $1`, [gift])
    expect(facts[0].n).toBe(1)
  })

  it('F11 mutation: unique-on-kind drops the second distinct refund; restoring per-refund unique keeps both', async () => {
    const assertMutationApplied = async () => {
      const old = await pool.query(
        `SELECT pg_get_indexdef(i.oid) AS def FROM pg_class i
          WHERE i.relname = 'uq_period_adjustment_once'`)
      const neu = await pool.query(
        `SELECT 1 FROM pg_constraint WHERE conname = 'uq_period_adjustment_per_refund'`)
      expect(old.rows[0]?.def, 'F11 mutation was not applied').toMatch(/donation_id/)
      expect(old.rows[0]?.def).toMatch(/kind/)
      expect(neu.rows).toHaveLength(0)
    }
    const restorePerRefundUnique = async () => {
      await pool.query(`DROP INDEX IF EXISTS uq_period_adjustment_once`)
      await pool.query(`
        DO $$ BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'uq_period_adjustment_per_refund'
          ) THEN
            ALTER TABLE ochr_period_adjustments
              ADD CONSTRAINT uq_period_adjustment_per_refund
              UNIQUE (submission_id, donation_refund_id);
          END IF;
        END $$;
      `)
    }

    const { dio, par } = await affiliatedPair('f11r')
    const gift = await chargedGift(par, 100.00, '2064-06-06')
    const subId = await approvedPeriod(dio, par, '2064-01-01', '2064-12-31')

    try {
      // Earlier tests in this file already persisted two sidecar rows for
      // one gift (F4). The old unique cannot be created over those. Keep
      // one row per (submission, gift, kind) so the mutation can land,
      // then prove F4 goes RED under it.
      await pool.query(`
        DELETE FROM ochr_period_adjustments a
         USING ochr_period_adjustments b
         WHERE a.id > b.id
           AND a.submission_id = b.submission_id
           AND a.donation_id = b.donation_id
           AND a.kind = b.kind
      `)
      await pool.query(
        `ALTER TABLE ochr_period_adjustments DROP CONSTRAINT IF EXISTS uq_period_adjustment_per_refund`)
      await pool.query(
        `CREATE UNIQUE INDEX uq_period_adjustment_once
           ON ochr_period_adjustments (submission_id, donation_id, kind)`)
      await assertMutationApplied()
      expect((await request(server).post(`/api/donations/${gift}/refund`)
        .set(auth(par.token)).send({ amount: 30 })).status).toBe(200)
      expect((await request(server).post(`/api/donations/${gift}/refund`)
        .set(auth(par.token)).send({ amount: 20 })).status).toBe(200)
      const mutated = await sidecarRows(subId)
      // F4 would assert length 2. Under the old unique this is 1 — F4 RED.
      expect(mutated).toHaveLength(1)
      expect(Number(mutated[0].amount)).toBeCloseTo(30.00, 2)
      const { rows: facts } = await pool.query(
        `SELECT count(*)::int AS n FROM ochr_donation_refunds WHERE donation_id = $1`, [gift])
      expect(facts[0].n).toBe(2)
    } finally {
      await restorePerRefundUnique()
    }

    const restored = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'uq_period_adjustment_per_refund'`)
    expect(restored.rows[0]?.def).toMatch(/donation_refund_id/)

    const { dio: d2, par: p2 } = await affiliatedPair('f11g')
    const gift2 = await chargedGift(p2, 100.00, '2065-07-07')
    const sub2 = await approvedPeriod(d2, p2, '2065-01-01', '2065-12-31')
    expect((await request(server).post(`/api/donations/${gift2}/refund`)
      .set(auth(p2.token)).send({ amount: 30 })).status).toBe(200)
    expect((await request(server).post(`/api/donations/${gift2}/refund`)
      .set(auth(p2.token)).send({ amount: 20 })).status).toBe(200)
    const green = await sidecarRows(sub2)
    expect(green).toHaveLength(2)
    expect(Number((await openAdjustments(sub2)).total)).toBeCloseTo(50.00, 2)
  })

  it('backfill maps an unambiguous refund and leaves same-amount twins UNKNOWN', async () => {
    const { dio, par } = await affiliatedPair('bf')
    const gift = await chargedGift(par, 80.00, '2066-08-08')
    const subId = await approvedPeriod(dio, par, '2066-01-01', '2066-12-31')
    const { rows: org } = await pool.query(
      `SELECT organization_id, diocese_org_id FROM ochr_report_submissions WHERE id = $1`, [subId])

    const one = await chargedGift(par, 40.00, '2066-08-09')
    const { rows: r1 } = await pool.query(
      `INSERT INTO ochr_donation_refunds (organization_id, donation_id, amount, status)
       VALUES ($1, $2, 40, 'posted') RETURNING id`, [org[0].organization_id, one])
    const { rows: a1 } = await pool.query(
      `INSERT INTO ochr_period_adjustments
         (organization_id, diocese_org_id, submission_id, donation_id, kind, amount)
       VALUES ($1, $2, $3, $4, 'refund', 40)
       RETURNING id`,
      [org[0].organization_id, org[0].diocese_org_id, subId, one])

    const { rows: twins } = await pool.query(
      `INSERT INTO ochr_donation_refunds (organization_id, donation_id, amount, status)
       VALUES ($1, $2, 15, 'posted'), ($1, $2, 15, 'posted')
       RETURNING id`, [org[0].organization_id, gift])
    expect(twins).toHaveLength(2)
    const { rows: a2 } = await pool.query(
      `INSERT INTO ochr_period_adjustments
         (organization_id, diocese_org_id, submission_id, donation_id, kind, amount)
       VALUES ($1, $2, $3, $4, 'refund', 15)
       RETURNING id`,
      [org[0].organization_id, org[0].diocese_org_id, subId, gift])

    const filled = await backfillAdjustmentRefundIds(pool)
    expect(filled).toBeGreaterThanOrEqual(1)

    const mapped = await pool.query(
      `SELECT donation_refund_id FROM ochr_period_adjustments WHERE id = $1`, [a1[0].id])
    expect(Number(mapped.rows[0].donation_refund_id)).toBe(Number(r1[0].id))

    const unknown = await pool.query(
      `SELECT donation_refund_id FROM ochr_period_adjustments WHERE id = $1`, [a2[0].id])
    expect(unknown.rows[0].donation_refund_id).toBeNull()
  })
})

// GIV-07-002 held evidence (F6 / F9 / F1). Test-only; no product change.

async function refundFacts(giftId) {
  const { rows } = await pool.query(
    `SELECT id, amount::text AS amount, status, refund_ref
       FROM ochr_donation_refunds WHERE donation_id = $1 ORDER BY id`, [giftId])
  return rows
}

async function giftDate(giftId) {
  const { rows } = await pool.query(
    `SELECT to_char(date, 'YYYY-MM-DD') AS date FROM ochr_donations WHERE id = $1`, [giftId])
  return rows[0].date
}

function walkJs(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walkJs(p, out)
    else if (/\.(js|mjs)$/.test(name)) out.push(p)
  }
  return out
}

function stripJsComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

describe('GIV-07-002 held evidence F6 F9 F1', () => {
  it('F6: concurrent distinct $30+$20 after freeze — no over-refund, no silent drop, sidecar per posted fact', async () => {
    // Phase 1 commits a pending row under FOR UPDATE before the provider
    // call. A concurrent DISTINCT amount that still sees that pending
    // row is 409 "already in progress" (one winner). That is supported
    // behaviour, not a silent drop: retry of the other amount must
    // post as its own refund fact + sidecar without duplicating the first.
    // If the first has already posted before the second acquires the
    // lock, both requests can return 200. Either outcome must end at
    // $50 refunded, two facts, two sidecars, frozen totals $100, live $50.
    const { dio, par } = await affiliatedPair('f6')
    const gift = await chargedGift(par, 100.00, '2071-03-03')
    const subId = await approvedPeriod(dio, par, '2071-01-01', '2071-12-31')
    const before = await pool.query(
      `SELECT totals_json, status FROM ochr_report_submissions WHERE id = $1`, [subId])
    const frozenRevenue = Number(before.rows[0].totals_json?.totals?.revenue)
    expect(frozenRevenue).toBeCloseTo(100.00, 2)

    const [a, b] = await Promise.all([
      request(server).post(`/api/donations/${gift}/refund`).set(auth(par.token)).send({ amount: 30 }),
      request(server).post(`/api/donations/${gift}/refund`).set(auth(par.token)).send({ amount: 20 }),
    ])
    const firstWave = [a, b]
    const wins = firstWave.filter(r => r.status === 200)
    const losses = firstWave.filter(r => r.status === 409)
    expect(wins.length, `statuses ${firstWave.map(r => r.status).join(',')}`).toBeGreaterThanOrEqual(1)
    expect(wins.length + losses.length).toBe(2)
    expect(firstWave.every(r => r.status === 200 || r.status === 409)).toBe(true)

    const winnerIds = new Set(wins.map(r => Number(r.body.refund.id)))
    expect(winnerIds.size).toBe(wins.length)

    if (losses.length) {
      const wonAmounts = wins.map(r => Number(r.body.refund.amount))
      const retryAmount = [30, 20].find(n => !wonAmounts.includes(n))
      expect(retryAmount, 'the 409 was a distinct amount that must still be retryable').toBeTruthy()

      const retry = await request(server).post(`/api/donations/${gift}/refund`)
        .set(auth(par.token)).send({ amount: retryAmount })
      expect(retry.status).toBe(200)
      expect(Number(retry.body.refund.id)).not.toBe(Number(wins[0].body.refund.id))
      expect(winnerIds.has(Number(retry.body.refund.id))).toBe(false)
    }

    const after = await pool.query(
      `SELECT totals_json, status FROM ochr_report_submissions WHERE id = $1`, [subId])
    expect(after.rows[0].totals_json).toEqual(before.rows[0].totals_json)
    expect(after.rows[0].status).toBe('approved')
    expect(Number(after.rows[0].totals_json?.totals?.revenue)).toBeCloseTo(100.00, 2)

    const facts = await refundFacts(gift)
    const posted = facts.filter(r => r.status === 'posted')
    expect(posted).toHaveLength(2)
    expect(posted.map(r => Number(r.amount)).sort((x, y) => x - y)).toEqual([20, 30])
    expect(Number(posted.reduce((s, r) => s + Number(r.amount), 0))).toBeCloseTo(50.00, 2)

    const rows = await sidecarRows(subId)
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map(r => Number(r.donation_refund_id)))).toEqual(
      new Set(posted.map(r => Number(r.id))))
    expect(rows.map(r => Number(r.amount)).sort((x, y) => x - y)).toEqual([20, 30])
    expect(rows.every(r => r.resolved_at == null)).toBe(true)

    const live = await request(server)
      .get('/api/finance/summary?start=2071-01-01&end=2071-12-31').set(auth(par.token))
    expect(live.status).toBe(200)
    expect(Number(live.body.totals.revenue)).toBeCloseTo(50.00, 2)
  })

  it('F9: adjustment-insert failure rolls back the posted fact; retry is the same provider refund', async () => {
    // GIV-06 D1 (falseSuccessMoney.test.js) already proves: provider
    // succeeds, local phase-2 stamp UPDATE fails → 500; pending fact
    // remains; retry reuses refund-{org}-{donation}-{refundId} so money
    // moves once. That failure is on ochr_donations, before the sidecar
    // INSERT, and those gifts are not inside a frozen period.
    //
    // GIV-07 adds only the missing assertion at the adjustment-insert
    // boundary: if that INSERT raises, the same phase-2 transaction
    // cannot commit a posted refund without a sidecar.
    const { dio, par } = await affiliatedPair('f9')
    const donor = `GIV07 F9 Boom Adj ${RUN_ID}`
    const gift = await chargedGift(par, 100.00, '2072-04-04', donor)
    const orgId = par.orgId
    const subId = await approvedPeriod(dio, par, '2072-01-01', '2072-12-31')
    const before = await pool.query(
      `SELECT totals_json FROM ochr_report_submissions WHERE id = $1`, [subId])

    const refundLog = []
    const origLog = console.log
    console.log = (...args) => {
      const s = args.join(' ')
      if (/\[pay:stub\] refund/.test(s)) refundLog.push(s)
      origLog(...args)
    }

    await pool.query(`CREATE SEQUENCE IF NOT EXISTS zz_giv07_f9_seq`)
    await pool.query(`SELECT setval('zz_giv07_f9_seq', 1, false)`)
    await pool.query(`
      CREATE OR REPLACE FUNCTION zz_giv07_boom_adj() RETURNS trigger AS $$
      BEGIN
        IF NEW.donation_id = ${Number(gift)} THEN
          IF nextval('zz_giv07_f9_seq') = 1 THEN
            RAISE EXCEPTION 'chaos: period adjustment insert refused';
          END IF;
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
    `)
    await pool.query(`DROP TRIGGER IF EXISTS zz_giv07_boom_adj ON ochr_period_adjustments`)
    await pool.query(`
      CREATE TRIGGER zz_giv07_boom_adj
        BEFORE INSERT ON ochr_period_adjustments
        FOR EACH ROW EXECUTE FUNCTION zz_giv07_boom_adj()`)

    try {
      const first = await request(server).post(`/api/donations/${gift}/refund`)
        .set(auth(par.token)).send({ amount: 40 })
      expect(first.status).toBe(500)
      expect(first.body.error).toBeTruthy()

      const afterFail = await refundFacts(gift)
      expect(afterFail.filter(r => r.status === 'posted')).toHaveLength(0)
      expect(afterFail.filter(r => r.status === 'pending')).toHaveLength(1)
      expect(afterFail[0].refund_ref).toBeNull()
      expect(await sidecarRows(subId)).toHaveLength(0)
      const pendingId = afterFail[0].id
      const keyRef = `stubref_${refundIdempotencyKey(orgId, gift, pendingId).replace(/[^a-zA-Z0-9_-]/g, '')}`

      const retry = await request(server).post(`/api/donations/${gift}/refund`)
        .set(auth(par.token)).send({ amount: 40 })
      expect(retry.status).toBe(200)
      expect(Number(retry.body.refund.id)).toBe(Number(pendingId))
      expect(retry.body.refund.refund_ref).toBe(keyRef)
      expect(Number(retry.body.refund.amount)).toBeCloseTo(40.00, 2)

      const afterOk = await refundFacts(gift)
      expect(afterOk).toHaveLength(1)
      expect(afterOk[0].status).toBe('posted')
      expect(Number(afterOk[0].id)).toBe(Number(pendingId))
      expect(afterOk[0].refund_ref).toBe(keyRef)

      const rows = await sidecarRows(subId)
      expect(rows).toHaveLength(1)
      expect(Number(rows[0].donation_refund_id)).toBe(Number(pendingId))
      expect(Number(rows[0].amount)).toBeCloseTo(40.00, 2)

      const after = await pool.query(
        `SELECT totals_json FROM ochr_report_submissions WHERE id = $1`, [subId])
      expect(after.rows[0].totals_json).toEqual(before.rows[0].totals_json)

      expect(refundLog.length).toBe(2)
      const refs = [...new Set(refundLog.map(line => line.split('→')[1]?.trim().split('|')[0].trim()))]
      expect(refs).toEqual([keyRef])
    } finally {
      console.log = origLog
      await pool.query(`DROP TRIGGER IF EXISTS zz_giv07_boom_adj ON ochr_period_adjustments`)
      await pool.query(`DROP FUNCTION IF EXISTS zz_giv07_boom_adj()`)
      await pool.query(`DROP SEQUENCE IF EXISTS zz_giv07_f9_seq`)
    }
  })

  it('F1: no supported path mutates ochr_donations.date after the gift exists', async () => {
    // Paths searched (code/search, 2026-09-12):
    //   server/src/routes/donations.js — POST insert (sets date at create),
    //     DELETE, POST /:id/refund, cash-count confirm INSERT. No PATCH/PUT
    //     of a gift. Refund writes stamps only via donationRefunds.js.
    //   server/src/finance/donationRefunds.js — the only UPDATE
    //     ochr_donations in server/src; assigns payment_status / refunded_at
    //     / refund_ref. Does not assign date.
    //   server/src/routes/imports.js — INSERT only (commit). PATCH row is
    //     ochr_import_rows.decision, not a gift date.
    //   server/src/payments/index.js recordDonationCheckoutCompleted — INSERT.
    //   server/src/services/recurringGifts.js — INSERT CURRENT_DATE.
    //   server/src/routes/publicEvents.js — INSERT CURRENT_DATE.
    //   server/src/vault — restore INSERT of the captured snapshot (original
    //     date); occupied-id refuses overwrite of a live row. Not a date edit.
    //   server/src/migrations — indexes/views on date; no UPDATE that
    //     assigns ochr_donations.date.
    //   client/src/pages/Donations.jsx — GET / POST cash-count / DELETE /
    //     refund / recurring cancel. No gift-date PATCH/PUT.
    //   client-diocese — no /api/donations write.
    //   rg SET date = on server/src: calendar/bulletins/etc., not donations.
    // Finding: no supported application/API/import/admin path changes a
    // gift's period membership by mutating date after submission.
    const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '../src')
    const hits = []
    for (const file of walkJs(srcRoot)) {
      const stripped = stripJsComments(readFileSync(file, 'utf8'))
      const re = /UPDATE\s+ochr_donations\b[\s\S]{0,1200}?\bSET\b[\s\S]{0,1200}?\bdate\s*=/gi
      if (re.test(stripped)) hits.push(file)
    }
    expect(hits, `UPDATE ochr_donations … SET date= in ${hits.join(', ')}`).toEqual([])

    const { dio, par } = await affiliatedPair('f1')
    const gift = await chargedGift(par, 80.00, '2073-05-05')
    const subId = await approvedPeriod(dio, par, '2073-01-01', '2073-12-31')
    expect(await giftDate(gift)).toBe('2073-05-05')

    const patch = await request(server).patch(`/api/donations/${gift}`).set(auth(par.token))
      .send({ date: '2099-01-01' })
    const put = await request(server).put(`/api/donations/${gift}`).set(auth(par.token))
      .send({ date: '2099-01-01' })
    expect([404, 405]).toContain(patch.status)
    expect([404, 405]).toContain(put.status)
    expect(await giftDate(gift)).toBe('2073-05-05')

    const refund = await request(server).post(`/api/donations/${gift}/refund`)
      .set(auth(par.token)).send({ amount: 10 })
    expect(refund.status).toBe(200)
    expect(await giftDate(gift)).toBe('2073-05-05')
    const rows = await sidecarRows(subId)
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].amount)).toBeCloseTo(10.00, 2)
  })
})
