// /api/deposits — event deposits held in 2300 until the event (migration 130).
//
// Accounting only. No money moves here: a refund fact records a refund the
// office made; it does not send one. Payment collection / ACH is out of
// scope (payments hold). Mounted behind requireAuth + writeGate, so
// viewers read and staff/admin write; approvals are admin-only below.

import { Router } from 'express'
import pool from '../db.js'
import { requireIntParam } from '../utils/params.js'
import { requireRole } from '../middleware/auth.js'
import { monitor } from '../monitoring/index.js'
import {
  HELD_CODE, FORFEIT_CODE, ISO_DATE, FACT_COLUMNS, parseKey, toCents, fromCents,
  depositPosition, lockDepositPayment, findByKey, insertFact, incomeAccountFor,
  closedPeriodsFor, adminCount,
} from '../finance/deposits.js'
import { isDepositLockBusy, DEPOSIT_LOCK_BUSY } from '../finance/depositAdjustmentGuard.js'
import { recomputePaid } from './invoices.js'

const router = Router()

const REQUEST_COLUMNS = `id, payment_id, kind, amount, target_fact_id, reason, status,
  requested_by_user_id, requested_by_name, decided_by_name, decided_at, decision_note,
  approval_mode, fact_id, created_at`

const positionOut = p => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, fromCents(v)]))

async function liveActor(db, req) {
  const { rows } = await db.query(
    'SELECT id, name, role FROM ochr_users WHERE id = $1 AND organization_id = $2',
    [req.user.id, req.organizationId])
  return rows[0] ?? null
}
const today = async db => (await db.query(`SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS d`)).rows[0].d

function trimReason(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null
  return raw.trim().slice(0, 500)
}

const OVER = { status: 409, body: { code: 'over_applied',
  error: 'That is more than this deposit still holds. Nothing was recorded.' } }

// ------------------------------------------------------------- schedule ----
// One row per deposit with a held balance or activity as of the date, and a
// footer that must equal the 2300 balance in the ledger projection. Any
// difference is a named line, never hidden. If the ledger cannot be read,
// the balance is null (UNKNOWN), not zero.
router.get('/schedule', async (req, res) => {
  const asOf = ISO_DATE.test(req.query.as_of ?? '') ? req.query.as_of : null
  try {
    const d = asOf ?? await today(pool)
    const { rows } = await pool.query(`
      SELECT p.id AS payment_id, p.invoice_id, i.invoice_no, i.title, i.payer_name, i.status AS invoice_status,
             to_char(ce.date, 'YYYY-MM-DD') AS event_date,
             SUM(CASE WHEN f.kind = 'reversal' THEN -f.amount ELSE f.amount END)
               FILTER (WHERE COALESCE(o.kind, f.kind) = 'received')  AS received,
             SUM(CASE WHEN f.kind = 'reversal' THEN -f.amount ELSE f.amount END)
               FILTER (WHERE COALESCE(o.kind, f.kind) = 'applied')   AS applied,
             SUM(CASE WHEN f.kind = 'reversal' THEN -f.amount ELSE f.amount END)
               FILTER (WHERE COALESCE(o.kind, f.kind) = 'refunded')  AS refunded,
             SUM(CASE WHEN f.kind = 'reversal' THEN -f.amount ELSE f.amount END)
               FILTER (WHERE COALESCE(o.kind, f.kind) = 'forfeited') AS forfeited
        FROM ochr_deposit_facts f
        LEFT JOIN ochr_deposit_facts o ON o.id = f.reverses_fact_id AND o.organization_id = f.organization_id
        JOIN ochr_invoice_payments p ON p.id = f.payment_id AND p.organization_id = f.organization_id
        JOIN ochr_invoices i ON i.id = p.invoice_id AND i.organization_id = p.organization_id
        LEFT JOIN ochr_calendar_events ce ON ce.id = i.calendar_event_id AND ce.organization_id = i.organization_id
       WHERE f.organization_id = $1 AND f.effective_date <= $2::date
       GROUP BY p.id, p.invoice_id, i.invoice_no, i.title, i.payer_name, i.status, ce.date
       ORDER BY ce.date NULLS LAST, p.id`, [req.organizationId, d])
    let heldCents = 0
    const deposits = rows.map(r => {
      const c = k => toCents(Number(r[k] ?? 0)) ?? 0
      const held = c('received') - c('applied') - c('refunded') - c('forfeited')
      heldCents += held
      return {
        payment_id: r.payment_id, invoice_id: r.invoice_id, invoice_no: r.invoice_no, title: r.title,
        payer_name: r.payer_name, invoice_status: r.invoice_status, event_date: r.event_date,
        received: fromCents(c('received')), applied: fromCents(c('applied')),
        refunded: fromCents(c('refunded')), forfeited: fromCents(c('forfeited')), held: fromCents(held),
        // Past the event and still held: needs staff to confirm or resolve.
        stale: held > 0 && r.event_date != null && r.event_date < d,
        cancelled_unresolved: held > 0 && r.invoice_status === 'cancelled',
      }
    }).filter(r => r.held !== '0.00' || r.received !== '0.00')

    let ledger = null, other = null
    try {
      const { rows: [l] } = await pool.query(`
        SELECT COALESCE(SUM(amount), 0) AS total,
               COALESCE(SUM(amount) FILTER (WHERE source_type NOT IN ('deposit_held', 'deposit_income')), 0) AS other
          FROM ochr_parish_ledger
         WHERE organization_id = $1 AND account_code = $2 AND entry_date <= $3::date`,
        [req.organizationId, HELD_CODE, d])
      ledger = toCents(Number(l.total))
      other = toCents(Number(l.other))
    } catch (err) {
      monitor.error('deposits.schedule.ledger', err, { orgId: req.organizationId })
    }
    const difference = ledger == null ? null : ledger - heldCents
    res.json({
      as_of: d,
      deposits,
      totals: {
        held: fromCents(heldCents),
        ledger_2300: ledger == null ? null : fromCents(ledger),
        difference: difference == null ? null : fromCents(difference),
        // Named reconciling line: entries on 2300 that did not come from a deposit.
        other_entries_on_2300: other == null ? null : fromCents(other),
        reconciled: difference == null ? null : difference === 0,
      },
    })
  } catch (err) {
    monitor.error('deposits.schedule', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load the deposits schedule' })
  }
})

// -------------------------------------------------------------- reads ----
router.get('/payments/:paymentId', async (req, res) => {
  const paymentId = requireIntParam(req, res, 'paymentId'); if (paymentId === null) return
  try {
    const { rows: [p] } = await pool.query(
      `SELECT id, invoice_id, amount, is_deposit FROM ochr_invoice_payments
        WHERE id = $1 AND organization_id = $2`, [paymentId, req.organizationId])
    if (!p || !p.is_deposit) return res.status(404).json({ error: 'Deposit not found' })
    const [{ rows: facts }, { rows: requests }, pos] = await Promise.all([
      pool.query(`SELECT ${FACT_COLUMNS} FROM ochr_deposit_facts
                   WHERE organization_id = $1 AND payment_id = $2 ORDER BY id`, [req.organizationId, paymentId]),
      pool.query(`SELECT ${REQUEST_COLUMNS} FROM ochr_deposit_requests
                   WHERE organization_id = $1 AND payment_id = $2 ORDER BY id`, [req.organizationId, paymentId]),
      depositPosition(pool, req.organizationId, paymentId),
    ])
    res.json({ payment_id: p.id, invoice_id: p.invoice_id, amount: p.amount, position: positionOut(pos), facts, requests })
  } catch (err) {
    monitor.error('deposits.get', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load the deposit' })
  }
})

router.get('/requests', async (req, res) => {
  const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending'
  try {
    const { rows } = await pool.query(
      `SELECT ${REQUEST_COLUMNS} FROM ochr_deposit_requests
        WHERE organization_id = $1 AND status = $2 ORDER BY created_at, id LIMIT 200`,
      [req.organizationId, status])
    res.json({ requests: rows })
  } catch (err) {
    monitor.error('deposits.requests', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load deposit requests' })
  }
})

// -------------------------------------------------------------- apply ----
// Staff confirm the event-day application. Never automatic.
router.post('/payments/:paymentId/apply', async (req, res) => {
  const paymentId = requireIntParam(req, res, 'paymentId'); if (paymentId === null) return
  const key = parseKey(req.body?.idempotency_key)
  if (!key) return res.status(400).json({ error: 'idempotency_key is required (1–120 characters)' })
  const alloc = Array.isArray(req.body?.allocations) ? req.body.allocations : null
  if (!alloc?.length || alloc.length > 50) return res.status(400).json({ error: 'allocations must list at least one invoice line' })
  const parsed = []
  for (const a of alloc) {
    const lineId = Number(a?.line_id)
    const cents = toCents(a?.amount)
    if (!Number.isInteger(lineId) || lineId <= 0 || cents == null || cents <= 0) {
      return res.status(400).json({ error: 'Each allocation needs a line_id and a positive amount' })
    }
    if (parsed.some(p => p.lineId === lineId)) return res.status(400).json({ error: 'Each line may appear once' })
    parsed.push({ lineId, cents })
  }
  const effectiveDate = req.body?.effective_date == null ? null
    : (ISO_DATE.test(req.body.effective_date) ? req.body.effective_date : undefined)
  if (effectiveDate === undefined) return res.status(400).json({ error: 'effective_date must be YYYY-MM-DD' })

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const pay = await lockDepositPayment(client, req.organizationId, paymentId)
    if (!pay || !pay.is_deposit) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Deposit not found' }) }

    // Serialize every application against this invoice's lines (Ledger P3-2):
    // two deposits on one invoice can no longer both pass the line check.
    await client.query(`SELECT 1 FROM ochr_invoices WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
      [pay.invoice_id, req.organizationId])

    // Replay: the whole payload under this key must match (Ledger P3-3).
    const { rows: prior } = await client.query(
      `SELECT ${FACT_COLUMNS} FROM ochr_deposit_facts WHERE organization_id = $1 AND idempotency_key LIKE $2 ORDER BY id`,
      [req.organizationId, `${key.replace(/[\\%_]/g, '\\$&')}:line:%`])
    if (prior.length) {
      await client.query('ROLLBACK')
      const was = prior.map(f => `${f.payment_id}:${f.invoice_line_id}:${toCents(Number(f.amount))}`).sort().join(',')
      const now = parsed.map(p => `${paymentId}:${p.lineId}:${p.cents}`).sort().join(',')
      const sameDate = effectiveDate == null || prior.every(f => String(f.effective_date).slice(0, 10) === effectiveDate)
      if (was !== now || !sameDate) {
        return res.status(409).json({ code: 'idempotency_mismatch',
          error: 'That key was already used for a different application. Nothing was recorded.' })
      }
      return res.status(200).json({ replayed: true, facts: prior })
    }

    const pos = await depositPosition(client, req.organizationId, paymentId)
    const want = parsed.reduce((s, p) => s + p.cents, 0)
    if (want > pos.held) { await client.query('ROLLBACK'); return res.status(OVER.status).json(OVER.body) }

    const actor = await liveActor(client, req)
    const date = effectiveDate ?? await today(client)
    const facts = []
    for (const { lineId, cents } of parsed) {
      const { rows: [line] } = await client.query(
        `SELECT id, amount, account_code, pass_through FROM ochr_invoice_lines
          WHERE id = $1 AND invoice_id = $2 AND organization_id = $3`, [lineId, pay.invoice_id, req.organizationId])
      if (!line) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Invoice line not found on this deposit\'s invoice' }) }
      if (line.pass_through) {
        await client.query('ROLLBACK')
        return res.status(409).json({ code: 'pass_through_line', error: 'A pass-through line is owed to its payee and is not parish income.' })
      }
      const acct = await incomeAccountFor(client, req.organizationId, line.account_code)
      if (acct.fail) {
        await client.query('ROLLBACK')
        return res.status(409).json({ code: acct.fail, line_id: lineId,
          error: acct.fail === 'income_account_required'
            ? 'Choose the income account for this line first. For a wedding, offering or fee is the pastor\'s decision; OpenChurch does not pick one.'
            : 'This line\'s account is not an income account in your chart of accounts.' })
      }
      const { rows: [done] } = await client.query(
        `SELECT COALESCE(SUM(CASE WHEN f.kind = 'reversal' THEN -f.amount ELSE f.amount END), 0) AS n
           FROM ochr_deposit_facts f
           LEFT JOIN ochr_deposit_facts o ON o.id = f.reverses_fact_id AND o.organization_id = f.organization_id
          WHERE f.organization_id = $1 AND COALESCE(o.invoice_line_id, f.invoice_line_id) = $2
            AND COALESCE(o.kind, f.kind) = 'applied'`, [req.organizationId, lineId])
      if ((toCents(Number(done.n)) ?? 0) + cents > (toCents(Number(line.amount)) ?? 0)) {
        await client.query('ROLLBACK')
        return res.status(409).json({ code: 'line_over_applied', line_id: lineId, error: 'That is more than this line charges.' })
      }
      facts.push(await insertFact(client, {
        organizationId: req.organizationId, invoiceId: pay.invoice_id, paymentId, lineId, kind: 'applied',
        amount: fromCents(cents), accountCode: acct.code, effectiveDate: date, recordedBy: actor,
        key: `${key}:line:${lineId}`,
      }))
    }
    await client.query('COMMIT')
    res.status(201).json({ facts, position: positionOut(await depositPosition(pool, req.organizationId, paymentId)) })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    if (err.code === '23514') return res.status(OVER.status).json(OVER.body)
    if (err.code === '23505') return res.status(409).json({ code: 'duplicate', error: 'This application was already recorded.' })
    monitor.error('deposits.apply', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to apply the deposit. Nothing was recorded.' })
  } finally {
    client.release()
  }
})

// ------------------------------------------------------------- requests ----
router.post('/payments/:paymentId/requests', async (req, res) => {
  const paymentId = requireIntParam(req, res, 'paymentId'); if (paymentId === null) return
  const kind = req.body?.kind
  if (!['refund', 'forfeit', 'reversal'].includes(kind)) return res.status(400).json({ error: 'kind must be refund, forfeit or reversal' })
  const reason = trimReason(req.body?.reason)
  if (!reason) return res.status(422).json({ error: 'A reason is required' })
  const idemRaw = req.body?.idempotency_key
  const idem = idemRaw == null ? null : parseKey(idemRaw)
  if (idemRaw != null && !idem) return res.status(400).json({ error: 'idempotency_key must be 1–120 characters' })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const pay = await lockDepositPayment(client, req.organizationId, paymentId)
    if (!pay || !pay.is_deposit) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Deposit not found' }) }
    if (idem) {
      const { rows: [seen] } = await client.query(
        `SELECT ${REQUEST_COLUMNS} FROM ochr_deposit_requests WHERE organization_id = $1 AND idempotency_key = $2`,
        [req.organizationId, idem])
      if (seen) {
        await client.query('ROLLBACK')
        const same = Number(seen.payment_id) === paymentId && seen.kind === kind
          && (kind === 'reversal' ? Number(seen.target_fact_id) === Number(req.body?.target_fact_id)
                                  : toCents(Number(seen.amount)) === toCents(req.body?.amount))
        return same ? res.status(200).json({ replayed: true, request: seen })
          : res.status(409).json({ code: 'idempotency_mismatch', error: 'That key was already used for a different request.' })
      }
    }
    let amountCents, target = null
    if (kind === 'reversal') {
      const tid = Number(req.body?.target_fact_id)
      const { rows } = await client.query(
        `SELECT f.id, f.kind, f.amount FROM ochr_deposit_facts f
          WHERE f.id = $1 AND f.organization_id = $2 AND f.payment_id = $3`,
        [Number.isInteger(tid) ? tid : 0, req.organizationId, paymentId])
      target = rows[0]
      if (!target || target.kind === 'reversal') {
        await client.query('ROLLBACK'); return res.status(404).json({ error: 'Fact to reverse not found on this deposit' })
      }
      amountCents = toCents(Number(target.amount))
    } else {
      amountCents = toCents(req.body?.amount)
      if (amountCents == null || amountCents <= 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Invalid amount' }) }
      const pos = await depositPosition(client, req.organizationId, paymentId)
      if (amountCents > pos.held) { await client.query('ROLLBACK'); return res.status(OVER.status).json(OVER.body) }
    }
    // One open request at a time (Ledger P2-2): a second refund/forfeit ask
    // on this deposit, or a second reversal ask on one fact, is refused.
    const { rows: open } = await client.query(
      `SELECT id FROM ochr_deposit_requests
        WHERE organization_id = $1 AND status = 'pending'
          AND (($2 <> 'reversal' AND payment_id = $3 AND kind IN ('refund', 'forfeit'))
               OR ($2 = 'reversal' AND target_fact_id = $4))
        LIMIT 1`, [req.organizationId, kind, paymentId, target?.id ?? null])
    if (open.length) {
      await client.query('ROLLBACK')
      return res.status(409).json({ code: 'request_open', request_id: open[0].id,
        error: 'There is already an open request on this deposit. Approve or reject it first.' })
    }
    const actor = await liveActor(client, req)
    const { rows: [r] } = await client.query(
      `INSERT INTO ochr_deposit_requests
         (organization_id, payment_id, kind, amount, target_fact_id, reason, requested_by_user_id, requested_by_name, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${REQUEST_COLUMNS}`,
      [req.organizationId, paymentId, kind, fromCents(amountCents), target?.id ?? null, reason, actor?.id ?? null, actor?.name ?? null, idem])
    await client.query('COMMIT')
    res.status(201).json({ request: r })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    if (err.code === '23505') return res.status(409).json({ code: 'request_open',
      error: 'There is already an open request on this deposit. Approve or reject it first.' })
    monitor.error('deposits.request', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to record the request' })
  } finally {
    client.release()
  }
})

router.post('/requests/:id/approve', requireRole('admin'), async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows: [r] } = await client.query(
      `SELECT * FROM ochr_deposit_requests WHERE id = $1 AND organization_id = $2 FOR UPDATE`, [id, req.organizationId])
    if (!r) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Request not found' }) }
    if (r.status !== 'pending') { await client.query('ROLLBACK'); return res.status(409).json({ error: `This request is already ${r.status}` }) }
    const actor = await liveActor(client, req)
    const pay = await lockDepositPayment(client, req.organizationId, r.payment_id)

    let target = null
    if (r.kind === 'reversal') {
      const { rows } = await client.query(
        `SELECT id, kind, amount, account_code, invoice_line_id, recorded_by_user_id,
                to_char(effective_date, 'YYYY-MM-DD') AS effective_date
           FROM ochr_deposit_facts WHERE id = $1 AND organization_id = $2`, [r.target_fact_id, req.organizationId])
      target = rows[0]
    }
    const ownRequest = r.requested_by_user_id != null && Number(r.requested_by_user_id) === Number(actor?.id)
    const ownFact = target?.recorded_by_user_id != null && Number(target.recorded_by_user_id) === Number(actor?.id)
    let mode = 'second_admin', reason = r.reason
    if (ownRequest || ownFact) {
      const single = trimReason(req.body?.single_admin_reason)
      if ((await adminCount(client, req.organizationId)) !== 1 || !single) {
        await client.query('ROLLBACK')
        return res.status(403).json({ code: ownRequest ? 'own_request' : 'own_fact',
          error: ownRequest ? 'Another admin must approve a request you made.'
                            : 'Another admin must approve reversing a fact you recorded.' })
      }
      mode = 'single_admin'
      reason = `${r.reason} — single-admin approval: ${single}`
    }

    const date = await today(client)
    const common = {
      organizationId: req.organizationId, invoiceId: pay.invoice_id, paymentId: r.payment_id, amount: r.amount,
      reason, recordedBy: { id: r.requested_by_user_id, name: r.requested_by_name },
      approvedBy: actor, approvalMode: mode, requestId: r.id, key: `request:${r.id}`,
    }
    let fact, adjustments = []
    if (r.kind === 'refund') {
      fact = await insertFact(client, { ...common, kind: 'refunded', accountCode: HELD_CODE, effectiveDate: date })
    } else if (r.kind === 'forfeit') {
      fact = await insertFact(client, { ...common, kind: 'forfeited', accountCode: FORFEIT_CODE, effectiveDate: date })
    } else {
      const closed = await closedPeriodsFor(client, req.organizationId, target.effective_date)
      fact = await insertFact(client, {
        ...common, kind: 'reversal', reversesFactId: target.id, lineId: target.invoice_line_id,
        accountCode: target.account_code, effectiveDate: closed.length ? date : target.effective_date,
      })
      for (const sid of closed) {
        const { rows } = await client.query(
          `INSERT INTO ochr_deposit_period_adjustments
             (organization_id, submission_id, fact_id, reversed_fact_id, amount, assessable_impact)
           VALUES ($1,$2,$3,$4,$5,NULL) ON CONFLICT DO NOTHING RETURNING id, submission_id, amount, assessable_impact`,
          [req.organizationId, sid, fact.id, target.id, r.amount])
        adjustments.push(...rows)
      }
    }
    // A refund, or undoing a refund or a receipt, changes what the invoice
    // has been paid (Ledger P2-1).
    if (r.kind === 'refund' || target?.kind === 'refunded' || target?.kind === 'received') {
      await client.query(`SELECT 1 FROM ochr_invoices WHERE id = $1 AND organization_id = $2 FOR UPDATE`, [pay.invoice_id, req.organizationId])
      await recomputePaid(client, pay.invoice_id, req.organizationId)
    }
    const { rows: [done] } = await client.query(
      `UPDATE ochr_deposit_requests
          SET status = 'approved', decided_by_user_id = $3, decided_by_name = $4, decided_at = NOW(),
              approval_mode = $5, fact_id = $6
        WHERE id = $1 AND organization_id = $2 RETURNING ${REQUEST_COLUMNS}`,
      [r.id, req.organizationId, actor?.id ?? null, actor?.name ?? null, mode, fact.id])
    await client.query('COMMIT')
    res.json({
      request: done, fact, period_adjustments: adjustments,
      ...(adjustments.length ? { message:
        'The original falls in a period already sent to the diocese. The correction is dated today and an adjustment was recorded for the chancery. Whether it changes the assessable base is not known yet.' } : {}),
    })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    if (isDepositLockBusy(err)) return res.status(DEPOSIT_LOCK_BUSY.status).json(DEPOSIT_LOCK_BUSY.body)
    if (err.code === '23514') return res.status(OVER.status).json(OVER.body)
    if (err.code === '23505') return res.status(409).json({ code: 'already_reversed', error: 'That fact was already reversed.' })
    monitor.error('deposits.approve', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to approve. Nothing was recorded.' })
  } finally {
    client.release()
  }
})

router.post('/requests/:id/reject', requireRole('admin'), async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  const note = trimReason(req.body?.note)
  try {
    const actor = await liveActor(pool, req)
    const { rows } = await pool.query(
      `UPDATE ochr_deposit_requests
          SET status = 'rejected', decided_by_user_id = $3, decided_by_name = $4, decided_at = NOW(), decision_note = $5
        WHERE id = $1 AND organization_id = $2 AND status = 'pending' RETURNING ${REQUEST_COLUMNS}`,
      [id, req.organizationId, actor?.id ?? null, actor?.name ?? null, note])
    if (!rows.length) return res.status(409).json({ error: 'Only a pending request can be rejected' })
    res.json({ request: rows[0] })
  } catch (err) {
    monitor.error('deposits.reject', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to reject the request' })
  }
})

export default router
