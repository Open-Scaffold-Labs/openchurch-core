// SP-250 — Mass stipend liability facts (Ledger option C + W1).
// Append-only. Never writes ochr_donations. Never invents cash movement.

import { orgTodayIso, usableTimeZone } from '../utils/sheetWeek.js'

export const STIPEND_LIABILITY_CODE = '2330'
export const DISPOSITION_REQUIRED_CODE = 'stipend_disposition_required'
export const DISPOSITION_REQUIRED = Object.freeze({
  status: 400,
  body: Object.freeze({
    code: DISPOSITION_REQUIRED_CODE,
    error: 'This intention has a recorded offering, so voiding it needs a disposition: refund, transfer to another open intention, or pastor-directed apply with a reason. Nothing was changed.',
  }),
})
export const OPEN_STIPEND_DISPOSITIONS_PENDING = Object.freeze({
  status: 409,
  body: Object.freeze({
    code: 'stipend_dispositions_pending',
    error: "This period has voided Mass intentions with recorded offerings and no disposition yet. Record a refund, transfer, or pastor-directed apply before submitting. Nothing was changed.",
  }),
})

export const PAYMENT_METHODS = Object.freeze(['cash', 'check', 'card', 'other'])
export const PAYMENT_METHOD_REQUIRED = Object.freeze({
  status: 400,
  body: Object.freeze({
    code: 'payment_method_required',
    error: 'A payment method is required when an offering amount is recorded. Nothing was changed.',
  }),
})
export const RECEIVED_DATE_REQUIRED = Object.freeze({
  status: 400,
  body: Object.freeze({
    code: 'received_date_required',
    error: 'The date the offering was received is required when an offering amount is recorded. Nothing was changed.',
  }),
})
export const RECEIVED_DATE_INVALID = Object.freeze({
  status: 400,
  body: Object.freeze({
    code: 'received_date_invalid',
    error: 'The received date must be a real calendar day (YYYY-MM-DD). Nothing was changed.',
  }),
})

const CLEARING = new Set(['refunded', 'transferred', 'pastor_applied'])

/** SP-266: civil day the money arrived — not the Mass date. */
export function parseReceivedDate(raw) {
  if (raw == null || raw === '') return { ok: true, value: null }
  const s = String(raw).trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return { ok: false, code: 'received_date_invalid' }
  }
  const [y, m, d] = s.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return { ok: false, code: 'received_date_invalid' }
  }
  return { ok: true, value: s }
}

export function parsePaymentMethod(raw) {
  if (raw == null || raw === '') return { ok: true, value: null }
  const s = String(raw).trim().toLowerCase()
  if (!PAYMENT_METHODS.includes(s)) {
    return { ok: false, code: 'payment_method_invalid' }
  }
  return { ok: true, value: s }
}

/** Prefer received_date; legacy rows fall back to Mass day then parish today.
 *  `today` is the civil YYYY-MM-DD when the caller already resolved it.
 *  Otherwise `timeZone` (org IANA) drives orgTodayIso — never process UTC. */
export function stipendEffectiveDate({ receivedDate, massDate, today, timeZone } = {}) {
  const t = today
    || orgTodayIso(new Date(), usableTimeZone(timeZone))
    || new Date().toISOString().slice(0, 10)
  if (receivedDate) return String(receivedDate).slice(0, 10)
  if (massDate) return String(massDate).slice(0, 10)
  return t
}

export function parseDisposition(body) {
  const d = body?.disposition
  if (d == null) return null
  if (typeof d !== 'object' || Array.isArray(d)) {
    const err = new Error('disposition_invalid')
    err.code = 'disposition_invalid'
    throw err
  }
  const kind = typeof d.kind === 'string' ? d.kind.trim() : ''
  if (!CLEARING.has(kind)) {
    const err = new Error('disposition_kind')
    err.code = 'disposition_kind'
    throw err
  }
  const reason = typeof d.reason === 'string' ? d.reason.trim() : ''
  let transferTo = d.transfer_to_intention_id
  if (transferTo != null) {
    transferTo = Number(transferTo)
    if (!Number.isInteger(transferTo) || transferTo <= 0) {
      const err = new Error('transfer_target')
      err.code = 'transfer_target'
      throw err
    }
  }
  if (kind === 'transferred' && transferTo == null) {
    const err = new Error('transfer_target')
    err.code = 'transfer_target'
    throw err
  }
  if (kind !== 'transferred' && transferTo != null) {
    const err = new Error('transfer_target')
    err.code = 'transfer_target'
    throw err
  }
  if ((kind === 'pastor_applied' || kind === 'refunded') && !reason) {
    // Void reason may stand in; caller can pass it.
  }
  let amount = d.amount
  if (amount != null) {
    amount = Number(amount)
    if (!(amount > 0) || !Number.isFinite(amount)) {
      const err = new Error('disposition_amount')
      err.code = 'disposition_amount'
      throw err
    }
  }
  return { kind, reason: reason || null, transferTo: transferTo ?? null, amount: amount ?? null }
}

export async function openStipendLiability(db, { organizationId, massIntentionId }) {
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(CASE WHEN kind = 'recorded' THEN amount ELSE -amount END), 0)::NUMERIC(12,2) AS open
       FROM ochr_mass_stipend_facts
      WHERE organization_id = $1 AND mass_intention_id = $2`,
    [organizationId, massIntentionId])
  return Number(rows[0]?.open || 0)
}

export async function recordStipendIfNeeded(db, {
  organizationId, massIntentionId, amount, effectiveDate, userId, idempotencyKey,
}) {
  // First-record path (create / transfer target). Unique key is stable so
  // retries do not double-post. Amount corrections use syncStipendLiability.
  const amt = Number(amount)
  if (!(amt > 0) || !Number.isFinite(amt)) return null
  const key = idempotencyKey || `recorded:${massIntentionId}`
  const { rows } = await db.query(
    `INSERT INTO ochr_mass_stipend_facts
       (organization_id, mass_intention_id, kind, amount, effective_date,
        recorded_by_user_id, idempotency_key)
     VALUES ($1, $2, 'recorded', $3, $4::date, $5, $6)
     ON CONFLICT (organization_id, idempotency_key) DO NOTHING
     RETURNING id, amount::text AS amount`,
    [organizationId, massIntentionId, amt.toFixed(2), effectiveDate, userId ?? null, key])
  return rows[0] || null
}

// Argus N439-2 / N442-1: stipend amount corrections append a delta fact so
// open liability tracks the book amount. Up → recorded delta; down or clear
// to null/0 → adjusted (negative in the ledger SUM). Never ON CONFLICT DO
// NOTHING on the original recorded:${id} key.
export async function syncStipendLiability(db, {
  organizationId, massIntentionId, amount, effectiveDate, userId, reason,
}) {
  // null / undefined / '' / 0 / '0.00' → target 0 (full decrease / clear).
  let target
  if (amount == null || amount === '') {
    target = 0
  } else {
    target = Number(amount)
    if (!Number.isFinite(target) || target < 0) return null
  }
  const open = await openStipendLiability(db, { organizationId, massIntentionId })
  const delta = Number((target - open).toFixed(2))
  // Successful prior sync already moved open to target → delta 0; retries of
  // the same request are therefore idempotent without relying on the key.
  if (delta === 0) return null
  // N442-9: key includes fact-count sequence so clear→re-set(same)→clear
  // does not collide on adjusted:id:20.00->0.00. Same open→target under the
  // intention FOR UPDATE with unchanged fact count still ON CONFLICT-safe.
  const { rows: seqRows } = await db.query(
    `SELECT count(*)::int AS n FROM ochr_mass_stipend_facts
      WHERE organization_id = $1 AND mass_intention_id = $2`,
    [organizationId, massIntentionId])
  const seq = seqRows[0]?.n ?? 0
  if (delta > 0) {
    const key = `recorded:adj:${massIntentionId}:${seq}:${open.toFixed(2)}->${target.toFixed(2)}`
    const { rows } = await db.query(
      `INSERT INTO ochr_mass_stipend_facts
         (organization_id, mass_intention_id, kind, amount, effective_date,
          reason, recorded_by_user_id, idempotency_key)
       VALUES ($1, $2, 'recorded', $3, $4::date, $5, $6, $7)
       ON CONFLICT (organization_id, idempotency_key) DO NOTHING
       RETURNING id, kind, amount::text AS amount`,
      [organizationId, massIntentionId, delta.toFixed(2), effectiveDate,
       reason || 'Stipend amount increased', userId ?? null, key])
    return rows[0] || null
  }
  const key = `adjusted:${massIntentionId}:${seq}:${open.toFixed(2)}->${target.toFixed(2)}`
  const { rows } = await db.query(
    `INSERT INTO ochr_mass_stipend_facts
       (organization_id, mass_intention_id, kind, amount, effective_date,
        reason, recorded_by_user_id, idempotency_key)
     VALUES ($1, $2, 'adjusted', $3, $4::date, $5, $6, $7)
     ON CONFLICT (organization_id, idempotency_key) DO NOTHING
     RETURNING id, kind, amount::text AS amount`,
    [organizationId, massIntentionId, (-delta).toFixed(2), effectiveDate,
     reason || (target === 0 ? 'Stipend cleared' : 'Stipend amount decreased'), userId ?? null, key])
  return rows[0] || null
}

export async function writeDisposition(db, {
  organizationId, massIntentionId, disposition, voidReason, userId, effectiveDate,
}) {
  const open = await openStipendLiability(db, { organizationId, massIntentionId })
  if (!(open > 0)) {
    // No open liability (unpaid, or already cleared). Nothing to write.
    return null
  }
  const amount = disposition.amount != null ? disposition.amount : open
  if (Number(amount.toFixed(2)) !== Number(open.toFixed(2))) {
    const err = new Error('disposition_amount_mismatch')
    err.code = 'disposition_amount_mismatch'
    err.open = open
    throw err
  }
  const reason = disposition.reason || voidReason
  if (!reason || !String(reason).trim()) {
    const err = new Error('disposition_reason')
    err.code = 'disposition_reason'
    throw err
  }
  if (disposition.kind === 'transferred') {
    if (disposition.transferTo === massIntentionId) {
      const err = new Error('transfer_self')
      err.code = 'transfer_self'
      throw err
    }
    const tgt = await db.query(
      `SELECT id, voided_at, stipend
         FROM ochr_mass_intentions
        WHERE id = $1 AND organization_id = $2
        FOR UPDATE`,
      [disposition.transferTo, organizationId])
    if (!tgt.rows.length) {
      const err = new Error('transfer_target_missing')
      err.code = 'transfer_target'
      throw err
    }
    if (tgt.rows[0].voided_at != null) {
      const err = new Error('transfer_target_voided')
      err.code = 'transfer_target'
      throw err
    }
  }
  const key = `${disposition.kind}:${massIntentionId}:${effectiveDate}`
  const { rows } = await db.query(
    `INSERT INTO ochr_mass_stipend_facts
       (organization_id, mass_intention_id, kind, amount, effective_date,
        transfer_to_intention_id, reason, recorded_by_user_id, idempotency_key)
     VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, $9)
     RETURNING id, kind, amount::text AS amount`,
    [organizationId, massIntentionId, disposition.kind, Number(amount).toFixed(2),
     effectiveDate, disposition.transferTo, String(reason).trim(), userId ?? null, key])

  if (disposition.kind === 'transferred') {
    // P1 N2: latch offering_recorded + stipend on the target so voiding it
    // requires a disposition and period submit stays held while liability is open.
    await recordStipendIfNeeded(db, {
      organizationId,
      massIntentionId: disposition.transferTo,
      amount,
      effectiveDate,
      userId,
      idempotencyKey: `recorded:from:${massIntentionId}:${disposition.transferTo}`,
    })
    const tgtOpen = await openStipendLiability(db, {
      organizationId, massIntentionId: disposition.transferTo,
    })
    await db.query(
      `UPDATE ochr_mass_intentions
          SET offering_recorded = true,
              stipend = $3::numeric(12,2),
              updated_at = NOW()
        WHERE id = $1 AND organization_id = $2`,
      [disposition.transferTo, organizationId, tgtOpen.toFixed(2)])
  }
  return rows[0]
}

export async function periodHasOpenStipendDispositions(db, { organizationId, periodStart, periodEnd }) {
  // N442-7 / W1: hold when open 2330 > 0.
  // N442-8 (Argus): also hold legacy voided+offering_recorded rows with
  // zero facts (mig 136 skipped them so submit stayed fail-closed until a
  // human disposition). Clear→void keeps facts (adjusted to zero) so it
  // does not stick. A disposition fact means "any facts" exist → unstuck.
  const { rows } = await db.query(
    `SELECT 1
       FROM ochr_mass_intentions mi
      WHERE mi.organization_id = $1
        AND mi.voided_at IS NOT NULL
        AND (
          mi.voided_at::date BETWEEN $2::date AND $3::date
          OR EXISTS (
            SELECT 1 FROM ochr_mass_stipend_facts f
             WHERE f.organization_id = mi.organization_id
               AND f.mass_intention_id = mi.id
               AND f.kind = 'recorded'
               AND f.effective_date BETWEEN $2::date AND $3::date
          )
        )
        AND (
          (
            SELECT COALESCE(SUM(CASE WHEN f.kind = 'recorded' THEN f.amount ELSE -f.amount END), 0)
              FROM ochr_mass_stipend_facts f
             WHERE f.organization_id = mi.organization_id
               AND f.mass_intention_id = mi.id
          ) > 0
          OR (
            mi.offering_recorded = true
            AND NOT EXISTS (
              SELECT 1 FROM ochr_mass_stipend_facts f
               WHERE f.organization_id = mi.organization_id
                 AND f.mass_intention_id = mi.id
            )
          )
        )
      LIMIT 1`,
    [organizationId, periodStart, periodEnd])
  return rows.length > 0
}
