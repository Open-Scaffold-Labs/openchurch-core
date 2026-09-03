// Address health — the record of which mailboxes are dead or hostile.
//
// Vendor-neutral on purpose. Nothing in this module knows what a Resend
// event looks like; adapters translate a provider's payload into these
// three verbs, so swapping to Postmark or SES rewrites one adapter and
// leaves the send path alone.
//
// The rule this enforces: an address that hard-bounced or complained is
// never emailed again. Not "retried less often" — never, until a human
// clears it. Two reasons. A hard bounce is permanent by definition (the
// mailbox does not exist), so a retry cannot succeed and only spends
// domain reputation. And a complaint is a person saying stop, where
// continuing is the thing that gets a sending domain blocked outright.
//
// Soft bounces — full mailbox, temporary server failure — are deliberately
// NOT suppressed. Those recover, and treating them as permanent would
// quietly delete real recipients over time. Adapters decide which of the
// provider's event types are hard; this module trusts that decision.

import pool from '../db.js'

const norm = (email) => String(email ?? '').trim().toLowerCase()

// Is this address suppressed? Returns the row, or null.
//
// Called before every send, so it is one indexed lookup on lower(email)
// (migration 096). An empty or malformed address is not "suppressed" —
// it is a different failure, and pretending otherwise would hide it.
export async function suppressionFor(email) {
  const addr = norm(email)
  if (!addr) return null
  const { rows } = await pool.query(
    `SELECT id, email, reason, provider, detail, created_at
       FROM ochr_email_suppressions
      WHERE lower(email) = $1
      LIMIT 1`,
    [addr]
  )
  return rows[0] ?? null
}

export async function isSuppressed(email) {
  return (await suppressionFor(email)) !== null
}

// Record a suppression. Idempotent: webhooks retry, and a redelivered
// bounce must be a no-op rather than an error path.
//
// On conflict the EARLIEST reason wins rather than the latest. A complaint
// followed by a bounce is still a complaint — the stronger statement about
// intent — and re-recording would keep moving created_at forward, which
// destroys the only evidence of when the address actually went bad.
export async function suppress({ email, reason, provider = null, providerEventId = null, detail = null }) {
  const addr = norm(email)
  if (!addr) throw new Error('suppress: email is required')
  if (!['bounce', 'complaint', 'manual'].includes(reason)) {
    throw new Error(`suppress: unknown reason "${reason}"`)
  }
  const { rows } = await pool.query(
    `INSERT INTO ochr_email_suppressions (email, reason, provider, provider_event_id, detail)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (lower(email)) DO NOTHING
     RETURNING id`,
    [addr, reason, provider, providerEventId, detail ? String(detail).slice(0, 500) : null]
  )
  return { email: addr, reason, created: rows.length > 0 }
}

// Lift a suppression. The address was fixed, or the complaint was a
// misfire, or a member changed providers and kept the same local part.
// Deliberately a real operation and not a cascade: nothing in the system
// un-suppresses an address on its own, because every automatic path back
// is a path that re-mails the dead.
export async function unsuppress(email) {
  const addr = norm(email)
  if (!addr) return { email: addr, removed: false }
  const { rowCount } = await pool.query(
    `DELETE FROM ochr_email_suppressions WHERE lower(email) = $1`,
    [addr]
  )
  return { email: addr, removed: rowCount > 0 }
}

// Correct the delivery record for a specific send. The provider tells us
// asynchronously that a message it already accepted did not arrive; the
// log row currently says 'sent', and leaving it that way is the lie this
// whole change exists to stop.
//
// Matched on provider_message_id, which is the only handle the event
// carries. Returns how many rows were corrected — 0 is normal and not an
// error: a bounce can arrive for a send that predates this column.
export async function markDelivery({ providerMessageId, status, detail = null }) {
  if (!providerMessageId) return 0
  if (!['bounced', 'complained', 'delivered'].includes(status)) {
    throw new Error(`markDelivery: unknown status "${status}"`)
  }
  const { rowCount } = await pool.query(
    `UPDATE ochr_notification_log
        SET status = $2,
            error  = COALESCE($3, error)
      WHERE provider_message_id = $1`,
    [providerMessageId, status, detail ? String(detail).slice(0, 500) : null]
  )
  return rowCount
}
