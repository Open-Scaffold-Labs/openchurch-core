// GIV-08-005 COO HOLD — Carolina INDEPENDENT FALSIFY, ported onto #66.
// Author ≠ certifier. Do not merge. No invent backfill.
//
// Claim: missing freeze-time gift_assessable is UNKNOWN historical
// truth. Treating it as false / non-assessable invents history.
// Fix is (b) preserve UNKNOWN fail-closed. Never use live COA as T0.
//
// Held tip: d4460964ea2322755d3dd2ca728cadbf61c6239c
// Attack A FAIL (3 constructions). B/C/D PASS on that tip.

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

const here = dirname(fileURLToPath(import.meta.url))
const src = name => readFileSync(join(here, '..', 'src', name), 'utf8')
const TIP = 'd4460964ea2322755d3dd2ca728cadbf61c6239c'

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

function looksUnknown(value) {
  if (value == null) return false
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  // Must be a product label, not a donor name or incidental copy.
  return /"code"\s*:\s*"assessable_unknown"|fail[-_ ]?closed|UNKNOWN historical|gift_assessable is unknown/i.test(text)
}

async function signup(payload) {
  const res = await createOrg(server, payload, `10.88.5.${++ipSeq}`)
  expect(res.status).toBe(201)
  const org = res.body.user?.organization ?? res.body.organization
  cleanupOrgIds.push(org.id)
  let token = res.body.token
  if (!token) {
    const login = await request(server).post('/api/auth/login')
      .set('X-Forwarded-For', `10.88.5.${++ipSeq}`)
      .send({ email: payload.email, password: payload.password })
    token = login.body.token
  }
  return { token, orgId: org.id }
}

async function affiliatedPair(tag) {
  const email = `c005_${tag}_par_${RUN_ID}@example.com`
  const dio = await signup({
    organizationName: `C005 ${tag} Diocese ${RUN_ID}`, name: 'Canon',
    email: `c005_${tag}_dio_${RUN_ID}@example.com`, password: 'c005-pw-dio-1',
    organizationType: 'diocese',
  })
  const par = await signup({
    organizationName: `C005 ${tag} Parish ${RUN_ID}`, name: 'Parish Admin',
    email, password: 'c005-pw-par-1',
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
      donor_name: extra.donor_name || 'Carolina Certifier',
      amount, date, category: extra.category || 'General', method: 'cash',
      fund_id: extra.fund_id,
    })
  expect(res.status).toBe(201)
  const id = res.body.id
  await pool.query(
    `UPDATE ochr_donations SET source='online', payment_ref=$1, payment_status='succeeded' WHERE id=$2`,
    [`pi_c005_${RUN_ID}_${id}`, id])
  return id
}

async function restrictedFund(par, name) {
  const fund = await request(server).post('/api/funds').set(auth(par.token)).send({ name })
  expect(fund.status).toBe(201)
  const map = await request(server).put('/api/finance/mappings').set(auth(par.token))
    .send({ mappings: [{ source_type: 'fund', source_key: String(fund.body.id), account_code: '4450' }] })
  expect(map.status).toBeLessThan(300)
  return fund.body.id
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

const frozen = id => pool.query(
  `SELECT totals_json::text AS bytes, totals_json, status
     FROM ochr_report_submissions WHERE id = $1`, [id]
).then(r => r.rows[0])

const giftFact = id => pool.query(
  `SELECT amount::text AS amount, to_char(date, 'YYYY-MM-DD') AS date, payment_status
     FROM ochr_donations WHERE id = $1`, [id]
).then(r => r.rows[0])

async function payableBase(dio, year) {
  const rows = await computeBases(dio.orgId, String(year))
  return rows.reduce((s, r) => s + Number(r.base), 0)
}

async function stripGiftAssessable(subId) {
  await pool.query(
    `UPDATE ochr_report_submissions
        SET totals_json = totals_json - 'gift_assessable'
      WHERE id = $1`,
    [subId],
  )
  const snap = await frozen(subId)
  expect(snap.totals_json.gift_assessable, 'strip must remove the freeze map').toBeUndefined()
  return snap
}

async function dropGiftFromMap(subId, giftId) {
  await pool.query(
    `UPDATE ochr_report_submissions
        SET totals_json = jsonb_set(
              totals_json,
              '{gift_assessable}',
              (totals_json->'gift_assessable') - $2::text
            )
      WHERE id = $1`,
    [subId, String(giftId)],
  )
}

async function nullGiftAssessableFlag(subId, giftId) {
  await pool.query(
    `UPDATE ochr_report_submissions
        SET totals_json = jsonb_set(
              totals_json,
              ARRAY['gift_assessable', $2::text, 'assessable'],
              'null'::jsonb
            )
      WHERE id = $1`,
    [subId, String(giftId)],
  )
}

async function refundMaybe(par, gift, amount) {
  const res = await request(server).post(`/api/donations/${gift}/refund`)
    .set(auth(par.token)).send({ amount })
  return res
}

async function settleMaybe(dio, subId) {
  const { rows: adj } = await pool.query(
    `SELECT id, amount::text AS amount, assessable_impact::text AS assessable_impact,
            resolved_at
       FROM ochr_period_adjustments
      WHERE submission_id = $1
      ORDER BY id DESC`,
    [subId],
  )
  if (!adj.length) return { adj: null, settle: null }
  const settle = await request(server).post(`/api/diocese/adjustments/${adj[0].id}/settle`)
    .set(auth(dio.token)).send({})
  return { adj: adj[0], settle }
}

function inventedNonAssessable({ refund, settle, impact }) {
  const labeled = looksUnknown(refund?.body) || looksUnknown(settle?.body)
    || refund?.status >= 400 || (settle && settle.status >= 400)
  // Numeric 0 is the invented NON-ASSESSABLE stamp. SQL NULL is UNKNOWN.
  const stampedZero = impact != null && Number(impact) === 0
  return refund?.status === 200
    && stampedZero
    && (!settle || settle.status === 200)
    && !labeled
}

function assertUnknownImpact(adj) {
  expect(adj, 'sidecar must exist after a frozen-period refund').toBeTruthy()
  // Held-HEAD FAIL: COALESCE false → '0.00'. GREEN: NULL, not numeric 0.
  // Number(null) === 0 in JS — do not use that as the stamp check.
  expect(adj.assessable_impact, 'UNKNOWN must not be stamped as numeric 0').toBeNull()
}

describe(`GIV-08-005 Carolina UNKNOWN ≠ non-assessable @ ${TIP}`, () => {
  it('A: missing gift_assessable on an assessable freeze must not invent impact 0', async () => {
    const { dio, par } = await affiliatedPair('missmap')
    const gift = await chargedGift(par, 777.00, '2191-03-03', { donor_name: 'Plate Certifier' })
    const subId = await approvedPeriod(dio, par, '2191-01-01', '2191-12-31')
    const beforeStrip = await frozen(subId)
    expect(Number(beforeStrip.totals_json?.totals?.assessable_base)).toBeCloseTo(777, 2)
    expect(beforeStrip.totals_json?.gift_assessable?.[String(gift)]?.assessable).toBe(true)

    const stripped = await stripGiftAssessable(subId)
    expect(Number(stripped.totals_json?.totals?.assessable_base)).toBeCloseTo(777, 2)

    const giftBefore = await giftFact(gift)
    const refund = await refundMaybe(par, gift, 111)
    const { adj, settle } = refund.status >= 400
      ? { adj: null, settle: null }
      : await settleMaybe(dio, subId)

    const impact = adj ? adj.assessable_impact : null
    const pay = await payableBase(dio, 2191)
    console.info(JSON.stringify({
      attack: 'A-missmap', tip: TIP,
      refund: refund.status, settle: settle?.status,
      impact, amount: adj?.amount, pay, frozen_base: 777,
      labeled: looksUnknown(refund.body) || looksUnknown(settle?.body),
    }))
    const invented = inventedNonAssessable({ refund, settle, impact })

    // GREEN: refuse or label UNKNOWN. RED on d446096: COALESCE(..., false)
    // stamps 0 and settle applies it as non-assessable.
    expect(
      invented,
      `missing gift_assessable invented non-assessable `
        + `(refund=${refund.status} settle=${settle?.status} impact=${impact} `
        + `adj=${JSON.stringify(adj)} body=${JSON.stringify(refund.body?.period_adjustment)})`,
    ).toBe(false)
    if (refund.status < 400) {
      assertUnknownImpact(adj)
      expect(settle?.status).toBe(409)
      expect(settle?.body?.code).toBe('assessable_unknown')
      expect(pay).toBeCloseTo(777, 2)
    }

    const after = await frozen(subId)
    expect(after.totals_json.gift_assessable, 'refund/settle must not invent a freeze map').toBeUndefined()
    expect(await giftFact(gift)).toEqual(giftBefore)
  })

  it('A: map present but this gift omitted must not invent impact 0', async () => {
    const { dio, par } = await affiliatedPair('omitone')
    const gift = await chargedGift(par, 333.00, '2192-03-03')
    const subId = await approvedPeriod(dio, par, '2192-01-01', '2192-12-31')
    await dropGiftFromMap(subId, gift)
    const snap = await frozen(subId)
    expect(snap.totals_json.gift_assessable).toBeTruthy()
    expect(snap.totals_json.gift_assessable[String(gift)]).toBeUndefined()
    expect(Number(snap.totals_json?.totals?.assessable_base)).toBeCloseTo(333, 2)

    const refund = await refundMaybe(par, gift, 88)
    const { adj, settle } = refund.status >= 400
      ? { adj: null, settle: null }
      : await settleMaybe(dio, subId)
    const invented = inventedNonAssessable({
      refund, settle, impact: adj ? adj.assessable_impact : null,
    })
    expect(invented, `omitted gift_assessable entry invented non-assessable impact=${adj?.assessable_impact}`).toBe(false)
    if (refund.status < 400) {
      assertUnknownImpact(adj)
      expect(settle?.status).toBe(409)
      expect(settle?.body?.code).toBe('assessable_unknown')
      expect(await payableBase(dio, 2192)).toBeCloseTo(333, 2)
    }
  })

  it('A: NULL assessable flag in the freeze map must not COALESCE to false', async () => {
    const { dio, par } = await affiliatedPair('nullflag')
    const gift = await chargedGift(par, 222.00, '2193-03-03')
    const subId = await approvedPeriod(dio, par, '2193-01-01', '2193-12-31')
    await nullGiftAssessableFlag(subId, gift)
    const snap = await frozen(subId)
    expect(snap.totals_json.gift_assessable[String(gift)].assessable).toBeNull()

    const refund = await refundMaybe(par, gift, 50)
    const { adj, settle } = refund.status >= 400
      ? { adj: null, settle: null }
      : await settleMaybe(dio, subId)
    const invented = inventedNonAssessable({
      refund, settle, impact: adj ? adj.assessable_impact : null,
    })
    expect(invented, `NULL assessable flag invented non-assessable impact=${adj?.assessable_impact}`).toBe(false)
    if (refund.status < 400) {
      assertUnknownImpact(adj)
      expect(settle?.status).toBe(409)
      expect(settle?.body?.code).toBe('assessable_unknown')
      expect(await payableBase(dio, 2193)).toBeCloseTo(222, 2)
    }
  })

  it('B: after freeze, live COA flip must not rewrite freeze-time impact', async () => {
    const { dio, par } = await affiliatedPair('livecoa')
    const fundId = await restrictedFund(par, `C005 Restricted ${RUN_ID}`)
    const plate = await chargedGift(par, 500.00, '2194-03-03', { donor_name: 'Plate' })
    const restricted = await chargedGift(par, 250.00, '2194-03-04', {
      donor_name: 'Restricted', fund_id: fundId,
    })
    const subId = await approvedPeriod(dio, par, '2194-01-01', '2194-12-31')
    const snap = await frozen(subId)
    expect(Number(snap.totals_json?.totals?.assessable_base)).toBeCloseTo(500, 2)
    expect(snap.totals_json.gift_assessable[String(plate)].assessable).toBe(true)
    expect(snap.totals_json.gift_assessable[String(restricted)].assessable).toBe(false)

    const flipOff = await request(server).put('/api/diocese/coa').set(auth(dio.token))
      .send({ accounts: [{ code: '4420', assessable: false, rollup_group: 'Offertory' }] })
    expect(flipOff.status).toBeLessThan(300)
    const flipOn = await request(server).put('/api/diocese/coa').set(auth(dio.token))
      .send({ accounts: [{ code: '4450', assessable: true, rollup_group: 'Restricted Gifts' }] })
    expect(flipOn.status).toBeLessThan(300)

    const live = await request(server).get('/api/finance/summary')
      .query({ start: '2194-01-01', end: '2194-12-31' }).set(auth(par.token))
    expect(Number(live.body.totals.assessable_base)).toBeCloseTo(250, 2)

    const plateRefund = await refundMaybe(par, plate, 100)
    expect(plateRefund.status).toBe(200)
    const plateSettle = await settleMaybe(dio, subId)
    expect(plateSettle.settle.status).toBe(200)
    expect(Number(plateSettle.adj.assessable_impact)).toBeCloseTo(100, 2)
    expect(await payableBase(dio, 2194)).toBeCloseTo(400, 2)

    const restRefund = await refundMaybe(par, restricted, 80)
    expect(restRefund.status).toBe(200)
    const restSettle = await settleMaybe(dio, subId)
    expect(restSettle.settle.status).toBe(200)
    expect(Number(restSettle.adj.assessable_impact)).toBeCloseTo(0, 2)
    expect(await payableBase(dio, 2194)).toBeCloseTo(400, 2)
    expect(await payableBase(dio, 2194)).not.toBeCloseTo(320, 2)
  })

  it('B: missing map + live COA flipped off must not backfill T0 from live', async () => {
    // Frozen evidence: plate sat in assessable_base. Live COA is then
    // flipped off. A live-as-T0 read would stamp 0 AND agree with
    // COALESCE false — so this case cannot alone prove COALESCE. It
    // does prove they must not rewrite gift_assessable from the new
    // mapping, and must not treat live false as historical truth when
    // they also refuse the UNKNOWN (pair with attack A).
    const { dio, par } = await affiliatedPair('nolive')
    const gift = await chargedGift(par, 640.00, '2195-03-03')
    const subId = await approvedPeriod(dio, par, '2195-01-01', '2195-12-31')
    const before = await frozen(subId)
    expect(Number(before.totals_json?.totals?.assessable_base)).toBeCloseTo(640, 2)
    await stripGiftAssessable(subId)

    const flipOff = await request(server).put('/api/diocese/coa').set(auth(dio.token))
      .send({ accounts: [{ code: '4420', assessable: false, rollup_group: 'Offertory' }] })
    expect(flipOff.status).toBeLessThan(300)

    const live = await request(server).get('/api/finance/summary')
      .query({ start: '2195-01-01', end: '2195-12-31' }).set(auth(par.token))
    expect(Number(live.body.totals.assessable_base)).toBeCloseTo(0, 2)

    const refund = await refundMaybe(par, gift, 140)
    const { adj, settle } = await settleMaybe(dio, subId)

    const after = await frozen(subId)
    expect(after.totals_json.gift_assessable, 'must not backfill the freeze map from live COA').toBeUndefined()
    expect(Number(after.totals_json?.totals?.assessable_base)).toBeCloseTo(640, 2)
    expect(after.bytes.includes('"gift_assessable"')).toBe(false)
    expect(refund.status === 200 || refund.status >= 400).toBe(true)
    if (refund.status === 200) {
      assertUnknownImpact(adj)
      expect(settle?.status).toBe(409)
      expect(await payableBase(dio, 2195)).toBeCloseTo(640, 2)
    }
  })

  it('C: no migration backfills gift_assessable / assessable_impact from live COA', () => {
    const mig107 = src('migrations/107-period-adjustment-assessable-impact.js')
    const executable = mig107.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(executable).not.toMatch(/gift_assessable/)
    expect(executable).not.toMatch(/EFFECTIVE_COA|ochr_coa_accounts|ochr_coa_mappings/)
    expect(executable).not.toMatch(/UPDATE\s+ochr_report_submissions/i)
    expect(executable).not.toMatch(/UPDATE\s+ochr_period_adjustments[\s\S]*assessable_impact/i)
    expect(executable).toMatch(/DEFAULT 0/)

    const mig108 = src('migrations/108-period-adjustment-assessable-unknown.js')
    expect(mig108).not.toMatch(/EFFECTIVE_COA|ochr_coa_accounts|ochr_coa_mappings/)
    expect(mig108).toMatch(/ELSE NULL/)

    const refundSrc = src('routes/donations.js')
    expect(refundSrc).not.toMatch(/ochr_coa_accounts|ochr_coa_mappings|EFFECTIVE_COA/)

    const settleSrc = src('finance/periodAdjustmentSettle.js')
    expect(settleSrc).not.toMatch(/ochr_coa_accounts|ochr_coa_mappings|EFFECTIVE_COA|giftAssessableAtFreeze/)
    expect(settleSrc).toMatch(/assessable_unknown/)
  })

  it('D: settle does not rewrite totals_json; gift amount/date stay put', async () => {
    const { dio, par } = await affiliatedPair('arch')
    const gift = await chargedGift(par, 410.00, '2196-06-06')
    const subId = await approvedPeriod(dio, par, '2196-01-01', '2196-12-31')
    const snap = await frozen(subId)
    const giftBefore = await giftFact(gift)

    const refund = await refundMaybe(par, gift, 41)
    expect(refund.status).toBe(200)
    const { settle } = await settleMaybe(dio, subId)
    expect(settle.status).toBe(200)

    const after = await frozen(subId)
    expect(after.bytes, 'settle must not rewrite totals_json').toBe(snap.bytes)
    expect(after.status).toBe('approved')
    expect(await giftFact(gift)).toEqual(giftBefore)
    expect(giftBefore.amount).toBe('410.00')
    expect(giftBefore.date).toBe('2196-06-06')
  })

  it('source pin: refund COALESCE(missing gift_assessable, false) invents history', () => {
    const refundSrc = src('routes/donations.js')
    const coalesceFalse = /COALESCE\(\s*\([\s\S]*?gift_assessable[\s\S]*?\)::boolean,\s*false\s*\)/.test(refundSrc)
    const mentionsUnknown = /UNKNOWN|assessable_unknown|fail[-_ ]?clos/i.test(refundSrc)
    expect(
      coalesceFalse && !mentionsUnknown,
      'COALESCE(..., false) treats a missing freeze map as non-assessable',
    ).toBe(false)

    const mig107 = src('migrations/107-period-adjustment-assessable-impact.js')
    expect(mig107).toMatch(/DEFAULT 0/)
    expect(mig107).toMatch(/NOT NULL/)

    const mig108 = src('migrations/108-period-adjustment-assessable-unknown.js')
    expect(mig108).toMatch(/nullable|UNKNOWN is not 0/i)
  })
})
