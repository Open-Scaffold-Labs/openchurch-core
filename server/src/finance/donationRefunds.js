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
