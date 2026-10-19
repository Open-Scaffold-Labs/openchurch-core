// GIV-08-004 COO HOLD — APPLIED credits may only reduce the assessable
// payable by the refund's assessable impact at freeze. The sidecar
// amount is the raw refund. Frozen assessable_base is revenue on
// accounts marked assessable=true. Subtracting every credit amount from
// that base lets a refund of a non-assessable gift shrink the bill.
//
// Historical assessable impact is stamped at freeze (totals_json) and
// copied onto the adjustment/credit. Later COA or mapping edits must
// not rewrite it. totals_json, the gift, and the refund fact stay put.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import 'dotenv/config'

import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'
import { computeBases } from '../src/finance/assessmentBases.js'
import { assessableImpactFromFreeze } from '../src/finance/giftAssessableFreeze.js'
import { backfillUnknownAssessableImpact } from '../src/migrations/108-period-adjustment-assessable-unknown.js'

const here = dirname(fileURLToPath(import.meta.url))
const src = name => readFileSync(join(here, '..', 'src', name), 'utf8')

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
  const res = await createOrg(server, payload, `10.65.8.${++ipSeq}`)
  expect(res.status).toBe(201)
  const org = res.body.user?.organization ?? res.body.organization
  cleanupOrgIds.push(org.id)
  let token = res.body.token
  if (!token) {
    const login = await request(server).post('/api/auth/login')
      .set('X-Forwarded-For', `10.65.8.${++ipSeq}`)
      .send({ email: payload.email, password: payload.password })
    token = login.body.token
  }
  return { token, orgId: org.id }
}

async function affiliatedPair(tag) {
  const email = `paa_${tag}_par_${RUN_ID}@example.com`
  const dio = await signup({
    organizationName: `PAA ${tag} Diocese ${RUN_ID}`, name: 'Canon',
    email: `paa_${tag}_dio_${RUN_ID}@example.com`, password: 'paa-pw-dio-1',
    organizationType: 'diocese',
  })
  const par = await signup({
    organizationName: `PAA ${tag} Parish ${RUN_ID}`, name: 'Parish Admin',
    email, password: 'paa-pw-par-1',
  })
  const inv = await request(server).post('/api/diocese/parishes/invite').set(auth(dio.token)).send({ email })
  expect(inv.status).toBeLessThan(300)
  const acc = await request(server).post('/api/affiliation/accept').set(auth(par.token)).send({ grant_level: 'detail' })
  expect(acc.status).toBe(200)
  return { dio, par }
}

async function chargedGift(par, amount, date, extra = {}) {
  const res = await request(server).post('/api/donations').set(auth(par.token))
    .send({
      donor_name: extra.donor_name || 'Frozen Donor',
      amount, date, category: extra.category || 'General', method: 'cash',
      fund_id: extra.fund_id,
    })
  expect(res.status).toBe(201)
  const id = res.body.id
  await pool.query(
    `UPDATE ochr_donations SET source='online', payment_ref=$1, payment_status='succeeded' WHERE id=$2`,
    [`pi_paa_${RUN_ID}_${id}`, id])
  return id
}

async function restrictedFund(par, name) {
  const fund = await request(server).post('/api/funds').set(auth(par.token)).send({ name })
  expect(fund.status).toBe(201)
  const fundId = fund.body.id
  const map = await request(server).put('/api/finance/mappings').set(auth(par.token))
    .send({ mappings: [{ source_type: 'fund', source_key: String(fundId), account_code: '4450' }] })
  expect(map.status).toBeLessThan(300)
  return fundId
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

async function settleOpen(dio, subId) {
  const { rows: adj } = await pool.query(
    `SELECT id FROM ochr_period_adjustments WHERE submission_id = $1 AND resolved_at IS NULL`, [subId])
  expect(adj.length).toBeGreaterThan(0)
  const settle = await request(server).post(`/api/diocese/adjustments/${adj[0].id}/settle`)
    .set(auth(dio.token)).send({})
  expect(settle.status).toBe(200)
  return settle
}

const frozen = id => pool.query(
  `SELECT totals_json, status FROM ochr_report_submissions WHERE id = $1`, [id]
).then(r => r.rows[0])

const giftFact = id => pool.query(
  `SELECT amount::text AS amount, payment_status FROM ochr_donations WHERE id = $1`, [id]
).then(r => r.rows[0])

const refundFacts = id => pool.query(
  `SELECT id, amount::text AS amount, status FROM ochr_donation_refunds WHERE donation_id = $1 ORDER BY id`, [id]
).then(r => r.rows)

async function payableBase(dio, year) {
  const rows = await computeBases(dio.orgId, String(year))
  return rows.reduce((s, r) => s + Number(r.base), 0)
}

async function mixedFrozenPeriod(tag, year) {
  const { dio, par } = await affiliatedPair(tag)
  const fundId = await restrictedFund(par, `Restricted ${tag} ${RUN_ID}`)
  const assessableGift = await chargedGift(par, 400.00, `${year}-03-03`, { donor_name: 'Plate Donor' })
  const restrictedGift = await chargedGift(par, 200.00, `${year}-03-04`, {
    donor_name: 'Restricted Donor', fund_id: fundId,
  })
  const subId = await approvedPeriod(dio, par, `${year}-01-01`, `${year}-12-31`)
  const snap = await frozen(subId)
  expect(Number(snap.totals_json?.totals?.assessable_base)).toBeCloseTo(400, 2)
  expect(Number(snap.totals_json?.totals?.revenue)).toBeCloseTo(600, 2)
  return { dio, par, fundId, assessableGift, restrictedGift, subId, snap }
}

describe('GIV-08-004 assessable impact of APPLIED credits', () => {
  it('a non-assessable refund must not shrink the assessable payable', async () => {
    const { dio, par, restrictedGift, subId, snap } = await mixedFrozenPeriod('nonass', 2081)
    const giftBefore = await giftFact(restrictedGift)
    const refund = await refundInPeriod(par, restrictedGift, 50)
    expect(await payableBase(dio, 2081)).toBeCloseTo(400, 2)

    const settle = await settleOpen(dio, subId)
    expect(Number(settle.body.credit.amount)).toBeCloseTo(50, 2)

    expect(await payableBase(dio, 2081)).toBeCloseTo(400, 2)
    expect(await payableBase(dio, 2081)).not.toBeCloseTo(350, 2)

    const list = await request(server).get('/api/diocese/submissions').set(auth(dio.token))
    const row = list.body.submissions.find(s => Number(s.id) === subId)
    expect(Number(row.payable_base)).toBeCloseTo(400, 2)
    expect(Number(row.totals.assessable_base)).toBeCloseTo(400, 2)
    expect(Number(row.applied_credit_amount)).toBeCloseTo(50, 2)

    const after = await frozen(subId)
    expect(after.totals_json).toEqual(snap.totals_json)
    expect(after.status).toBe('approved')
    expect(await giftFact(restrictedGift)).toEqual(giftBefore)
    const facts = await refundFacts(restrictedGift)
    expect(facts).toHaveLength(1)
    expect(Number(facts[0].amount)).toBeCloseTo(50, 2)
    expect(Number(facts[0].id)).toBe(Number(refund.body.refund.id))
  })

  it('an assessable refund still reduces the assessable payable', async () => {
    const { dio, par, assessableGift, subId, snap } = await mixedFrozenPeriod('ass', 2082)
    const giftBefore = await giftFact(assessableGift)
    await refundInPeriod(par, assessableGift, 50)
    expect(await payableBase(dio, 2082)).toBeCloseTo(400, 2)

    await settleOpen(dio, subId)

    expect(await payableBase(dio, 2082)).toBeCloseTo(350, 2)
    const list = await request(server).get('/api/diocese/submissions').set(auth(dio.token))
    const row = list.body.submissions.find(s => Number(s.id) === subId)
    expect(Number(row.payable_base)).toBeCloseTo(350, 2)
    expect(Number(row.totals.assessable_base)).toBeCloseTo(400, 2)
    expect((await frozen(subId)).totals_json).toEqual(snap.totals_json)
    expect(await giftFact(assessableGift)).toEqual(giftBefore)
  })

  it('remapping a fund after freeze does not rewrite historical assessable impact', async () => {
    const { dio, par, fundId, restrictedGift, assessableGift, subId } =
      await mixedFrozenPeriod('remap', 2083)

    const remap = await request(server).put('/api/finance/mappings').set(auth(par.token))
      .send({ mappings: [{ source_type: 'fund', source_key: String(fundId), account_code: '4420' }] })
    expect(remap.status).toBeLessThan(300)

    const live = await request(server).get('/api/finance/summary')
      .query({ start: '2083-01-01', end: '2083-12-31' }).set(auth(par.token))
    expect(Number(live.body.totals.assessable_base)).toBeCloseTo(600, 2)

    await refundInPeriod(par, restrictedGift, 80)
    await settleOpen(dio, subId)
    expect(await payableBase(dio, 2083)).toBeCloseTo(400, 2)

    await refundInPeriod(par, assessableGift, 25)
    await settleOpen(dio, subId)
    expect(await payableBase(dio, 2083)).toBeCloseTo(375, 2)
  })

  it('a diocese flipping assessable after freeze does not rewrite historical impact', async () => {
    const { dio, par, restrictedGift, assessableGift, subId } =
      await mixedFrozenPeriod('coaflip', 2084)

    const flipRestrictedOn = await request(server).put('/api/diocese/coa').set(auth(dio.token))
      .send({ accounts: [{ code: '4450', assessable: true, rollup_group: 'Restricted Gifts' }] })
    expect(flipRestrictedOn.status).toBeLessThan(300)

    await refundInPeriod(par, restrictedGift, 60)
    await settleOpen(dio, subId)
    expect(await payableBase(dio, 2084)).toBeCloseTo(400, 2)

    const flipPlateOff = await request(server).put('/api/diocese/coa').set(auth(dio.token))
      .send({ accounts: [{ code: '4420', assessable: false, rollup_group: 'Offertory' }] })
    expect(flipPlateOff.status).toBeLessThan(300)

    await refundInPeriod(par, assessableGift, 40)
    await settleOpen(dio, subId)
    expect(await payableBase(dio, 2084)).toBeCloseTo(360, 2)
  })

  it('Argus kill 1: restricted $50 on a $100 assessable freeze must not cut payable to $50', async () => {
    const { dio, par } = await affiliatedPair('argus1')
    const fundId = await restrictedFund(par, `Argus1 ${RUN_ID}`)
    await chargedGift(par, 100.00, '2086-03-03', { donor_name: 'Plate' })
    const restrictedGift = await chargedGift(par, 50.00, '2086-03-04', {
      donor_name: 'Restricted', fund_id: fundId,
    })
    const subId = await approvedPeriod(dio, par, '2086-01-01', '2086-12-31')
    expect(Number((await frozen(subId)).totals_json?.totals?.assessable_base)).toBeCloseTo(100, 2)
    await refundInPeriod(par, restrictedGift, 50)
    await settleOpen(dio, subId)
    const rows = await computeBases(dio.orgId, '2086')
    const line = rows.find(r => r.parish_org_id === par.orgId)
    // Held-HEAD FAIL: applied_credits=50, payable=50. GREEN: impact 0, payable 100.
    expect(Number(line.base)).toBeCloseTo(100, 2)
    expect(Number(line.base)).not.toBeCloseTo(50, 2)
    expect(Number(line.applied_credits)).toBeCloseTo(0, 2)
    expect(Number(line.approved_gross)).toBeCloseTo(100, 2)
    expect(Number((await frozen(subId)).totals_json?.totals?.assessable_base)).toBeCloseTo(100, 2)
  })

  it('Argus kill 2: post-freeze 4450→4420 remap must not let an $80 restricted refund cut a $200 freeze', async () => {
    const { dio, par } = await affiliatedPair('argus2')
    const fundId = await restrictedFund(par, `Argus2 ${RUN_ID}`)
    await chargedGift(par, 200.00, '2087-03-03', { donor_name: 'Plate' })
    const restrictedGift = await chargedGift(par, 80.00, '2087-03-04', {
      donor_name: 'Restricted', fund_id: fundId,
    })
    const subId = await approvedPeriod(dio, par, '2087-01-01', '2087-12-31')
    const before = await frozen(subId)
    expect(Number(before.totals_json?.totals?.assessable_base)).toBeCloseTo(200, 2)
    const remap = await request(server).put('/api/finance/mappings').set(auth(par.token))
      .send({ mappings: [{ source_type: 'fund', source_key: String(fundId), account_code: '4420' }] })
    expect(remap.status).toBeLessThan(300)
    const afterRemap = await frozen(subId)
    expect(afterRemap.totals_json).toEqual(before.totals_json)
    expect(Number(afterRemap.totals_json?.totals?.assessable_base)).toBeCloseTo(200, 2)
    await refundInPeriod(par, restrictedGift, 80)
    await settleOpen(dio, subId)
    // Held-HEAD FAIL: payable=120. GREEN: freeze stamp stays non-assessable, payable 200.
    expect(await payableBase(dio, 2087)).toBeCloseTo(200, 2)
    expect(await payableBase(dio, 2087)).not.toBeCloseTo(120, 2)
    expect(Number((await frozen(subId)).totals_json?.totals?.assessable_base)).toBeCloseTo(200, 2)
  })

  // Ledger independent falsify on held HEAD a532f82 — same kill as
  // Argus, different amounts: freeze 4420@$1000 + 4450@$400
  // (revenue 1400 / assessable 1000). Author M4 tests only used 4420.
  it('Ledger kill: 4420 $1000 + 4450 $400 — restricted full refund leaves payable at 1000', async () => {
    const { dio, par } = await affiliatedPair('ledger')
    const fundId = await restrictedFund(par, `Ledger ${RUN_ID}`)
    const plate = await chargedGift(par, 1000.00, '2088-03-03', { donor_name: 'Plate' })
    const restrictedGift = await chargedGift(par, 400.00, '2088-03-04', {
      donor_name: 'Restricted', fund_id: fundId,
    })
    const subId = await approvedPeriod(dio, par, '2088-01-01', '2088-12-31')
    const snap = await frozen(subId)
    expect(Number(snap.totals_json?.totals?.assessable_base)).toBeCloseTo(1000, 2)
    expect(Number(snap.totals_json?.totals?.revenue)).toBeCloseTo(1400, 2)

    await refundInPeriod(par, restrictedGift, 400)
    await settleOpen(dio, subId)
    // Held-HEAD FAIL: M4 subtracted the whole $400 refund → payable 600.
    // GREEN: 4450 never sat in frozen assessable_base, so impact is 0.
    expect(await payableBase(dio, 2088)).toBeCloseTo(1000, 2)
    expect(await payableBase(dio, 2088)).not.toBeCloseTo(600, 2)
    const afterRestricted = await request(server).get('/api/diocese/submissions').set(auth(dio.token))
    const restrictedRow = afterRestricted.body.submissions.find(s => Number(s.id) === subId)
    expect(Number(restrictedRow.payable_base)).toBeCloseTo(1000, 2)
    expect(Number(restrictedRow.payable_base)).not.toBeCloseTo(600, 2)
    expect(Number(restrictedRow.applied_credit_amount)).toBeCloseTo(400, 2)
    expect(Number(restrictedRow.totals.assessable_base)).toBeCloseTo(1000, 2)
    const restrictedLine = (await computeBases(dio.orgId, '2088'))
      .find(r => r.parish_org_id === par.orgId)
    expect(Number(restrictedLine.applied_credits)).toBeCloseTo(0, 2)
    expect(Number((await frozen(subId)).totals_json?.totals?.assessable_base)).toBeCloseTo(1000, 2)

    await refundInPeriod(par, plate, 250)
    await settleOpen(dio, subId)
    expect(await payableBase(dio, 2088)).toBeCloseTo(750, 2)
    expect(Number((await frozen(subId)).totals_json?.totals?.assessable_base)).toBeCloseTo(1000, 2)
  })

  it('Ledger mixed kill: $200 assessable + $400 restricted refunds leave payable at 800', async () => {
    const { dio, par } = await affiliatedPair('ledger2')
    const fundId = await restrictedFund(par, `Ledger2 ${RUN_ID}`)
    const plate = await chargedGift(par, 1000.00, '2089-03-03', { donor_name: 'Plate' })
    const restrictedGift = await chargedGift(par, 400.00, '2089-03-04', {
      donor_name: 'Restricted', fund_id: fundId,
    })
    const subId = await approvedPeriod(dio, par, '2089-01-01', '2089-12-31')
    expect(Number((await frozen(subId)).totals_json?.totals?.assessable_base)).toBeCloseTo(1000, 2)
    expect(Number((await frozen(subId)).totals_json?.totals?.revenue)).toBeCloseTo(1400, 2)
    await refundInPeriod(par, plate, 200)
    await settleOpen(dio, subId)
    await refundInPeriod(par, restrictedGift, 400)
    await settleOpen(dio, subId)
    // Held-HEAD FAIL: mixed 200+400 subtracted in full → payable 400.
    // GREEN: only the $200 that sat in assessable_base moves the bill.
    expect(await payableBase(dio, 2089)).toBeCloseTo(800, 2)
    expect(await payableBase(dio, 2089)).not.toBeCloseTo(400, 2)
    const list = await request(server).get('/api/diocese/submissions').set(auth(dio.token))
    const row = list.body.submissions.find(s => Number(s.id) === subId)
    expect(Number(row.payable_base)).toBeCloseTo(800, 2)
    expect(Number(row.payable_base)).not.toBeCloseTo(400, 2)
    expect(Number(row.applied_credit_amount)).toBeCloseTo(600, 2)
    expect(Number(row.totals.assessable_base)).toBeCloseTo(1000, 2)
    const line = (await computeBases(dio.orgId, '2089'))
      .find(r => r.parish_org_id === par.orgId)
    expect(Number(line.applied_credits)).toBeCloseTo(200, 2)
    expect(Number((await frozen(subId)).totals_json?.totals?.assessable_base)).toBeCloseTo(1000, 2)
  })

  it('freeze stamps gift assessable facts; refund/settle do not read live COA', async () => {
    const { restrictedGift, assessableGift, snap } = await mixedFrozenPeriod('stamp', 2085)
    const map = snap.totals_json?.gift_assessable
    expect(map, 'freeze must persist per-gift assessable facts').toBeTruthy()
    expect(map[String(restrictedGift)].assessable).toBe(false)
    expect(map[String(restrictedGift)].account_code).toBe('4450')
    expect(map[String(assessableGift)].assessable).toBe(true)

    const refundSrc = src('routes/donations.js')
    const settleSrc = src('finance/periodAdjustmentSettle.js')
    const basesSrc = src('finance/assessmentBases.js')
    const rollupSrc = src('finance/periodAdjustmentRollup.js')
    expect(refundSrc).toMatch(/gift_assessable/)
    expect(refundSrc).not.toMatch(/ochr_coa_accounts/)
    expect(refundSrc).not.toMatch(/COALESCE\([\s\S]*gift_assessable[\s\S]*false/)
    expect(refundSrc).toMatch(/ELSE NULL/)
    expect(settleSrc).toMatch(/assessable_unknown/)
    expect(settleSrc).toMatch(/assessable_impact/)
    expect(settleSrc).not.toMatch(/ochr_coa_accounts|ochr_coa_mappings|EFFECTIVE_COA/)
    expect(basesSrc).toMatch(/assessable_impact/)
    expect(basesSrc).not.toMatch(/SUM\(c\.amount\)/)
    expect(rollupSrc).toMatch(/assessable_impact/)
  })
})

describe('GIV-08-005 UNKNOWN freeze-time assessability is not zero', () => {
  it('Carolina schema: sidecar impact is nullable with no DEFAULT; credits stay known', async () => {
    const { rows: adj } = await pool.query(
      `SELECT is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'ochr_period_adjustments'
          AND column_name = 'assessable_impact'`)
    expect(adj[0].is_nullable).toBe('YES')
    expect(adj[0].column_default).toBeNull()
    const { rows: cred } = await pool.query(
      `SELECT is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'ochr_period_adjustment_credits'
          AND column_name = 'assessable_impact'`)
    expect(cred[0].is_nullable).toBe('NO')
  })

  it('assessableImpactFromFreeze keeps UNKNOWN distinct from false', () => {
    expect(assessableImpactFromFreeze(undefined, 1, 100)).toEqual({ known: false, impact: null })
    expect(assessableImpactFromFreeze({}, 1, 100)).toEqual({ known: false, impact: null })
    expect(assessableImpactFromFreeze({ 1: { account_code: '4420' } }, 1, 100))
      .toEqual({ known: false, impact: null })
    expect(assessableImpactFromFreeze({ 1: { assessable: true } }, 1, 100))
      .toEqual({ known: true, impact: 100 })
    expect(assessableImpactFromFreeze({ 1: { assessable: false } }, 1, 100))
      .toEqual({ known: true, impact: 0 })
  })

  async function stripGiftAssessable(subId) {
    const before = await frozen(subId)
    expect(before.totals_json?.gift_assessable, 'fixture must start with a freeze map').toBeTruthy()
    await pool.query(
      `UPDATE ochr_report_submissions
          SET totals_json = totals_json - 'gift_assessable'
        WHERE id = $1`,
      [subId])
    const after = await frozen(subId)
    expect(after.totals_json.gift_assessable).toBeUndefined()
    expect(after.totals_json.totals).toEqual(before.totals_json.totals)
    return before
  }

  it('Argus UNKNOWN: stripped map + $100 assessable refund must not apply impact 0', async () => {
    const { dio, par } = await affiliatedPair('unknown')
    const gift = await chargedGift(par, 100.00, '2090-03-03', { donor_name: 'Plate' })
    const subId = await approvedPeriod(dio, par, '2090-01-01', '2090-12-31')
    const before = await stripGiftAssessable(subId)
    expect(Number(before.totals_json?.totals?.assessable_base)).toBeCloseTo(100, 2)
    const giftBefore = await giftFact(gift)

    const refund = await refundInPeriod(par, gift, 100)
    const { rows: adj } = await pool.query(
      `SELECT id, amount::text AS amount, assessable_impact::text AS impact, resolved_at
         FROM ochr_period_adjustments WHERE submission_id = $1`, [subId])
    expect(adj).toHaveLength(1)
    expect(Number(adj[0].amount)).toBeCloseTo(100, 2)
    // Held-HEAD FAIL: COALESCE false → impact 0. GREEN: UNKNOWN stays NULL.
    expect(adj[0].impact).toBeNull()
    expect(adj[0].resolved_at).toBeNull()

    expect(await payableBase(dio, 2090)).toBeCloseTo(100, 2)

    const settle = await request(server).post(`/api/diocese/adjustments/${adj[0].id}/settle`)
      .set(auth(dio.token)).send({})
    // Held-HEAD FAIL: settle 200, credit impact 0, payable stays 100 and
    // looks resolved. GREEN: refuse, still OPEN, payable unchanged.
    expect(settle.status).toBe(409)
    expect(settle.body.code).toBe('assessable_unknown')
    expect(settle.body.credit).toBeUndefined()
    expect(settle.body.error).toMatch(/Nothing was lost/)

    const { rows: afterAdj } = await pool.query(
      `SELECT resolved_at, assessable_impact FROM ochr_period_adjustments WHERE id = $1`,
      [adj[0].id])
    expect(afterAdj[0].resolved_at).toBeNull()
    expect(afterAdj[0].assessable_impact).toBeNull()
    const { rows: credits } = await pool.query(
      `SELECT id FROM ochr_period_adjustment_credits WHERE submission_id = $1`, [subId])
    expect(credits).toHaveLength(0)
    expect(await payableBase(dio, 2090)).toBeCloseTo(100, 2)
    expect(await payableBase(dio, 2090)).not.toBeCloseTo(0, 2)

    const list = await request(server).get('/api/diocese/submissions').set(auth(dio.token))
    const row = list.body.submissions.find(s => Number(s.id) === subId)
    expect(Number(row.payable_base)).toBeCloseTo(100, 2)
    expect(Number(row.open_adjustment_count)).toBe(1)
    expect(Number(row.applied_credit_amount)).toBeCloseTo(0, 2)

    const legacyFreeze = { ...before.totals_json }
    delete legacyFreeze.gift_assessable
    const after = await frozen(subId)
    expect(after.totals_json).toEqual(legacyFreeze)
    expect(after.totals_json.gift_assessable).toBeUndefined()
    expect(after.status).toBe('approved')
    const giftAfter = await giftFact(gift)
    expect(giftAfter.amount).toBe(giftBefore.amount)
    const facts = await refundFacts(gift)
    expect(facts).toHaveLength(1)
    expect(Number(facts[0].amount)).toBeCloseTo(100, 2)
    expect(Number(facts[0].id)).toBe(Number(refund.body.refund.id))
  })

  it('live 4420→4450 remap must not invent assessability for a stripped freeze', async () => {
    const { dio, par } = await affiliatedPair('unkremap')
    const fund = await request(server).post('/api/funds').set(auth(par.token))
      .send({ name: `Unremap ${RUN_ID}` })
    expect(fund.status).toBe(201)
    const map4420 = await request(server).put('/api/finance/mappings').set(auth(par.token))
      .send({ mappings: [{ source_type: 'fund', source_key: String(fund.body.id), account_code: '4420' }] })
    expect(map4420.status).toBeLessThan(300)
    const gift = await chargedGift(par, 100.00, '2091-03-03', {
      donor_name: 'Plate', fund_id: fund.body.id,
    })
    const subId = await approvedPeriod(dio, par, '2091-01-01', '2091-12-31')
    const before = await stripGiftAssessable(subId)

    const remap = await request(server).put('/api/finance/mappings').set(auth(par.token))
      .send({ mappings: [{ source_type: 'fund', source_key: String(fund.body.id), account_code: '4450' }] })
    expect(remap.status).toBeLessThan(300)
    const flip = await request(server).put('/api/diocese/coa').set(auth(dio.token))
      .send({ accounts: [{ code: '4420', assessable: false, rollup_group: 'Offertory' }] })
    expect(flip.status).toBeLessThan(300)

    await refundInPeriod(par, gift, 100)
    const { rows: adj } = await pool.query(
      `SELECT id, assessable_impact FROM ochr_period_adjustments WHERE submission_id = $1`, [subId])
    expect(adj[0].assessable_impact).toBeNull()

    const settle = await request(server).post(`/api/diocese/adjustments/${adj[0].id}/settle`)
      .set(auth(dio.token)).send({})
    expect(settle.status).toBe(409)
    expect(settle.body.code).toBe('assessable_unknown')
    expect(await payableBase(dio, 2091)).toBeCloseTo(100, 2)
    const { rows: credits } = await pool.query(
      `SELECT id FROM ochr_period_adjustment_credits WHERE submission_id = $1`, [subId])
    expect(credits).toHaveLength(0)
    expect((await frozen(subId)).totals_json.totals).toEqual(before.totals_json.totals)
    expect((await frozen(subId)).totals_json.gift_assessable).toBeUndefined()
  })

  it('pre-107 OPEN default-0 sidecar with no freeze map cannot change payable', async () => {
    const { dio, par } = await affiliatedPair('pre107')
    const gift = await chargedGift(par, 80.00, '2092-03-03', { donor_name: 'Plate' })
    const subId = await approvedPeriod(dio, par, '2092-01-01', '2092-12-31')
    await stripGiftAssessable(subId)
    const { rows: org } = await pool.query(
      `SELECT organization_id, diocese_org_id FROM ochr_report_submissions WHERE id = $1`, [subId])
    const { rows: refund } = await pool.query(
      `INSERT INTO ochr_donation_refunds (organization_id, donation_id, amount, status)
       VALUES ($1, $2, 80, 'posted') RETURNING id`, [org[0].organization_id, gift])
    const { rows: adj } = await pool.query(
      `INSERT INTO ochr_period_adjustments
         (organization_id, diocese_org_id, submission_id, donation_id,
          donation_refund_id, kind, amount, assessable_impact)
       VALUES ($1, $2, $3, $4, $5, 'refund', 80, 0)
       RETURNING id, assessable_impact`,
      [org[0].organization_id, org[0].diocese_org_id, subId, gift, refund[0].id])
    expect(Number(adj[0].assessable_impact)).toBe(0)

    const filled = await backfillUnknownAssessableImpact(pool)
    expect(filled).toBeGreaterThanOrEqual(1)
    const { rows: after } = await pool.query(
      `SELECT assessable_impact, resolved_at FROM ochr_period_adjustments WHERE id = $1`,
      [adj[0].id])
    expect(after[0].assessable_impact).toBeNull()
    expect(after[0].resolved_at).toBeNull()

    const settle = await request(server).post(`/api/diocese/adjustments/${adj[0].id}/settle`)
      .set(auth(dio.token)).send({})
    expect(settle.status).toBe(409)
    expect(settle.body.code).toBe('assessable_unknown')
    expect(await payableBase(dio, 2092)).toBeCloseTo(80, 2)
    const { rows: credits } = await pool.query(
      `SELECT id FROM ochr_period_adjustment_credits WHERE submission_id = $1`, [subId])
    expect(credits).toHaveLength(0)
  })

  it('OPEN sidecar on a freeze that HAS the map is restamped from that map, not live COA', async () => {
    const { dio, par, assessableGift, subId, snap } = await mixedFrozenPeriod('bfmap', 2093)
    const { rows: org } = await pool.query(
      `SELECT organization_id, diocese_org_id FROM ochr_report_submissions WHERE id = $1`, [subId])
    const { rows: refund } = await pool.query(
      `INSERT INTO ochr_donation_refunds (organization_id, donation_id, amount, status)
       VALUES ($1, $2, 50, 'posted') RETURNING id`,
      [org[0].organization_id, assessableGift])
    const { rows: adj } = await pool.query(
      `INSERT INTO ochr_period_adjustments
         (organization_id, diocese_org_id, submission_id, donation_id,
          donation_refund_id, kind, amount, assessable_impact)
       VALUES ($1, $2, $3, $4, $5, 'refund', 50, 0)
       RETURNING id`,
      [org[0].organization_id, org[0].diocese_org_id, subId, assessableGift, refund[0].id])

    const flip = await request(server).put('/api/diocese/coa').set(auth(dio.token))
      .send({ accounts: [{ code: '4420', assessable: false, rollup_group: 'Offertory' }] })
    expect(flip.status).toBeLessThan(300)

    await backfillUnknownAssessableImpact(pool)
    const { rows: stamped } = await pool.query(
      `SELECT assessable_impact::text AS impact FROM ochr_period_adjustments WHERE id = $1`,
      [adj[0].id])
    expect(Number(stamped[0].impact)).toBeCloseTo(50, 2)

    const settle = await request(server).post(`/api/diocese/adjustments/${adj[0].id}/settle`)
      .set(auth(dio.token)).send({})
    expect(settle.status).toBe(200)
    expect(await payableBase(dio, 2093)).toBeCloseTo(350, 2)
    expect((await frozen(subId)).totals_json).toEqual(snap.totals_json)
  })

  async function platePeriod(tag, year) {
    const { dio, par } = await affiliatedPair(tag)
    const gift = await chargedGift(par, 200.00, `${year}-03-03`, { donor_name: 'Plate' })
    const subId = await approvedPeriod(dio, par, `${year}-01-01`, `${year}-12-31`)
    return { dio, par, gift, subId }
  }

  async function writeFreezeMap(subId, map) {
    const json = map === null ? 'null' : JSON.stringify(map)
    await pool.query(
      `UPDATE ochr_report_submissions
          SET totals_json = (totals_json - 'gift_assessable') || jsonb_build_object('gift_assessable', $2::jsonb)
        WHERE id = $1`,
      [subId, json])
  }

  it('Ledger control: freeze map true stamps $80 of a $200 plate and settle cuts payable to 120', async () => {
    const { dio, par, gift, subId } = await platePeriod('ledctl', 2095)
    const map = (await frozen(subId)).totals_json?.gift_assessable
    expect(map[String(gift)].assessable).toBe(true)
    await refundInPeriod(par, gift, 80)
    const { rows: adj } = await pool.query(
      `SELECT assessable_impact::text AS impact FROM ochr_period_adjustments WHERE submission_id = $1`,
      [subId])
    expect(Number(adj[0].impact)).toBeCloseTo(80, 2)
    await settleOpen(dio, subId)
    expect(await payableBase(dio, 2095)).toBeCloseTo(120, 2)
    expect(await payableBase(dio, 2095)).not.toBeCloseTo(200, 2)
  })

  it.each([
    ['strip_key', async (subId) => {
      await pool.query(
        `UPDATE ochr_report_submissions SET totals_json = totals_json - 'gift_assessable' WHERE id = $1`,
        [subId])
    }],
    ['null_map', async (subId) => {
      await writeFreezeMap(subId, null)
    }],
    ['empty_map', async (subId) => {
      await writeFreezeMap(subId, {})
    }],
    ['missing_gift', async (subId) => {
      await writeFreezeMap(subId, { '0': { assessable: true, account_code: '4420' } })
    }],
    ['null_flag', async (subId, gift) => {
      await writeFreezeMap(subId, { [String(gift)]: { assessable: null, account_code: '4420' } })
    }],
  ])('Ledger UNKNOWN %s: 80 of 200 plate must stamp NULL and refuse settle', async (_name, mutate) => {
    const year = 2096
    const { dio, par, gift, subId } = await platePeriod(`led${_name}`.slice(0, 12), year)
    await mutate(subId, gift)
    await refundInPeriod(par, gift, 80)
    const { rows: adj } = await pool.query(
      `SELECT id, assessable_impact FROM ochr_period_adjustments WHERE submission_id = $1`,
      [subId])
    expect(adj).toHaveLength(1)
    // Held-HEAD FAIL: COALESCE false → impact 0, settle 200, payable stays 200.
    // GREEN: UNKNOWN stays NULL, settle 409, no credit, still OPEN.
    expect(adj[0].assessable_impact).toBeNull()
    const settle = await request(server).post(`/api/diocese/adjustments/${adj[0].id}/settle`)
      .set(auth(dio.token)).send({})
    expect(settle.status).toBe(409)
    expect(settle.body.code).toBe('assessable_unknown')
    const { rows: credits } = await pool.query(
      `SELECT id FROM ochr_period_adjustment_credits WHERE submission_id = $1`, [subId])
    expect(credits).toHaveLength(0)
    expect(await payableBase(dio, year)).toBeCloseTo(200, 2)
    expect(await payableBase(dio, year)).not.toBeCloseTo(120, 2)
  })

  it('batch settle refuses when any OPEN sidecar is UNKNOWN', async () => {
    const { dio, par } = await affiliatedPair('unkbatch')
    const gift = await chargedGift(par, 100.00, '2094-03-03')
    const subId = await approvedPeriod(dio, par, '2094-01-01', '2094-12-31')
    await stripGiftAssessable(subId)
    await refundInPeriod(par, gift, 40)
    const batch = await request(server).post(`/api/diocese/submissions/${subId}/adjustments/settle`)
      .set(auth(dio.token)).send({})
    expect(batch.status).toBe(409)
    expect(batch.body.code).toBe('assessable_unknown')
    const { rows: credits } = await pool.query(
      `SELECT id FROM ochr_period_adjustment_credits WHERE submission_id = $1`, [subId])
    expect(credits).toHaveLength(0)
    expect(await payableBase(dio, 2094)).toBeCloseTo(100, 2)
  })
})
