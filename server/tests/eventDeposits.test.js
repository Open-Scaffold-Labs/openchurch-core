// 130 — event deposits (José, 25 Oct 2026, 8:30 PM PT, Ledger's defaults).
// Real Postgres, synthetic tenants. Accounting only: nothing here collects
// or sends money.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import pg from 'pg'
import 'dotenv/config'
import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'

const PW = 'dep130-test-pw'
let server, A, B, S, admin2, staff1, donationsAtStart
let ipSeq = 1
const nextIp = () => `10.130.${(ipSeq >> 8) & 255}.${(ipSeq++) & 255 || 1}`
const auth = t => ({ Authorization: `Bearer ${t}` })

async function signup(tag) {
  const email = `dep130_${tag}_${RUN_ID}@example.com`
  const r = await createOrg(server, { organizationName: `DEP130 ${tag} ${RUN_ID}`, name: `Admin ${tag}`, email, password: PW }, nextIp())
  expect(r.status).toBe(201)
  return { id: r.body.user.organization.id, userId: r.body.user.id, token: r.body.token, name: `Admin ${tag}` }
}
async function addUser(org, role, name, tag) {
  const email = `dep130_${tag}_${RUN_ID}@example.com`
  const c = await request(server).post('/api/users').set(auth(org.token)).set('X-Forwarded-For', nextIp())
    .send({ name, email, password: PW, role })
  expect(c.status).toBe(201)
  const l = await request(server).post('/api/auth/login').set('X-Forwarded-For', nextIp()).send({ email, password: PW })
  expect(l.status).toBe(200)
  return { id: l.body.user.id, token: l.body.token, name }
}

// An issued invoice with a hall line (4710) and an unclassified wedding line.
async function invoice(org, { hall = 300, wedding = 200, weddingCode = null } = {}) {
  const total = hall + wedding
  const { rows: [i] } = await pool.query(
    `INSERT INTO ochr_invoices (organization_id, title, category, payer_name, status, subtotal, total, issued_at)
     VALUES ($1, 'Wedding + hall', 'wedding', 'Synthetic Payer', 'issued', $2, $2, NOW()) RETURNING id`,
    [org.id, total])
  const { rows: lines } = await pool.query(
    `INSERT INTO ochr_invoice_lines (organization_id, invoice_id, description, qty, unit_amount, amount, account_code, sort_order)
     VALUES ($1, $2, 'Hall', 1, $3, $3, '4710', 0), ($1, $2, 'Wedding', 1, $4, $4, $5, 1)
     RETURNING id, description`, [org.id, i.id, hall, wedding, weddingCode])
  return { id: i.id, hall: lines.find(l => l.description === 'Hall').id, wedding: lines.find(l => l.description === 'Wedding').id }
}
async function deposit(org, inv, amount, who = org) {
  const r = await request(server).post(`/api/invoices/${inv.id}/payments`).set(auth(who.token))
    .send({ amount, method: 'check', is_deposit: true })
  expect(r.status).toBe(201)
  return r.body.id
}
const apply = (who, pid, allocations, key) => request(server).post(`/api/deposits/payments/${pid}/apply`)
  .set(auth(who.token)).send({ allocations, idempotency_key: key })
const ask = (who, pid, body) => request(server).post(`/api/deposits/payments/${pid}/requests`).set(auth(who.token)).send(body)
const approve = (who, rid, body = {}) => request(server).post(`/api/deposits/requests/${rid}/approve`).set(auth(who.token)).send(body)
const position = async (who, pid) => (await request(server).get(`/api/deposits/payments/${pid}`).set(auth(who.token))).body.position
const ledger2300 = async orgId => (await pool.query(
  `SELECT COALESCE(SUM(amount),0)::numeric(12,2)::text AS n FROM ochr_parish_ledger WHERE organization_id = $1 AND account_code = '2300'`, [orgId])).rows[0].n

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  A = await signup('a')
  B = await signup('b')
  S = await signup('solo')
  admin2 = await addUser(A, 'admin', 'Admin Two', 'a2')
  staff1 = await addUser(A, 'staff', 'Staff One', 's1')
  donationsAtStart = (await pool.query(`SELECT COUNT(*)::int AS n FROM ochr_donation_live WHERE organization_id = $1`, [A.id])).rows[0].n
}, 90_000)

afterAll(async () => {
  for (const id of [A?.id, B?.id, S?.id]) if (id) await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
  await closeServer(server)
  await pool.end()
})

describe('130 migration', () => {
  it('follows 129, re-runs as a no-op, and is tenant-composite with RLS', async () => {
    const { MIGRATION_NAMES, EXPECTED_MIGRATION } = await import('../src/migrations/names.js')
    expect(EXPECTED_MIGRATION).toBe('144-online-giving-clearing')
    expect(MIGRATION_NAMES[MIGRATION_NAMES.indexOf('130-event-deposits') - 1]).toBe('129-cutover-signoffs')
    const { up } = await import('../src/migrations/130-event-deposits.js')
    await up(); await up()
    const rls = await pool.query(`SELECT relname, relrowsecurity FROM pg_class WHERE relname = ANY($1)`,
      [['ochr_deposit_facts', 'ochr_deposit_requests', 'ochr_invoice_payment_refunds', 'ochr_deposit_period_adjustments']])
    expect(rls.rows).toHaveLength(4)
    expect(rls.rows.every(r => r.relrowsecurity)).toBe(true)
    const coa = await pool.query(`SELECT code, acct_type, rollup_group, assessable FROM ochr_coa_accounts
      WHERE organization_id IS NULL AND code IN ('2300','4920') ORDER BY code`)
    expect(coa.rows).toEqual([
      { code: '2300', acct_type: 'liability', rollup_group: 'Deferred', assessable: false },
      { code: '4920', acct_type: 'revenue', rollup_group: 'Other Revenue', assessable: false },
    ])
    const v = await pool.query(`SELECT reloptions FROM pg_class WHERE relname = 'ochr_parish_ledger'`)
    expect(String(v.rows[0].reloptions)).toMatch(/security_invoker=(true|on)/)
  })

  it('backfills in-place invoice refunds and deposits into append-only records without losing data', async () => {
    const inv = await invoice(A)
    const { rows: [p1] } = await pool.query(
      `INSERT INTO ochr_invoice_payments (organization_id, invoice_id, amount, method, is_deposit, received_at, refunded_at, refund_ref)
       VALUES ($1,$2,40,'cash',FALSE,'2026-03-01','2026-03-05','legacy-ref-1') RETURNING id`, [A.id, inv.id])
    const { rows: [p2] } = await pool.query(
      `INSERT INTO ochr_invoice_payments (organization_id, invoice_id, amount, method, is_deposit, received_at, refunded_at)
       VALUES ($1,$2,60,'check',TRUE,'2026-03-02','2026-03-06') RETURNING id`, [A.id, inv.id])
    const { rows: [p3] } = await pool.query(
      `INSERT INTO ochr_invoice_payments (organization_id, invoice_id, amount, method, is_deposit, received_at)
       VALUES ($1,$2,25,'check',TRUE,'2026-03-03') RETURNING id`, [A.id, inv.id])
    const { up } = await import('../src/migrations/130-event-deposits.js')
    await up(); await up()
    const r = await pool.query(`SELECT amount::text, refund_ref, source, refunded_at::date::text AS d
      FROM ochr_invoice_payment_refunds WHERE payment_id = $1`, [p1.id])
    expect(r.rows).toEqual([{ amount: '40.00', refund_ref: 'legacy-ref-1', source: 'backfill', d: '2026-03-05' }])
    const f = await pool.query(`SELECT payment_id, kind, amount::text, to_char(effective_date,'YYYY-MM-DD') AS d, approval_mode
      FROM ochr_deposit_facts WHERE payment_id = ANY($1) ORDER BY payment_id, id`, [[p2.id, p3.id]])
    expect(f.rows).toEqual([
      { payment_id: p2.id, kind: 'received', amount: '60.00', d: '2026-03-02', approval_mode: 'none' },
      { payment_id: p2.id, kind: 'refunded', amount: '60.00', d: '2026-03-06', approval_mode: 'backfill' },
      { payment_id: p3.id, kind: 'received', amount: '25.00', d: '2026-03-03', approval_mode: 'none' },
    ])
    // Legacy columns untouched.
    const legacy = await pool.query(`SELECT refunded_at IS NOT NULL AS r, refund_ref FROM ochr_invoice_payments WHERE id = $1`, [p1.id])
    expect(legacy.rows[0]).toEqual({ r: true, refund_ref: 'legacy-ref-1' })
  })
})

describe('receive and apply (staff-confirmed)', () => {
  it('holds a deposit in 2300, then moves it to each line\'s own income account only when staff confirm', async () => {
    const inv = await invoice(A, { weddingCode: '4220' })
    const pid = await deposit(A, inv, 250, staff1)
    expect(await position(A, pid)).toMatchObject({ received: '250.00', held: '250.00', applied: '0.00' })
    // Nothing moves on its own.
    const before = await pool.query(`SELECT kind FROM ochr_deposit_facts WHERE payment_id = $1`, [pid])
    expect(before.rows.map(r => r.kind)).toEqual(['received'])

    const a = await apply(staff1, pid, [{ line_id: inv.hall, amount: 150 }, { line_id: inv.wedding, amount: 100 }], `ap-${pid}`)
    expect(a.status).toBe(201)
    expect(a.body.position).toMatchObject({ held: '0.00', applied: '250.00' })
    const rows = (await pool.query(`SELECT account_code, source_type, amount::text FROM ochr_parish_ledger
      WHERE organization_id = $1 AND source_type LIKE 'deposit%' AND source_id IN
        (SELECT id FROM ochr_deposit_facts WHERE payment_id = $2) ORDER BY source_id, source_type`, [A.id, pid])).rows
    expect(rows).toEqual([
      { account_code: '2300', source_type: 'deposit_held', amount: '250.00' },
      { account_code: '2300', source_type: 'deposit_held', amount: '-150.00' },
      { account_code: '4710', source_type: 'deposit_income', amount: '150.00' },
      { account_code: '2300', source_type: 'deposit_held', amount: '-100.00' },
      { account_code: '4220', source_type: 'deposit_income', amount: '100.00' },
    ])
    // Same key replays; nothing new.
    const again = await apply(staff1, pid, [{ line_id: inv.hall, amount: 150 }, { line_id: inv.wedding, amount: 100 }], `ap-${pid}`)
    expect(again.status).toBe(200)
    expect(again.body.replayed).toBe(true)
    expect((await pool.query(`SELECT COUNT(*)::int AS n FROM ochr_deposit_facts WHERE payment_id = $1`, [pid])).rows[0].n).toBe(3)
  })

  it('refuses a wedding line with no income account — offering vs fee is not defaulted', async () => {
    const inv = await invoice(A)
    const pid = await deposit(A, inv, 100)
    const r = await apply(staff1, pid, [{ line_id: inv.wedding, amount: 100 }], `noacct-${pid}`)
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('income_account_required')
    expect(r.body.error).toMatch(/pastor/)
    expect(await position(A, pid)).toMatchObject({ held: '100.00', applied: '0.00' })
  })

  it('double-apply under controlled concurrency: exactly one wins, held never goes negative', async () => {
    const inv = await invoice(A, { weddingCode: '4220' })
    const pid = await deposit(A, inv, 200)
    const results = await Promise.all([1, 2, 3, 4].map(n =>
      apply(staff1, pid, [{ line_id: inv.hall, amount: 200 }], `race-${pid}-${n}`)))
    expect(results.filter(r => r.status === 201)).toHaveLength(1)
    expect(results.filter(r => r.status === 409)).toHaveLength(3)
    expect(await position(A, pid)).toMatchObject({ held: '0.00', applied: '200.00' })
  })

  it('over-application trigger refuses direct inserts even with two raw connections racing', async () => {
    const inv = await invoice(A, { weddingCode: '4220' })
    const pid = await deposit(A, inv, 100)
    const c1 = new pg.Client({ connectionString: process.env.DATABASE_URL })
    const c2 = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await c1.connect(); await c2.connect()
    const ins = (c, n) => c.query(`INSERT INTO ochr_deposit_facts (organization_id, invoice_id, payment_id, invoice_line_id,
        kind, amount, account_code, effective_date, idempotency_key)
      VALUES ($1,$2,$3,$4,'applied',80,'4710',CURRENT_DATE,$5)`, [A.id, inv.id, pid, inv.hall, `raw-${pid}-${n}`])
    try {
      await c1.query('BEGIN'); await c2.query('BEGIN')
      await ins(c1, 1)
      const second = ins(c2, 2).then(() => 'ok', e => e.code)   // blocks on the payment row lock
      await c1.query('COMMIT')
      expect(await second).toBe('23514')
      await c2.query('ROLLBACK')
    } finally { await c1.end(); await c2.end() }
    expect(await position(A, pid)).toMatchObject({ applied: '80.00', held: '20.00' })
    // Append-only: no UPDATE, no direct DELETE.
    await expect(pool.query(`UPDATE ochr_deposit_facts SET amount = 1 WHERE payment_id = $1`, [pid])).rejects.toMatchObject({ code: '55000' })
    await expect(pool.query(`DELETE FROM ochr_deposit_facts WHERE payment_id = $1`, [pid])).rejects.toMatchObject({ code: '55000' })
  })
})

describe('tenant scoping', () => {
  it('another parish cannot read, apply to, or request on this deposit; a cross-tenant line is refused', async () => {
    const inv = await invoice(A, { weddingCode: '4220' })
    const pid = await deposit(A, inv, 100)
    expect((await request(server).get(`/api/deposits/payments/${pid}`).set(auth(B.token))).status).toBe(404)
    expect((await apply(B, pid, [{ line_id: inv.hall, amount: 10 }], `x-${pid}`)).status).toBe(404)
    expect((await ask(B, pid, { kind: 'refund', amount: 10, reason: 'x' })).status).toBe(404)
    const sched = await request(server).get('/api/deposits/schedule').set(auth(B.token))
    expect(sched.body.deposits.some(d => d.payment_id === pid)).toBe(false)
    // Database says the same: an A payment cannot carry a B org id.
    await expect(pool.query(`INSERT INTO ochr_deposit_facts (organization_id, invoice_id, payment_id, kind, amount,
        account_code, effective_date, idempotency_key) VALUES ($1,$2,$3,'received',1,'2300',CURRENT_DATE,'xt')`,
      [B.id, inv.id, pid])).rejects.toMatchObject({ code: '23503' })
  })
})

describe('refund / forfeit / reversal approvals', () => {
  it('a refund needs an admin who is not the requester; self-approval is refused in a multi-admin parish', async () => {
    const inv = await invoice(A)
    const pid = await deposit(A, inv, 120)
    const r = await ask(A, pid, { kind: 'refund', amount: 120, reason: 'Wedding cancelled' })
    expect(r.status).toBe(201)
    const self = await approve(A, r.body.request.id, { single_admin_reason: 'I am sure' })
    expect(self.status).toBe(403)
    expect(self.body.code).toBe('own_request')
    expect(await position(A, pid)).toMatchObject({ refunded: '0.00', held: '120.00' })
    expect((await approve(staff1, r.body.request.id)).status).toBe(403)   // staff cannot approve
    const ok = await approve(admin2, r.body.request.id)
    expect(ok.status).toBe(200)
    expect(ok.body.fact).toMatchObject({ kind: 'refunded', amount: '120.00', approval_mode: 'second_admin', approved_by_name: 'Admin Two' })
    expect(await position(A, pid)).toMatchObject({ refunded: '120.00', held: '0.00' })
    const inv2 = await request(server).get(`/api/invoices/${inv.id}`).set(auth(A.token))
    expect(inv2.body.amount_paid).toBe('0.00')
    expect(inv2.body.payments.find(p => p.id === pid).refunded_at).toBeTruthy()
    // The legacy in-place route refuses deposits.
    const legacy = await request(server).post(`/api/invoices/${inv.id}/payments/${pid}/refund`).set(auth(A.token)).send({})
    expect(legacy.status).toBe(409)
  })

  it('forfeit books 2300 → 4920 after second-admin approval', async () => {
    const inv = await invoice(A)
    const pid = await deposit(A, inv, 90)
    const r = await ask(staff1, pid, { kind: 'forfeit', amount: 30, reason: 'Cancelled inside 30 days per hall policy' })
    const ok = await approve(A, r.body.request.id)
    expect(ok.status).toBe(200)
    const l = await pool.query(`SELECT account_code, amount::text FROM ochr_parish_ledger
      WHERE source_type LIKE 'deposit%' AND source_id = $1 ORDER BY account_code`, [ok.body.fact.id])
    expect(l.rows).toEqual([{ account_code: '2300', amount: '-30.00' }, { account_code: '4920', amount: '30.00' }])
    expect(await position(A, pid)).toMatchObject({ forfeited: '30.00', held: '60.00' })
  })

  it('a one-admin parish may approve its own request only with a typed reason', async () => {
    const inv = await invoice(S)
    const pid = await deposit(S, inv, 50)
    const r = await ask(S, pid, { kind: 'refund', amount: 50, reason: 'Family moved the date away' })
    const bare = await approve(S, r.body.request.id)
    expect(bare.status).toBe(403)
    const ok = await approve(S, r.body.request.id, { single_admin_reason: 'Only admin in the parish; pastor agreed by phone' })
    expect(ok.status).toBe(200)
    expect(ok.body.fact.approval_mode).toBe('single_admin')
    expect(ok.body.fact.reason).toMatch(/single-admin approval: Only admin/)
  })

  it('reversal: a correction is a new row; an original in a closed diocesan period is reversed TODAY with an UNKNOWN adjustment', async () => {
    const inv = await invoice(A, { weddingCode: '4220' })
    const pid = await deposit(A, inv, 100)
    const { rows: [applied] } = await pool.query(`INSERT INTO ochr_deposit_facts (organization_id, invoice_id, payment_id,
        invoice_line_id, kind, amount, account_code, effective_date, recorded_by_user_id, idempotency_key)
      VALUES ($1,$2,$3,$4,'applied',100,'4710','2026-01-15',$5,$6) RETURNING id`, [A.id, inv.id, pid, inv.hall, staff1.id, `old-${pid}`])
    const { rows: [sub] } = await pool.query(`INSERT INTO ochr_report_submissions
        (organization_id, diocese_org_id, period_start, period_end, status, totals_json)
      VALUES ($1,$2,'2026-01-01','2026-01-31','approved','{}'::jsonb) RETURNING id`, [A.id, B.id])
    const r = await ask(staff1, pid, { kind: 'reversal', target_fact_id: applied.id, reason: 'Applied to the wrong line' })
    expect(r.status).toBe(201)
    const ok = await approve(admin2, r.body.request.id)
    expect(ok.status).toBe(200)
    const today = (await pool.query(`SELECT to_char(CURRENT_DATE,'YYYY-MM-DD') AS d`)).rows[0].d
    expect(ok.body.fact).toMatchObject({ kind: 'reversal', reverses_fact_id: applied.id, effective_date: today })
    expect(ok.body.period_adjustments).toEqual([expect.objectContaining({ submission_id: sub.id, amount: '100.00', assessable_impact: null })])
    // Original untouched.
    const orig = await pool.query(`SELECT to_char(effective_date,'YYYY-MM-DD') AS d, amount::text FROM ochr_deposit_facts WHERE id = $1`, [applied.id])
    expect(orig.rows[0]).toEqual({ d: '2026-01-15', amount: '100.00' })
    expect(await position(A, pid)).toMatchObject({ applied: '0.00', held: '100.00' })
    // One reversal per fact.
    const twice = await ask(staff1, pid, { kind: 'reversal', target_fact_id: applied.id, reason: 'again' })
    expect((await approve(admin2, twice.body.request.id)).status).toBe(409)
  })

  it('the admin who recorded a fact cannot approve its reversal in a multi-admin parish', async () => {
    const inv = await invoice(A, { weddingCode: '4220' })
    const pid = await deposit(A, inv, 40)
    const a = await apply(admin2, pid, [{ line_id: inv.hall, amount: 40 }], `own-${pid}`)
    const r = await ask(staff1, pid, { kind: 'reversal', target_fact_id: a.body.facts[0].id, reason: 'wrong' })
    const no = await approve(admin2, r.body.request.id)
    expect(no.status).toBe(403)
    expect(no.body.code).toBe('own_fact')
  })
})

describe('schedule, giving statements, scoreboard', () => {
  it('the deposits-held schedule reconciles to the 2300 balance and names any difference', async () => {
    const s = await request(server).get('/api/deposits/schedule').set(auth(A.token))
    expect(s.status).toBe(200)
    expect(s.body.totals.ledger_2300).toBe(await ledger2300(A.id))
    expect(s.body.totals.reconciled).toBe(true)
    expect(s.body.totals.difference).toBe('0.00')
    // A manual entry on 2300 shows up as a named reconciling line.
    await pool.query(`INSERT INTO ochr_ledger_entries (organization_id, entry_date, account_code, amount, source_type, memo)
      VALUES ($1, CURRENT_DATE, '2300', 5, 'manual', 'synthetic')`, [A.id])
    const s2 = await request(server).get('/api/deposits/schedule').set(auth(A.token))
    expect(s2.body.totals).toMatchObject({ reconciled: false, difference: '5.00', other_entries_on_2300: '5.00' })
  })

  it('deposits never appear on giving statements or donor totals', async () => {
    // Every deposit this file recorded is absent from the donation book that
    // statements and donor totals read.
    const n = await pool.query(`SELECT COUNT(*)::int AS n FROM ochr_donation_live WHERE organization_id = $1`, [A.id])
    expect(n.rows[0].n).toBe(donationsAtStart)
    const st = await pool.query(`SELECT pg_get_viewdef('ochr_donation_live', true) AS d`)
    expect(st.rows[0].d).not.toMatch(/deposit|invoice/)
  })

  it('the cutover scoreboard deposits line (rollup Deferred) includes 2300', async () => {
    const { SCOREBOARD_LINES } = await import('../src/finance/cutover.js')
    expect(SCOREBOARD_LINES.find(l => l.key === 'deposits').rollup).toBe('Deferred')
    const c = await pool.query(`SELECT rollup_group FROM ochr_coa_accounts WHERE organization_id IS NULL AND code = '2300'`)
    expect(c.rows[0].rollup_group).toBe('Deferred')
  })
})
