// GIV-06 Option A helpers — a refund is a linked financial fact.
//
// gift.amount is never rewritten. Stamps on ochr_donations (payment_status,
// refunded_at, refund_ref) are a derived cache of Σ(posted refund rows).
// Live contribution is gift.amount − Σ(posted), with stamp fallback only
// when a gift is stamped refunded and has no posted row yet.

export function refundIdempotencyKey(organizationId, donationId, refundId) {
  return `refund-${organizationId}-${donationId}-${refundId}`
}

export function parseRefundAmount(raw) {
  if (raw === undefined || raw === null || raw === '') return { kind: 'remaining' }
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return { kind: 'invalid' }
  return { kind: 'explicit', amount: n }
}

export async function lockGift(client, donationId, organizationId) {
  const { rows } = await client.query(
    `SELECT id, source, amount, payment_ref, payment_status, refunded_at, refund_ref
       FROM ochr_donations
      WHERE id = $1 AND organization_id = $2
      FOR UPDATE`,
    [donationId, organizationId]
  )
  return rows[0] ?? null
}

export async function reservedRefundTotal(client, donationId, organizationId) {
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(amount), 0)::NUMERIC(12,2) AS reserved
       FROM ochr_donation_refunds
      WHERE donation_id = $1
        AND organization_id = $2
        AND status IN ('pending', 'posted')`,
    [donationId, organizationId]
  )
  return rows[0].reserved
}

export async function postedRefundTotal(client, donationId, organizationId) {
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(amount), 0)::NUMERIC(12,2) AS posted
       FROM ochr_donation_refunds
      WHERE donation_id = $1
        AND organization_id = $2
        AND status = 'posted'`,
    [donationId, organizationId]
  )
  return rows[0].posted
}

export async function findPendingRefund(client, donationId, organizationId) {
  const { rows } = await client.query(
    `SELECT id, amount, status, refund_ref, refunded_at
       FROM ochr_donation_refunds
      WHERE donation_id = $1 AND organization_id = $2 AND status = 'pending'
      ORDER BY id ASC
      LIMIT 1`,
    [donationId, organizationId]
  )
  return rows[0] ?? null
}

export async function insertPendingRefund(client, organizationId, donationId, amount) {
  const { rows } = await client.query(
    `INSERT INTO ochr_donation_refunds
       (organization_id, donation_id, amount, status)
     VALUES ($1, $2, $3, 'pending')
     RETURNING id, amount, status, refund_ref, refunded_at`,
    [organizationId, donationId, amount]
  )
  return rows[0]
}

export async function postRefundFact(client, { refundId, organizationId, donationId, refundRef }) {
  const { rows } = await client.query(
    `UPDATE ochr_donation_refunds
        SET status = 'posted', refund_ref = $1, refunded_at = NOW()
      WHERE id = $2
        AND organization_id = $3
        AND donation_id = $4
        AND status = 'pending'
      RETURNING id, amount, status, refund_ref, refunded_at`,
    [refundRef, refundId, organizationId, donationId]
  )
  return rows[0] ?? null
}

// Stamps are a cache. Full refunded only when Σ(posted) ≥ gift.amount.
// Partial refunds leave payment_status as it was (typically 'succeeded').
export async function refreshGiftRefundStamps(client, donationId, organizationId, returningSql) {
  const returning = returningSql ? ` RETURNING ${returningSql}` : ''
  const { rows } = await client.query(
    `WITH posted AS (
       SELECT COALESCE(SUM(amount), 0) AS total,
              MAX(refunded_at) AS last_at,
              (ARRAY_AGG(refund_ref ORDER BY refunded_at DESC, id DESC))[1] AS last_ref
         FROM ochr_donation_refunds
        WHERE donation_id = $1 AND organization_id = $2 AND status = 'posted'
     )
     UPDATE ochr_donations d
        SET payment_status = CASE
              WHEN p.total >= d.amount THEN 'refunded'
              ELSE d.payment_status
            END,
            refunded_at = CASE
              WHEN p.total >= d.amount THEN p.last_at
              ELSE d.refunded_at
            END,
            refund_ref = CASE
              WHEN p.total >= d.amount THEN p.last_ref
              ELSE d.refund_ref
            END
       FROM posted p
      WHERE d.id = $1 AND d.organization_id = $2
     ${returning}`,
    [donationId, organizationId]
  )
  return rows[0] ?? null
}

// 123: a cash-count void is a posted reversing fact with its reason. It is
// not a provider refund, so no refund_ref and no gift stamps are touched;
// the live view and ledger net it like any posted refund row.
// 125: the fact can name who posted it. Cash-count voids pass the actor;
// older callers omit it and the columns stay null.
export async function postVoidFact(client, { organizationId, donationId, amount, reason, actor = null }) {
  return insertRecordedMarker(client, {
    organizationId, donationId, amount, kind: 'void', reason, actor, idempotencyKey: null,
  })
}

// A decimal the parish typed, or a numeric the database returned.
// More than two fractional digits is invalid — never rounded.
// Integer cents are the only comparison unit (R325-1).
export function decimalToCents(raw) {
  if (typeof raw === 'boolean' || raw == null) return null
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return null
    if (!Number.isInteger(raw) && String(raw).includes('e')) return null
  }
  const s = String(raw).trim()
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null
  const [whole, frac = ''] = s.split('.')
  const cents = Number(whole) * 100 + Number((frac + '00').slice(0, 2))
  if (!Number.isSafeInteger(cents)) return null
  return cents
}

export function centsToDecimal(cents) {
  const whole = Math.trunc(cents / 100)
  const frac = String(Math.abs(cents % 100)).padStart(2, '0')
  return `${whole}.${frac}`
}

export function parseMarkerAmount(raw) {
  if (raw === undefined || raw === null || raw === '') return { kind: 'remaining' }
  if (typeof raw === 'boolean' || Array.isArray(raw) || (typeof raw === 'object' && raw !== null)) {
    return { kind: 'invalid' }
  }
  const cents = decimalToCents(raw)
  if (cents == null || cents <= 0) return { kind: 'invalid' }
  return { kind: 'explicit', cents }
}

export class AdjustmentError extends Error {
  constructor(status, error) {
    super(error)
    this.status = status
    this.error = error
  }
}

const MARKER_RETURNING = `id, donation_id, amount, status, kind, reason, refunded_at, recorded_by_name`

async function insertRecordedMarker(client, {
  organizationId, donationId, amount, kind, reason, actor, idempotencyKey,
}) {
  const { rows } = await client.query(
    `INSERT INTO ochr_donation_refunds
       (organization_id, donation_id, amount, status, kind, reason, refunded_at,
        recorded_by_user_id, recorded_by_name, idempotency_key)
     VALUES ($1, $2, $3, 'posted', $4, $5, NOW(), $6, $7, $8)
     RETURNING ${MARKER_RETURNING}`,
    [
      organizationId, donationId, amount, kind, reason,
      actor?.id ?? null, actor?.name ?? null, idempotencyKey,
    ]
  )
  return rows[0]
}

async function findMarkerByKey(client, organizationId, key) {
  const { rows } = await client.query(
    `SELECT ${MARKER_RETURNING}, idempotency_key
       FROM ochr_donation_refunds
      WHERE organization_id = $1 AND idempotency_key = $2`,
    [organizationId, key]
  )
  return rows[0] ?? null
}

async function findPostedVoid(client, donationId, organizationId) {
  const { rows } = await client.query(
    `SELECT ${MARKER_RETURNING}
       FROM ochr_donation_refunds
      WHERE donation_id = $1 AND organization_id = $2
        AND status = 'posted' AND kind = 'void'
      LIMIT 1`,
    [donationId, organizationId]
  )
  return rows[0] ?? null
}

function sameMarker(existing, { donationId, kind, amountCents }) {
  if (!existing) return false
  if (Number(existing.donation_id) !== Number(donationId)) return false
  if (existing.kind !== kind) return false
  if (amountCents != null && decimalToCents(existing.amount) !== amountCents) return false
  return true
}

// A void or a refund that is only a parish-book marker. The gift row is
// not updated. The caller holds the transaction. A second call with the
// same idempotency key returns the fact already posted. A void of a gift
// that already has one is rejected. A refund past what remains is rejected.
// The 104 cap trigger is the database saying the same thing.
export async function postRecordedAdjustment(client, {
  organizationId, donationId, kind, amountCents, reason, actor, idempotencyKey,
}) {
  const locked = await lockGift(client, donationId, organizationId)
  if (!locked) throw new AdjustmentError(404, 'Not found')

  if (idempotencyKey) {
    const existing = await findMarkerByKey(client, organizationId, idempotencyKey)
    if (existing) {
      if (!sameMarker(existing, { donationId, kind, amountCents: kind === 'refund' ? amountCents : null })) {
        throw new AdjustmentError(409, 'This request was already used for a different gift.')
      }
      return { replayed: true, reversal: existing, gift: locked }
    }
  }

  const { rowCount: fromCount } = await client.query(
    `SELECT 1 FROM ochr_cash_count_sessions
      WHERE donation_id = $1 AND organization_id = $2`,
    [donationId, organizationId]
  )
  if (fromCount) {
    throw new AdjustmentError(409,
      'This gift was posted from a cash count. Void the count instead, with a reason, so the count and the gift stay together.')
  }

  const postedVoid = await findPostedVoid(client, donationId, organizationId)
  if (postedVoid) throw new AdjustmentError(409, 'This gift is already voided.')

  const giftCents = decimalToCents(locked.amount)
  const reservedCents = decimalToCents(await reservedRefundTotal(client, donationId, organizationId))
  if (giftCents == null || reservedCents == null) {
    throw new AdjustmentError(500, 'This gift could not be read.')
  }
  const remainingCents = giftCents - reservedCents
  let postCents
  if (kind === 'void') {
    if (remainingCents <= 0) throw new AdjustmentError(409, 'This gift is already fully reversed.')
    postCents = remainingCents
  } else {
    postCents = amountCents == null ? remainingCents : amountCents
    if (remainingCents <= 0) throw new AdjustmentError(409, 'Nothing remains of this gift to refund.')
    if (postCents > remainingCents) {
      throw new AdjustmentError(409, 'That refund is more than what remains of this gift.')
    }
  }

  try {
    await client.query('SAVEPOINT marker_insert')
    const reversal = await insertRecordedMarker(client, {
      organizationId,
      donationId,
      amount: centsToDecimal(postCents),
      kind,
      reason,
      actor,
      idempotencyKey,
    })
    await client.query('RELEASE SAVEPOINT marker_insert')
    return { replayed: false, reversal, gift: locked }
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT marker_insert').catch(() => {})
    if (err?.code === '23505' && err.constraint === 'uq_donation_refunds_idempotency') {
      const existing = await findMarkerByKey(client, organizationId, idempotencyKey)
      if (sameMarker(existing, { donationId, kind, amountCents: kind === 'refund' ? amountCents : null })) {
        return { replayed: true, reversal: existing, gift: locked }
      }
      throw new AdjustmentError(409, 'This request was already used for a different gift.')
    }
    if (err?.code === '23505' && err.constraint === 'uq_donation_refunds_one_void') {
      throw new AdjustmentError(409, 'This gift is already voided.')
    }
    if (err?.code === '23514') {
      throw new AdjustmentError(409, 'That refund is more than what remains of this gift.')
    }
    throw err
  }
}

// Issued statements that still name this gift. Read-only: the snapshot
// stays what was issued. The caller flags; it does not supersede.
export async function issuedStatementsForGift(client, organizationId, donationId) {
  const { rows } = await client.query(
    `SELECT s.id, s.statement_no, s.tax_year
       FROM ochr_giving_statements s
      WHERE s.organization_id = $1
        AND s.status = 'issued'
        AND EXISTS (
          SELECT 1
            FROM jsonb_array_elements(COALESCE(s.snapshot_json->'lines', '[]'::jsonb)) line
           WHERE line->>'donation_id' = $2::text
        )
      ORDER BY s.issued_at ASC, s.id ASC`,
    [organizationId, String(donationId)]
  )
  return rows
}
