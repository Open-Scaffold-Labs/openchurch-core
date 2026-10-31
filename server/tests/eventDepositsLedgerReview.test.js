// 130 — Ledger review of #415 @ 12c2b1d9: regressions for P2-1..P3-4.
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
let server, A, admin2, staff1
let ipSeq = 1
const nextIp = () => `10.131.${(ipSeq >> 8) & 255}.${(ipSeq++) & 255 || 1}`
const auth = t => ({ Authorization: `Bearer ${t}` })

async function signup(tag) {
  const email = `dep130l_${tag}_${RUN_ID}@example.com`
  const r = await createOrg(server, { organizationName: `DEP130L ${tag} ${RUN_ID}`, name: `Admin ${tag}`, email, password: PW }, nextIp())
  expect(r.status).toBe(201)
  return { id: r.body.user.organization.id, userId: r.body.user.id, token: r.body.token, name: `Admin ${tag}` }
}
async function addUser(org, role, name, tag) {
  const email = `dep130l_${tag}_${RUN_ID}@example.com`
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
  admin2 = await addUser(A, 'admin', 'Admin Two', 'a2')
  staff1 = await addUser(A, 'staff', 'Staff One', 's1')
}, 90_000)

afterAll(async () => {
  if (A?.id) await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [A.id]).catch(() => {})
  await closeServer(server)
  await pool.end()
})

const inv = async id => (await request(server).get(`/api/invoices/${id}`).set(auth(A.token))).body

describe('Ledger #415 findings', () => {
  it('P2-1: reversing a received fact also takes it off the invoice paid amount', async () => {
    const i = await invoice(A)
    const pid = await deposit(A, i, 100, staff1)
    expect(Number((await inv(i.id)).amount_paid)).toBe(100)
    const { rows: [f] } = await pool.query(`SELECT id FROM ochr_deposit_facts WHERE payment_id = $1 AND kind = 'received'`, [pid])
    const r = await ask(staff1, pid, { kind: 'reversal', target_fact_id: f.id, reason: 'entered in error' })
    expect(r.status).toBe(201)
    expect((await approve(A, r.body.request.id)).status).toBe(200)
    const after = await inv(i.id)
    expect(Number(after.amount_paid)).toBe(0)
    expect(after.status).toBe('issued')
    expect((await position(A, pid)).held).toBe('0.00')
  })

  it('P2-2: a double-submitted refund request cannot refund twice', async () => {
    const i = await invoice(A)
    const pid = await deposit(A, i, 300, staff1)
    const r1 = await ask(staff1, pid, { kind: 'refund', amount: 100, reason: 'cancelled', idempotency_key: 'rf-1' })
    expect(r1.status).toBe(201)
    const again = await ask(staff1, pid, { kind: 'refund', amount: 100, reason: 'cancelled', idempotency_key: 'rf-1' })
    expect(again.status).toBe(200)
    expect(again.body.replayed).toBe(true)
    expect(again.body.request.id).toBe(r1.body.request.id)
    const mismatch = await ask(staff1, pid, { kind: 'refund', amount: 150, reason: 'cancelled', idempotency_key: 'rf-1' })
    expect(mismatch.status).toBe(409)
    const noKey = await ask(staff1, pid, { kind: 'refund', amount: 100, reason: 'cancelled' })
    expect(noKey.status).toBe(409)
    expect(noKey.body.code).toBe('request_open')
    expect((await approve(A, r1.body.request.id)).status).toBe(200)
    expect((await position(A, pid)).refunded).toBe('100.00')
    // Cap: total approved refunds never exceed what the deposit still holds.
    const r2 = await ask(staff1, pid, { kind: 'refund', amount: 200, reason: 'rest' })
    expect(r2.status).toBe(201)
    expect((await approve(A, r2.body.request.id)).status).toBe(200)
    expect((await ask(staff1, pid, { kind: 'refund', amount: 1, reason: 'more' })).status).toBe(409)
    const { rows: [n] } = await pool.query(
      `SELECT COUNT(*)::int AS c FROM ochr_deposit_requests WHERE payment_id = $1 AND status = 'pending'`, [pid])
    expect(n.c).toBe(0)
    await expect(pool.query(
      `INSERT INTO ochr_deposit_requests (organization_id, payment_id, kind, amount, reason) VALUES ($1,$2,'refund',1,'x'),($1,$2,'refund',1,'y')`,
      [A.id, pid])).rejects.toMatchObject({ code: '23505' })
  })

  it('P2-3: deleting an invoice payment (or its invoice) that has deposit facts is refused', async () => {
    const i = await invoice(A)
    const pid = await deposit(A, i, 50, staff1)
    await expect(pool.query(`DELETE FROM ochr_invoice_payments WHERE id = $1`, [pid])).rejects.toMatchObject({ code: '23503' })
    await expect(pool.query(`DELETE FROM ochr_invoices WHERE id = $1`, [i.id])).rejects.toMatchObject({ code: '23503' })
    const { rows: [c] } = await pool.query(`SELECT COUNT(*)::int AS n FROM ochr_deposit_facts WHERE payment_id = $1`, [pid])
    expect(c.n).toBe(1)
  })

  it('P3-1: a decided request is frozen; a pending one only accepts the decision', async () => {
    const i = await invoice(A)
    const pid = await deposit(A, i, 80, staff1)
    const r = await ask(staff1, pid, { kind: 'forfeit', amount: 10, reason: 'no-show' })
    await expect(pool.query(`UPDATE ochr_deposit_requests SET amount = 80 WHERE id = $1`, [r.body.request.id]))
      .rejects.toMatchObject({ code: '55000' })
    expect((await approve(A, r.body.request.id)).status).toBe(200)
    await expect(pool.query(`UPDATE ochr_deposit_requests SET decision_note = 'later' WHERE id = $1`, [r.body.request.id]))
      .rejects.toMatchObject({ code: '55000' })
    await expect(pool.query(`DELETE FROM ochr_deposit_requests WHERE id = $1`, [r.body.request.id]))
      .rejects.toMatchObject({ code: '55000' })
  })

  it('P3-2: two deposits applied to one line at once cannot over-apply it', async () => {
    const i = await invoice(A, { hall: 100 })
    const p1 = await deposit(A, i, 100, staff1)
    const p2 = await deposit(A, i, 100, staff1)
    const rs = await Promise.all([
      apply(staff1, p1, [{ line_id: i.hall, amount: 100 }], 'race-a'),
      apply(staff1, p2, [{ line_id: i.hall, amount: 100 }], 'race-b'),
    ])
    expect(rs.map(r => r.status).sort()).toEqual([201, 409])
    const { rows: [s] } = await pool.query(
      `SELECT COALESCE(SUM(amount),0)::numeric(12,2)::text AS n FROM ochr_deposit_facts WHERE invoice_line_id = $1 AND kind = 'applied'`, [i.hall])
    expect(s.n).toBe('100.00')
  })

  it('P3-3: an apply replay with a different payload under the same key is a 409', async () => {
    const i = await invoice(A)
    const pid = await deposit(A, i, 200, staff1)
    expect((await apply(staff1, pid, [{ line_id: i.hall, amount: 50 }, { line_id: i.wedding, amount: 0 + 1 }], 'k1')).status).toBe(409) // wedding has no account
    const ok = await apply(staff1, pid, [{ line_id: i.hall, amount: 50 }], 'k2')
    expect(ok.status).toBe(201)
    const same = await apply(staff1, pid, [{ line_id: i.hall, amount: 50 }], 'k2')
    expect(same.status).toBe(200)
    expect(same.body.replayed).toBe(true)
    const diff = await apply(staff1, pid, [{ line_id: i.hall, amount: 60 }], 'k2')
    expect(diff.status).toBe(409)
    expect(diff.body.code).toBe('idempotency_mismatch')
    expect((await position(A, pid)).applied).toBe('50.00')
  })

  it('P3-4: reversal joins in invoices.js and deposits.js filter on organization', async () => {
    const fs = await import('node:fs')
    for (const f of ['src/routes/invoices.js', 'src/routes/deposits.js']) {
      const src = fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
      expect(src).not.toMatch(/o\.id = f\.reverses_fact_id\s*\n/)
    }
  })
})
