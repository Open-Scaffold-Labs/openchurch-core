// Durable receipt for verified webhook events (Stage 6).
//
// Order of operations for every verified event:
//   1. store it (one row per provider event id; a redelivery finds the row);
//   2. apply it, unless an earlier delivery already applied it;
//   3. record the outcome on the row.
// The provider is told "received" only after step 1 committed. A refusal in
// step 2 because the organization is on hold is recorded as 'held' and
// acknowledged: the event is kept here for reconciliation, and the parish's
// business data is not changed. Any other failure is recorded as 'failed'
// and answered 5xx so the provider also redelivers. Nothing here contacts
// the provider, charges, refunds or changes a subscription.

import crypto from 'node:crypto'
import pool from '../db.js'
import { applyWebhookEvent } from './provider.js'
import { isHoldRefusal } from '../auth/organizationHold.js'
import { monitor } from '../monitoring/index.js'

const PROVIDER = 'stripe'

function eventIdOf(event, rawBody) {
  if (typeof event?.id === 'string' && event.id.length > 0 && event.id.length <= 255) return event.id
  // A verified event without an id is still a fact; key it by its bytes.
  const bytes = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? JSON.stringify(event)))
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`
}

function organizationIdOf(event) {
  const obj = event?.data?.object ?? {}
  const n = Number(obj.metadata?.organization_id ?? obj.client_reference_id)
  return Number.isSafeInteger(n) && n > 0 && n <= 2147483647 ? n : null
}

// Step 1. Throws when the row could not be stored: the caller must not
// acknowledge the event then.
export async function storeVerifiedEvent(event, rawBody) {
  const eventId = eventIdOf(event, rawBody)
  const orgId = organizationIdOf(event)
  const params = [PROVIDER, eventId, event?.type ?? null, event]
  // organization_id is informational; an id that names no organization is
  // stored as unknown rather than refusing the receipt.
  const { rows: [inserted] } = await pool.query(
    `INSERT INTO ochr_billing_event_receipts (provider, event_id, event_type, organization_id, payload)
     VALUES ($1, $2, $3, (SELECT id FROM ochr_organizations WHERE id = $5), $4::jsonb)
     ON CONFLICT (provider, event_id) DO NOTHING
     RETURNING id, status`,
    [...params, orgId]
  )
  if (inserted) return { receiptId: inserted.id, status: inserted.status, duplicate: false }
  const { rows: [existing] } = await pool.query(
    'SELECT id, status FROM ochr_billing_event_receipts WHERE provider = $1 AND event_id = $2', [PROVIDER, eventId])
  return { receiptId: existing.id, status: existing.status, duplicate: true }
}

// A claim older than this is presumed abandoned (the process died mid-apply)
// and may be claimed again. Applying is idempotent, so a second apply after
// a lease expires cannot double-record.
const CLAIM_LEASE = '5 minutes'

// Steps 2–3 for a stored receipt. Returns { status, result?, error?,
// duplicate?, inProgress? }.
//
// No connection is held while the event is applied: the apply itself uses
// the pool (several statements, sometimes a notification), and holding a
// second connection across it starves a small pool when a checkout's
// events arrive together (cf. routes/events.js). Instead one worker CLAIMS
// the receipt with a guarded update, applies, and records the outcome
// against its claim.
export async function applyStoredEvent(receiptId) {
  const { rows: [claimed] } = await pool.query(
    `UPDATE ochr_billing_event_receipts
        SET status = 'applying', claimed_at = NOW(), attempts = attempts + 1, last_attempt_at = NOW()
      WHERE id = $1
        AND (status IN ('received', 'deferred', 'held', 'failed')
             OR (status = 'applying' AND claimed_at < NOW() - INTERVAL '${CLAIM_LEASE}'))
      RETURNING payload, claimed_at::text AS claim`,
    [receiptId])
  if (!claimed) {
    const { rows: [r] } = await pool.query('SELECT status, result FROM ochr_billing_event_receipts WHERE id = $1', [receiptId])
    if (!r) return { status: 'missing' }
    // Answer a redelivery the way the first delivery was answered.
    if (r.status === 'applied') return { status: 'applied', duplicate: true, result: r.result ?? undefined }
    return { status: r.status, inProgress: true }
  }

  let outcome
  try {
    const result = await applyWebhookEvent(claimed.payload)
    // Billing not switched on: verified, nothing applied. Not 'applied', so
    // it stays in the open list and is re-processed once billing is live.
    outcome = result?.stub ? { status: 'deferred', result } : { status: 'applied', result }
  } catch (err) {
    outcome = isHoldRefusal(err)
      ? { status: 'held', error: 'Organization is on hold; event kept for reconciliation, not applied.' }
      : { status: 'failed', error: String(err?.message ?? err).slice(0, 500) }
    if (outcome.status === 'failed') monitor.error('billing.webhook.apply', err, { receiptId })
    else monitor.warn('billing.webhook.held_organization', 'Verified event stored; organization on hold, not applied.', { receiptId })
  }
  await pool.query(
    `UPDATE ochr_billing_event_receipts
        SET status = $2, last_error = $3, result = $4::jsonb, claimed_at = NULL,
            applied_at = CASE WHEN $2 = 'applied' THEN NOW() ELSE applied_at END
      WHERE id = $1 AND status = 'applying' AND claimed_at = $5::timestamptz`,
    [receiptId, outcome.status, outcome.error ?? null, outcome.result ? JSON.stringify(outcome.result) : null, claimed.claim])
  return outcome
}
