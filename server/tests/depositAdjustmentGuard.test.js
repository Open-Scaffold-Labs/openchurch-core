// R418-1 (TARS HOLD on #418 @ 7eb830ef): deposit adjustments recorded by
// migration 130 are not in the diocesan rollup, the settle flow or the
// assessment bases. Until they are, a period carrying one must not be
// resubmitted, approved, settled or assessed. Fail closed, tenant-scoped.
// Real Postgres, synthetic tenants. Nothing here collects or sends money.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'
import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'

let server
const cleanup = []
let ipSeq = 0
const ip = () => `10.141.${(ipSeq >> 8) & 255}.${(++ipSeq) & 255 || 1}`
const auth = t => ({ Authorization: `Bearer ${t}` })

async function signup(payload) {
  const res = await createOrg(server, payload, ip())
  expect(res.status).toBe(201)
  const org = res.body.user?.organization ?? res.body.organization
  cleanup.push(org.id)
  return { token: res.body.token, id: org.id }
}
async function parishOf(dio, tag) {
  const email = `r4181_${tag}_par_${RUN_ID}@example.com`
  const par = await signup({ organizationName: `R4181 ${tag} Parish ${RUN_ID}`, name: 'Parish Admin', email, password: 'r4181-pw-par' })
  const inv = await request(server).post('/api/diocese/parishes/invite').set(auth(dio.token)).send({ email })
  expect(inv.status).toBeLessThan(300)
  const acc = await request(server).post('/api/affiliation/accept').set(auth(par.token)).send({ grant_level: 'detail' })
  expect(acc.status).toBe(200)
  return par
}
const diocese = tag => signup({
  organizationName: `R4181 ${tag} Diocese ${RUN_ID}`, name: 'Canon',
  email: `r4181_${tag}_dio_${RUN_ID}@example.com`, password: 'r4181-pw-dio', organizationType: 'diocese',
})

async function submission(par, dio, start, end, status) {
  const { rows: [s] } = await pool.query(`INSERT INTO ochr_report_submissions
      (organization_id, diocese_org_id, period_start, period_end, status, totals_json)
    VALUES ($1,$2,$3,$4,$5,'{"totals":{"assessable_base":"1000.00"}}'::jsonb) RETURNING id`, [par.id, dio.id, start, end, status])
  return s.id
}
// One deposit adjustment row against a closed period, as approve-reversal writes it.
async function depositAdjustment(par, submissionId) {
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
  const orig = await fact('applied', null, `r4181-o-${submissionId}`)
  const rev = await fact('reversal', orig, `r4181-r-${submissionId}`)
  await pool.query(`INSERT INTO ochr_deposit_period_adjustments
      (organization_id, submission_id, fact_id, reversed_fact_id, amount, assessable_impact)
    VALUES ($1,$2,$3,$4,100,NULL)`, [par.id, submissionId, rev, orig])
}
const status = async id => (await pool.query('SELECT status FROM ochr_report_submissions WHERE id = $1', [id])).rows[0].status
const approve = (dio, id) => request(server).patch(`/api/diocese/submissions/${id}`).set(auth(dio.token)).send({ status: 'approved' })
const submit = (par, start, end) => request(server).post('/api/finance/submissions').set(auth(par.token)).send({ period_start: start, period_end: end })
const PENDING = { code: 'deposit_adjustments_pending' }

let D1, D2, P1, P1b, P2
beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  D1 = await diocese('d1'); D2 = await diocese('d2')
  P1 = await parishOf(D1, 'p1'); P1b = await parishOf(D1, 'p1b'); P2 = await parishOf(D2, 'p2')
}, 120_000)
afterAll(async () => {
  for (const id of cleanup.reverse()) {
    await pool.query('DELETE FROM ochr_report_submissions WHERE organization_id = $1 OR diocese_org_id = $1', [id]).catch(() => {})
    await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
  }
  await closeServer(server)
  await pool.end()
})

describe('R418-1: unincorporated deposit adjustments block the diocesan workflow', () => {
  it('a returned period with a deposit adjustment cannot be resubmitted; an unaffected period still submits', async () => {
    const sid = await submission(P1, D1, '2025-01-01', '2025-01-31', 'returned')
    await depositAdjustment(P1, sid)
    const r = await submit(P1, '2025-01-01', '2025-01-31')
    expect(r.status).toBe(409)
    expect(r.body).toMatchObject(PENDING)
    expect(r.body.error).toMatch(/deposit adjustments that aren't in the diocesan rollup yet/)
    expect(await status(sid)).toBe('returned')

    const ok = await submit(P1, '2025-03-01', '2025-03-31')
    expect(ok.status).toBe(201)
  })

  it('the chancery cannot approve a period with a deposit adjustment; returning it and approving others still work', async () => {
    const sid = await submission(P1, D1, '2025-02-01', '2025-02-28', 'submitted')
    await depositAdjustment(P1, sid)
    const r = await approve(D1, sid)
    expect(r.status).toBe(409)
    expect(r.body).toMatchObject(PENDING)
    expect(await status(sid)).toBe('submitted')

    const clean = await submission(P1, D1, '2025-04-01', '2025-04-30', 'submitted')
    expect((await approve(D1, clean)).status).toBe(200)

    const ret = await request(server).patch(`/api/diocese/submissions/${sid}`).set(auth(D1.token)).send({ status: 'returned', note: 'deposit fix' })
    expect(ret.status).toBe(200)
  })

  it('settling a period that carries a deposit adjustment is refused', async () => {
    const sid = await submission(P1, D1, '2025-05-01', '2025-05-31', 'approved')
    await depositAdjustment(P1, sid)
    const all = await request(server).post(`/api/diocese/submissions/${sid}/adjustments/settle`).set(auth(D1.token)).send({})
    expect(all.status).toBe(409)
    expect(all.body).toMatchObject(PENDING)
    // A clean approved period answers with its ordinary reason, not ours.
    const clean = await submission(P1, D1, '2025-06-01', '2025-06-30', 'approved')
    const c = await request(server).post(`/api/diocese/submissions/${clean}/adjustments/settle`).set(auth(D1.token)).send({})
    expect(c.body.code).not.toBe('deposit_adjustments_pending')
  })

  it('an assessment cannot be built from a year with an unincorporated deposit adjustment', async () => {
    const sid = await submission(P1, D1, '2024-07-01', '2024-07-31', 'approved')
    await depositAdjustment(P1, sid)
    const r = await request(server).post('/api/diocese/assessments').set(auth(D1.token)).send({ fiscal_year: '2024', rate_bps: 500 })
    expect(r.status).toBe(409)
    expect(r.body).toMatchObject(PENDING)
    // Another diocese's year is untouched.
    await submission(P2, D2, '2024-07-01', '2024-07-31', 'approved')
    const ok = await request(server).post('/api/diocese/assessments').set(auth(D2.token)).send({ fiscal_year: '2024', rate_bps: 500 })
    expect(ok.status).toBe(201)
  })

  it('tenant isolation: another parish or diocese with an adjustment does not block this one', async () => {
    // P1 has adjustments on Jan and Feb. A sibling parish in the same
    // diocese, same dates, is unaffected.
    const sib = await submission(P1b, D1, '2025-01-01', '2025-01-31', 'returned')
    const re = await submit(P1b, '2025-01-01', '2025-01-31')
    expect(re.status).toBe(201)
    expect((await approve(D1, sib)).status).toBe(200)
    // Another diocese's parish, same dates, with its own adjustment on a
    // different period, still submits and gets approved.
    const other = await submission(P2, D2, '2025-08-01', '2025-08-31', 'approved')
    await depositAdjustment(P2, other)
    const p2 = await submission(P2, D2, '2025-02-01', '2025-02-28', 'submitted')
    expect((await approve(D2, p2)).status).toBe(200)
    // And P2's adjustment does not block P1's clean period.
    const p1 = await submission(P1, D1, '2025-08-01', '2025-08-31', 'submitted')
    expect((await approve(D1, p1)).status).toBe(200)
    // A diocese cannot even probe another diocese's submission: 404-shaped, not ours.
    const cross = await approve(D2, p1)
    expect(cross.body.code).not.toBe('deposit_adjustments_pending')
  })
})
