// Schedule-and-drain layer for notifications. Trigger points (event
// create, task assignment, etc.) call scheduleNotification(...) with
// a future send_at; the drainer picks up due rows and routes them
// through notify().
//
// Why a queue instead of setTimeout: setTimeout doesn't survive a
// Vercel cold-start or a redeploy. A persistent queue does. The
// drainer can be invoked from a cron (Vercel Cron, GitHub Actions, a
// real worker) — for now there's a manual admin endpoint that an
// operator can poke during dev or while we wait on the deploy.
//
// The transport itself is unchanged — notify() does pref check +
// render + dispatch. The drainer is just the thing that calls it at
// the right time.

import { sqlNormEmail } from '../utils/emailNorm.js'
import { isHoldRefusal } from '../auth/organizationHold.js'
import pool from '../db.js'
import { notify } from './transport.js'

// Insert a pending row. Caller decides the sendAt — usually computed
// as "event date - 24h" or similar from the trigger context.
export async function scheduleNotification({
  organizationId,
  userId           = null,
  recipient        = null,
  notification_type,
  vars             = {},
  sendAt,
  sourceType       = null,
  sourceId         = null,
}) {
  if (!organizationId) throw new Error('organizationId is required')
  if (!notification_type) throw new Error('notification_type is required')
  if (!(sendAt instanceof Date) || Number.isNaN(sendAt.getTime())) {
    throw new Error('sendAt must be a valid Date')
  }

  // source_type / source_id (RM.1) back-reference the originating row so
  // a re-sync or cancel can find this reminder later. Null for ad-hoc
  // reminders that are never re-synced.
  let rows
  try {
    ({ rows } = await pool.query(
      `INSERT INTO ochr_scheduled_notifications
         (organization_id, user_id, recipient_email, notification_type, vars, send_at, source_type, source_id)
       SELECT $1, $2, $3, $4, $5::jsonb, $6, $7, $8
         FROM ochr_organizations WHERE id = $1 AND held_at IS NULL
       RETURNING id, send_at, status`,
      [organizationId, userId, recipient, notification_type, JSON.stringify(vars), sendAt.toISOString(), sourceType, sourceId]
    ))
  } catch (err) {
    // The organization was deleted between this statement's snapshot and
    // its FK check. Same answer as an absent org above: nothing enqueued.
    // Without this, one parish being deleted aborts a global enqueue run
    // for every other parish.
    if (err?.code === '23503' && err?.constraint === 'ochr_scheduled_notifications_organization_id_fkey') return undefined
    throw err
  }
  return rows[0]
}

// A row may be claimed this many times without ever confirming before it
// is parked as failed. Five is enough to survive a genuinely unlucky run
// of redeploys, and small enough that a poisoned row cannot hold the
// queue for a day. Parked, not deleted: an operator has to be able to
// see what it was and why it never went.
export const MAX_ATTEMPTS = 5

// Process the next batch of due notifications. Each row's status is
// flipped under a single UPDATE ... RETURNING so two concurrent
// drainers can't pick the same row twice (the status='pending' guard
// in the WHERE clause will fail for any losing claimer).
//
// FAIRNESS (migration 081). Claims are ordered by (attempts, send_at),
// not send_at alone. Strict oldest-first plus the reaper below is a
// starvation loop: if one row in the oldest batch reliably kills the
// drainer, every tick reaps the same rows back to 'pending', re-claims
// the same rows, dies in the same place, and nothing queued afterwards
// ever sends. Ordering by attempts first means a row that has already
// had a turn steps behind a row that has never had one, while rows with
// equal history stay strictly oldest-first.
//
// Returns counts so an operator (or cron job report) can see what
// happened: { processed, sent, failed, gaveUp }.
export async function processDueNotifications({ now = new Date(), batchSize = 50 } = {}) {
  // Reap stranded claims first. A drainer that died mid-batch (cron
  // timeout, redeploy) leaves rows in 'processing' forever — nothing
  // re-selects them, so the reminder silently never fires. Any claim
  // older than 10 minutes is dead (a batch is 50 emails); return it
  // to the queue. Rows that already sent were flipped to 'sent'
  // before their claim could age, so a reaped row re-sends at most a
  // reminder whose send was never confirmed — the right tradeoff for
  // "the reminder must go out".
  // A row that has burned through MAX_ATTEMPTS claims without ever
  // confirming is not going to send. Park it with its reason rather than
  // returning it to the queue for a sixth identical death.
  // A HOLD committing mid-statement refuses the statement as a whole; the
  // second attempt reads the hold and excludes that organization.
  const onceMore = async run => {
    try { return await run() } catch (err) {
      if (!isHoldRefusal(err)) throw err
      return run()
    }
  }
  const { rowCount: gaveUp } = await onceMore(() => pool.query(
    `UPDATE ochr_scheduled_notifications
        SET status = 'failed',
            error  = COALESCE(error, 'never confirmed after ' || attempts || ' attempts')
      WHERE status = 'processing'
        AND attempted_at < NOW() - INTERVAL '10 minutes'
        AND attempts >= $1
        -- A held organization's rows are left exactly as they are: its
        -- writes are refused (migration 114), and one held parish must not
        -- stop the reaper, and so the queue, for every other parish.
        AND organization_id IN (SELECT id FROM ochr_organizations WHERE held_at IS NULL)`,
    [MAX_ATTEMPTS]
  ))

  await onceMore(() => pool.query(
    `UPDATE ochr_scheduled_notifications
        SET status = 'pending'
      WHERE status = 'processing'
        AND attempted_at < NOW() - INTERVAL '10 minutes'
        AND organization_id IN (SELECT id FROM ochr_organizations WHERE held_at IS NULL)`
  ))

  // F-06 / ARG-PATCH-2-1: never send to a closed or deactivated login.
  // Due rows whose user_id is such a login, or whose recipient address is
  // a closed/deactivated login in the same org, are cancelled instead of
  // claimed. (Closure and deactivation also cancel up front; this is the
  // backstop for rows queued by any other path or racing the state change.)
  // R286-2: same HOLD contract as the reapers above — a held parish's rows
  // are left exactly as they are (HOLD deactivates its users; migration 114
  // refuses the write), and a HOLD committing mid-statement is retried once.
  await onceMore(() => pool.query(
    `UPDATE ochr_scheduled_notifications n
        SET status = 'cancelled',
            error  = COALESCE(n.error, 'cancelled: recipient login closed or deactivated')
      WHERE n.status = 'pending' AND n.send_at <= $1
        AND (
          EXISTS (SELECT 1 FROM ochr_users u
                   WHERE u.id = n.user_id
                     AND (u.closed_at IS NOT NULL OR u.deactivated_at IS NOT NULL))
          OR (n.recipient_email IS NOT NULL AND EXISTS (
                SELECT 1 FROM ochr_users u
                 WHERE u.organization_id = n.organization_id
                   AND ${sqlNormEmail('u.email')} = ${sqlNormEmail('n.recipient_email')}
                   AND (u.closed_at IS NOT NULL OR u.deactivated_at IS NOT NULL)))
        )
        AND n.organization_id IN (SELECT id FROM ochr_organizations WHERE held_at IS NULL)`,
    [now.toISOString()]
  ))

  // Atomic claim: flip pending → 'processing' for up to batchSize
  // due rows and return them. If no rows match (all done or all in
  // the future), the function returns the zero counts immediately.
  const claim = () => pool.query(
    `UPDATE ochr_scheduled_notifications
        SET status = 'processing', attempted_at = NOW(), attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM ochr_scheduled_notifications
         WHERE status = 'pending' AND send_at <= $1
           AND EXISTS (SELECT 1 FROM ochr_organizations o
                       WHERE o.id = ochr_scheduled_notifications.organization_id AND o.held_at IS NULL)
         ORDER BY attempts ASC, send_at ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED
      )
      RETURNING *`,
    [now.toISOString(), batchSize]
  )
  const { rows: claimed } = await onceMore(claim)

  // Bookkeeping for a row whose organization was held after it was claimed
  // is refused by the database. Leave that row as it is and carry on with
  // everyone else's.
  const settle = async (sql, params) => {
    try { await pool.query(sql, params); return true } catch (err) {
      if (isHoldRefusal(err)) return false
      throw err
    }
  }

  let sent = 0, failed = 0, cancelled = 0, unconfigured = 0, providerFailed = 0, pushNotAccepted = 0, optedOut = 0, suppressed = 0
  for (const row of claimed) {
    try {
      const delivery = await notify({
        organizationId:    row.organization_id,
        userId:            row.user_id,
        recipient:         row.recipient_email,
        notification_type: row.notification_type,
        vars:              row.vars ?? {},
        scheduledId:       row.id,
      })
      if (delivery?.reason === 'organization_held') {
        // HOLD landed after claiming. Preserve the queued row without
        // falsely reporting a send, and do not consume a retry attempt.
        await settle(
          `UPDATE ochr_scheduled_notifications SET status = 'pending',
             attempted_at = NULL, attempts = GREATEST(attempts - 1, 0) WHERE id = $1`,
          [row.id],
        )
        continue
      }
      if (delivery?.reason === 'recipient_inactive') {
        // R286-3: the recipient's login was closed or deactivated after
        // this row was claimed. notify() refused before any provider call.
        // Not a send, not a failure.
        await settle(
          `UPDATE ochr_scheduled_notifications
              SET status = 'cancelled', error = 'cancelled: ' || $2
            WHERE id = $1 AND status = 'processing'`,
          [row.id, delivery.detail || 'recipient login closed or deactivated'],
        )
        cancelled++
        continue
      }
      // P-1 / R299 (TARS): settle 'sent' only on a positively known
      // delivery (provider-accepted email or push), or the deliberately
      // preserved dev/test stub. An intentional no-send (opt-out, address
      // suppression) is cancelled with its reason; an unconfigured
      // transport, provider failure, unaccepted push or any unknown
      // outcome fails closed with the outcome as the error prefix.
      // No retry is scheduled for any of these.
      const stubOk = delivery?.status === 'stubbed' && process.env.NODE_ENV !== 'production'
      if (!(delivery?.status === 'sent' || stubOk)) {
        const noSend = delivery?.reason === 'opted_out' || delivery?.reason === 'suppressed'
        let outcome = delivery?.reason
        if (!['unconfigured', 'provider_failed', 'push_not_accepted', 'opted_out', 'suppressed'].includes(outcome)) {
          outcome = delivery?.status === 'stubbed' ? 'unconfigured'
            : delivery?.status === 'failed' ? 'provider_failed' : 'unknown_outcome'
        }
        const detail = String(delivery?.detail ?? delivery?.error ?? delivery?.status ?? 'no result')
        await settle(
          `UPDATE ochr_scheduled_notifications
              SET status = $3, error = $2
            WHERE id = $1 AND status = 'processing'`,
          [row.id, detail.startsWith(outcome + ':') ? detail : `${outcome}: ${detail}`, noSend ? 'cancelled' : 'failed'],
        )
        if (noSend) { if (outcome === 'opted_out') optedOut++; else suppressed++; continue }
        failed++
        if (outcome === 'unconfigured') unconfigured++
        else if (outcome === 'provider_failed') providerFailed++
        else if (outcome === 'push_not_accepted') pushNotAccepted++
        continue
      }
      await settle(
        `UPDATE ochr_scheduled_notifications
            SET status = 'sent', sent_at = NOW(), error = NULL
          WHERE id = $1 AND status = 'processing'`,
        [row.id]
      )
      sent++
    } catch (err) {
      await settle(
        `UPDATE ochr_scheduled_notifications
            SET status = 'failed', error = $2
          WHERE id = $1 AND status = 'processing'`,
        [row.id, err.message ?? String(err)]
      )
      failed++
    }
  }

  return { processed: claimed.length, sent, failed, gaveUp, cancelled, unconfigured, provider_failed: providerFailed,
    push_not_accepted: pushNotAccepted, opted_out: optedOut, suppressed }
}
