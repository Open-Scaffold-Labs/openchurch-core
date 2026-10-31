// Event deposits — the one writer of ochr_deposit_facts (migration 130).
//
// Accounting side only (José, 25 Oct 2026, on Ledger's design note).
// Payment collection / ACH is out of scope (payments hold).
//
//   received  — written with the deposit payment itself (invoices route).
//   applied   — staff CONFIRM each event-day application, per invoice
//               line, into that line's own income account. A line with no
//               income account is refused: whether a wedding deposit is an
//               offering (4210) or a fee (4220) is the pastor's decision,
//               so nothing here picks one.
//   refunded / forfeited / reversal — staff request, an admin who is not
//               the requester approves. A parish with exactly one admin may
//               approve its own request with a typed reason.
//
// Every write locks the payment row; the 130 trigger is the backstop.

import { setDepositLockTimeout } from './depositAdjustmentGuard.js'
import { EFFECTIVE_COA } from './effectiveCoa.js'

export const HELD_CODE = '2300'
export const FORFEIT_CODE = '4920'
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export const FACT_COLUMNS = `id, payment_id, invoice_id, invoice_line_id, kind, amount, account_code,
  to_char(effective_date, 'YYYY-MM-DD') AS effective_date, reverses_fact_id, reason,
  recorded_by_name, approved_by_name, approval_mode, request_id, created_at`

export function parseKey(raw) {
  if (typeof raw !== 'string') return null
  const k = raw.trim()
  return k.length > 0 && k.length <= 120 ? k : null
}

export function toCents(v) {
  const n = typeof v === 'string' ? Number(v.trim()) : v
  if (typeof n !== 'number' || !Number.isFinite(n)) return null
  const c = Math.round(n * 100)
  return Math.abs(n * 100 - c) < 1e-6 ? c : null
}
export const fromCents = c => (c / 100).toFixed(2)

// Net position of one deposit, from facts only. Cents.
export async function depositPosition(db, orgId, paymentId) {
  const { rows: [p] } = await db.query(`
    SELECT COALESCE(SUM(CASE WHEN f.kind = 'reversal' THEN -f.amount ELSE f.amount END)
                      FILTER (WHERE COALESCE(o.kind, f.kind) = 'received'), 0)  AS received,
           COALESCE(SUM(CASE WHEN f.kind = 'reversal' THEN -f.amount ELSE f.amount END)
                      FILTER (WHERE COALESCE(o.kind, f.kind) = 'applied'), 0)   AS applied,
           COALESCE(SUM(CASE WHEN f.kind = 'reversal' THEN -f.amount ELSE f.amount END)
                      FILTER (WHERE COALESCE(o.kind, f.kind) = 'refunded'), 0)  AS refunded,
           COALESCE(SUM(CASE WHEN f.kind = 'reversal' THEN -f.amount ELSE f.amount END)
                      FILTER (WHERE COALESCE(o.kind, f.kind) = 'forfeited'), 0) AS forfeited
      FROM ochr_deposit_facts f
      LEFT JOIN ochr_deposit_facts o ON o.id = f.reverses_fact_id AND o.organization_id = f.organization_id
     WHERE f.organization_id = $1 AND f.payment_id = $2`, [orgId, paymentId])
  const c = k => toCents(Number(p[k])) ?? 0
  const out = { received: c('received'), applied: c('applied'), refunded: c('refunded'), forfeited: c('forfeited') }
  out.held = out.received - out.applied - out.refunded - out.forfeited
  return out
}

export async function lockDepositPayment(db, orgId, paymentId) {
  const { rows } = await db.query(
    `SELECT p.id, p.invoice_id, p.amount, p.is_deposit
       FROM ochr_invoice_payments p
      WHERE p.id = $1 AND p.organization_id = $2 FOR UPDATE`, [paymentId, orgId])
  return rows[0] ?? null
}

export async function findByKey(db, orgId, key) {
  const { rows } = await db.query(
    `SELECT ${FACT_COLUMNS} FROM ochr_deposit_facts WHERE organization_id = $1 AND idempotency_key = $2`,
    [orgId, key])
  return rows[0] ?? null
}

export async function insertFact(db, f) {
  const { rows } = await db.query(
    `INSERT INTO ochr_deposit_facts
       (organization_id, invoice_id, payment_id, invoice_line_id, kind, amount, account_code,
        effective_date, reverses_fact_id, reason, recorded_by_user_id, recorded_by_name,
        approved_by_user_id, approved_by_name, approval_mode, request_id, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING ${FACT_COLUMNS}`,
    [f.organizationId, f.invoiceId, f.paymentId, f.lineId ?? null, f.kind, f.amount, f.accountCode,
     f.effectiveDate, f.reversesFactId ?? null, f.reason ?? null, f.recordedBy?.id ?? null,
     f.recordedBy?.name ?? null, f.approvedBy?.id ?? null, f.approvedBy?.name ?? null,
     f.approvalMode ?? 'none', f.requestId ?? null, f.key])
  return rows[0]
}

// The income account for one line, validated against the org's effective
// chart. null code → 'income_account_required' (no default claim).
export async function incomeAccountFor(db, orgId, code) {
  if (!code) return { fail: 'income_account_required' }
  const { rows } = await db.query(
    `SELECT code, acct_type FROM (${EFFECTIVE_COA}) c WHERE c.code = $2`, [orgId, code])
  if (!rows.length || rows[0].acct_type !== 'revenue' || code === HELD_CODE) {
    return { fail: 'income_account_invalid' }
  }
  return { code }
}

// Submitted/approved diocesan periods covering a date: a reversal of a fact
// dated inside one is dated today and leaves an adjustment row instead.
// R418-2: LOCKS the closed periods (FOR UPDATE, ascending id, bounded by
// lock_timeout) so a guarded diocesan step cannot check-then-write around
// the adjustment this transaction is about to insert. See
// depositAdjustmentGuard.js for the ordering argument. Must run before the
// reversal fact is inserted.
export async function closedPeriodsFor(db, orgId, isoDate) {
  await setDepositLockTimeout(db)
  const { rows } = await db.query(
    `SELECT id FROM ochr_report_submissions
      WHERE organization_id = $1 AND status IN ('submitted', 'approved')
        AND $2::date BETWEEN period_start AND period_end
      ORDER BY id
      FOR UPDATE`, [orgId, isoDate])
  return rows.map(r => r.id)
}

export async function adminCount(db, orgId) {
  const { rows: [r] } = await db.query(
    `SELECT COUNT(*)::int AS n FROM ochr_users WHERE organization_id = $1 AND role = 'admin'`, [orgId])
  return r.n
}
