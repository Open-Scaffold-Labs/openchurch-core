// R418-2 (TARS CHANGES NEEDED on #418 @ b87201de): the guarded diocesan
// steps checked for deposit adjustments and then wrote, while reversal
// approval could insert one in between. These tests hold a REAL second
// database connection open in the middle of the reversal-side code
// (closedPeriodsFor, the same function routes/deposits.js calls, then the
// adjustment INSERT) and fire the guarded step through the server's own
// pool, so the two sides race on two real connections with a fixed
// interleaving instead of a lucky one.
// Synthetic tenants only. Nothing here collects or sends money.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import pg from 'pg'
import 'dotenv/config'
import pool from '../src/db.js'
import { closedPeriodsFor } from '../src/finance/deposits.js'
import { lockAssessmentYearPeriods, lockSubmissionsForDepositCheck } from '../src/finance/depositAdjustmentGuard.js'
import { computeBases } from '../src/finance/assessmentBases.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'

let server
const cleanup = []
let ipSeq = 0
const ip = () => `10.142.${(ipSeq >> 8) & 255}.${(++ipSeq) & 255 || 1}`
const auth = t => ({ Authorization: `Bearer ${t}` })
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function signup(payload) {
  const res = await createOrg(server, payload, ip())
  expect(res.status).toBe(201)
  const org = res.body.user?.organization ?? res.body.organization
  cleanup.push(org.id)
  return { token: res.body.token, id: org.id }
}
async function pair(tag) {
  const dio = await signup({ organizationName: `R4182 ${tag} Diocese ${RUN_ID}`, name: 'Canon',
    email: `r4182_${tag}_dio_${RUN_ID}@example.com`, password: 'r4182-pw-dio', organizationType: 'diocese' })
  const email = `r4182_${tag}_par_${RUN_ID}@example.com`
  const par = await signup({ organizationName: `R4182 ${tag} Parish ${RUN_ID}`, name: 'Parish Admin', email, password: 'r4182-pw-par' })
  expect((await request(server).post('/api/diocese/parishes/invite').set(auth(dio.token)).send({ email })).status).toBeLessThan(300)
  expect((await request(server).post('/api/affiliation/accept').set(auth(par.token)).send({ grant_level: 'detail' })).status).toBe(200)
  return { dio, par }
}
async function submission(par, dio, start, end, status) {
  const { rows: [s] } = await pool.query(`INSERT INTO ochr_report_submissions
      (organization_id, diocese_org_id, period_start, period_end, status, totals_json)
    VALUES ($1,$2,$3,$4,$5,'{"totals":{"assessable_base":"1000.00"}}'::jsonb) RETURNING id`, [par.id, dio.id, start, end, status])
  return s.id
}
// The committed facts a reversal refers to (original + reversal).
async function facts(par, tag) {
  const { rows: [i] } = await pool.query(
    `INSERT INTO ochr_invoices (organization_id, title, category, payer_name, status, subtotal, total, issued_at)
     VALUES ($1, 'Hall', 'wedding', 'Synthetic Payer', 'issued', 100, 100, NOW()) RETURNING id`, [par.id])
  const { rows: [l] } = await pool.query(
    `INSERT INTO ochr_invoice_lines (organization_id, invoice_id, description, qty, unit_amount, amount, account_code, sort_order)
     VALUES ($1,$2,'Hall',1,100,100,'4710',0) RETURNING id`, [par.id, i.id])
  const pay = await request(server).post(`/api/invoices/${i.id}/payments`).set(auth(par.token))
    .send({ amount: 100, method: 'check', is_deposit: true })
  expect(pay.status).toBe(201)
  const fact = async (kind, rev, key) => (await pool.query(`INSERT INTO ochr_deposit_facts (organization_id, invoice_id, payment_id,
      invoice_line_id, kind, amount, account_code, effective_date, reverses_fact_id, idempotency_key, approval_mode)
    VALUES ($1,$2,$3,$4,$5,100,'4710',CURRENT_DATE,$6,$7,$8) RETURNING id`,
    [par.id, i.id, pay.body.id, l.id, kind, rev, key, kind === 'reversal' ? 'backfill' : 'none'])).rows[0].id
  const orig = await fact('applied', null, `r4182-o-${tag}-${RUN_ID}`)
  return { orig, rev: await fact('reversal', orig, `r4182-r-${tag}-${RUN_ID}`) }
}
// Reversal side, paused mid-transaction on its own connection: the real
// closedPeriodsFor (which takes the period lock), then the adjustment row.
async function reversalInFlight(par, sid, date, f) {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await c.connect()
  await c.query('BEGIN')
  const closed = await closedPeriodsFor(c, par.id, date)
  expect(closed).toContain(sid)
  await c.query(`INSERT INTO ochr_deposit_period_adjustments
      (organization_id, submission_id, fact_id, reversed_fact_id, amount, assessable_impact)
    VALUES ($1,$2,$3,$4,100,NULL)`, [par.id, sid, f.rev, f.orig])
  return c
}
// Has the request settled within `ms`?
async function settledWithin(p, ms) {
  let done = false
  p.then(() => { done = true }, () => { done = true })
  await sleep(ms)
  return done
}
const adjCount = async sid => (await pool.query(
  'SELECT COUNT(*)::int AS n FROM ochr_deposit_period_adjustments WHERE submission_id = $1', [sid])).rows[0].n
const statusOf = async sid => (await pool.query('SELECT status FROM ochr_report_submissions WHERE id = $1', [sid])).rows[0].status

let T1, T2
beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  T1 = await pair('t1'); T2 = await pair('t2')
}, 120_000)
afterAll(async () => {
  for (const id of cleanup.reverse()) {
    await pool.query('DELETE FROM ochr_assessments WHERE diocese_org_id = $1', [id]).catch(() => {})
    await pool.query('DELETE FROM ochr_report_submissions WHERE organization_id = $1 OR diocese_org_id = $1', [id]).catch(() => {})
    await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
  }
  await closeServer(server)
  await pool.end()
})

describe('R418-2: reversal approval and guarded steps share one period lock', () => {
  it('chancery approve racing a reversal on the same period: approve waits, then refuses; never approved with the adjustment', async () => {
    const { par, dio } = T1
    const sid = await submission(par, dio, '2025-09-01', '2025-09-30', 'submitted')
    const f = await facts(par, 'approve')
    const c = await reversalInFlight(par, sid, '2025-09-15', f)
    let approve, early
    try {
      approve = request(server).patch(`/api/diocese/submissions/${sid}`).set(auth(dio.token)).send({ status: 'approved' }).then(r => r)
      // The approve must not finish while the reversal holds the period.
      early = await settledWithin(approve, 400)
      await c.query('COMMIT')
    } finally {
      await c.query('ROLLBACK').catch(() => {}); await c.end()
    }
    const r = await approve
    // Invariant: an adjustment never sits on a period whose approval succeeded
    // past it.
    expect(await adjCount(sid)).toBe(1)
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('deposit_adjustments_pending')
    expect(await statusOf(sid)).toBe('submitted')
    // And it waited for the reversal rather than racing past it.
    expect(early).toBe(false)
  })

  it('assessment publish racing a reversal on an approved period of that year: publish waits, then refuses', async () => {
    const { par, dio } = T2
    const sid = await submission(par, dio, '2023-03-01', '2023-03-31', 'approved')
    const draft = await request(server).post('/api/diocese/assessments').set(auth(dio.token)).send({ fiscal_year: '2023', rate_bps: 500 })
    expect(draft.status).toBe(201)
    const f = await facts(par, 'publish')
    const c = await reversalInFlight(par, sid, '2023-03-15', f)
    let publish, early
    try {
      publish = request(server).patch(`/api/diocese/assessments/${draft.body.id}`).set(auth(dio.token)).send({ status: 'published' }).then(r => r)
      early = await settledWithin(publish, 400)
      await c.query('COMMIT')
    } finally {
      await c.query('ROLLBACK').catch(() => {}); await c.end()
    }
    const r = await publish
    expect(await adjCount(sid)).toBe(1)
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('deposit_adjustments_pending')
    const { rows: [a] } = await pool.query('SELECT status FROM ochr_assessments WHERE id = $1', [draft.body.id])
    expect(a.status).toBe('draft')
    expect(early).toBe(false)
  })

  it('a reversal held past the lock budget fails cleanly with 503 deposit_lock_busy (bounded, nothing written)', async () => {
    const { par, dio } = T1
    const sid = await submission(par, dio, '2025-10-01', '2025-10-31', 'submitted')
    const c = await reversalInFlight(par, sid, '2025-10-15', await facts(par, 'busy'))
    try {
      const t0 = Date.now()
      const r = await request(server).patch(`/api/diocese/submissions/${sid}`).set(auth(dio.token)).send({ status: 'approved' })
      expect(r.status).toBe(503)
      expect(r.body.code).toBe('deposit_lock_busy')
      expect(Date.now() - t0).toBeLessThan(6000)
    } finally {
      await c.query('ROLLBACK'); await c.end()
    }
    expect(await statusOf(sid)).toBe('submitted')
    expect(await adjCount(sid)).toBe(0)
  })
})

// R418-3 (TARS CHANGES @ 55132720): the assessment-year lock covered only
// already-approved rows, so a concurrent chancery approval could change the
// eligible set under it; and create/recompute read bases through the pool,
// not the locked transaction. Each case pauses one side on a REAL second
// connection at a fixed point and fires the other through the server.
describe('R418-3: chancery approval and assessment build serialize on the year', () => {
  const lineBase = async (aid, parishId) => (await pool.query(
    'SELECT base FROM ochr_assessment_lines WHERE assessment_id = $1 AND parish_org_id = $2', [aid, parishId])).rows[0]?.base
  // Approval side, paused after its row lock and status write, uncommitted.
  async function approvalInFlight(dio, sid) {
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await c.connect()
    await c.query('BEGIN')
    await lockSubmissionsForDepositCheck(c, 's.id = $1 AND s.diocese_org_id = $2', [sid, dio.id])
    await c.query(`UPDATE ochr_report_submissions SET status = 'approved' WHERE id = $1`, [sid])
    return c
  }

  it('assessment holding the year: a chancery approval of a submitted period in that year waits for it', async () => {
    const { par, dio } = T1
    const sid = await submission(par, dio, '2022-05-01', '2022-05-31', 'submitted')
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await c.connect()
    let approve, early, basesInTx
    try {
      await c.query('BEGIN')
      await lockAssessmentYearPeriods(c, { dioceseOrgId: dio.id, year: '2022' })
      approve = request(server).patch(`/api/diocese/submissions/${sid}`).set(auth(dio.token)).send({ status: 'approved' }).then(r => r)
      early = await settledWithin(approve, 400)
      basesInTx = await computeBases(dio.id, '2022', c)
      await c.query('COMMIT')
    } finally {
      await c.query('ROLLBACK').catch(() => {}); await c.end()
    }
    const r = await approve
    expect(early).toBe(false)
    // The bill built under the lock did not see a period approved mid-build.
    expect(basesInTx.find(b => b.parish_org_id === par.id)).toBeUndefined()
    expect(r.status).toBe(200)
    expect(await statusOf(sid)).toBe('approved')
  })

  it('assessment create racing an in-flight approval: create waits, then bills the approved period', async () => {
    const { par, dio } = T2
    const sid = await submission(par, dio, '2021-05-01', '2021-05-31', 'submitted')
    const c = await approvalInFlight(dio, sid)
    let create, early
    try {
      create = request(server).post('/api/diocese/assessments').set(auth(dio.token)).send({ fiscal_year: '2021', rate_bps: 500 }).then(r => r)
      early = await settledWithin(create, 400)
      await c.query('COMMIT')
    } finally {
      await c.query('ROLLBACK').catch(() => {}); await c.end()
    }
    const r = await create
    expect(r.status).toBe(201)
    expect(early).toBe(false)
    expect(Number(await lineBase(r.body.id, par.id))).toBe(1000)
  })

  it('assessment recompute racing an in-flight approval: recompute waits, then bills the approved period', async () => {
    const { par, dio } = T1
    const draft = await request(server).post('/api/diocese/assessments').set(auth(dio.token)).send({ fiscal_year: '2020', rate_bps: 500 })
    expect(draft.status).toBe(201)
    const sid = await submission(par, dio, '2020-05-01', '2020-05-31', 'submitted')
    const c = await approvalInFlight(dio, sid)
    let rec, early
    try {
      rec = request(server).post(`/api/diocese/assessments/${draft.body.id}/recompute`).set(auth(dio.token)).send({}).then(r => r)
      early = await settledWithin(rec, 400)
      await c.query('COMMIT')
    } finally {
      await c.query('ROLLBACK').catch(() => {}); await c.end()
    }
    const r = await rec
    expect(r.status).toBeLessThan(300)
    expect(early).toBe(false)
    expect(Number(await lineBase(draft.body.id, par.id))).toBe(1000)
  })
})
