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
  const { rows } = await pool.query(
    `INSERT INTO ochr_scheduled_notifications
       (organization_id, user_id, recipient_email, notification_type, vars, send_at, source_type, source_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
     RETURNING id, send_at, status`,
    [organizationId, userId, recipient, notification_type, JSON.stringify(vars), sendAt.toISOString(), sourceType, sourceId]
  )
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
  const { rowCount: gaveUp } = await pool.query(
    `UPDATE ochr_scheduled_notifications
        SET status = 'failed',
            error  = COALESCE(error, 'never confirmed after ' || attempts || ' attempts')
      WHERE status = 'processing'
        AND attempted_at < NOW() - INTERVAL '10 minutes'
        AND attempts >= $1`,
    [MAX_ATTEMPTS]
  )

  await pool.query(
    `UPDATE ochr_scheduled_notifications
        SET status = 'pending'
      WHERE status = 'processing'
        AND attempted_at < NOW() - INTERVAL '10 minutes'`
  )

  // Atomic claim: flip pending → 'processing' for up to batchSize
  // due rows and return them. If no rows match (all done or all in
  // the future), the function returns the zero counts immediately.
  const { rows: claimed } = await pool.query(
    `UPDATE ochr_scheduled_notifications
        SET status = 'processing', attempted_at = NOW(), attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM ochr_scheduled_notifications
         WHERE status = 'pending' AND send_at <= $1
         ORDER BY attempts ASC, send_at ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED
      )
      RETURNING *`,
    [now.toISOString(), batchSize]
  )

  let sent = 0, failed = 0
  for (const row of claimed) {
    try {
      await notify({
        organizationId:    row.organization_id,
        userId:            row.user_id,
        recipient:         row.recipient_email,
        notification_type: row.notification_type,
        vars:              row.vars ?? {},
      })
      await pool.query(
        `UPDATE ochr_scheduled_notifications
            SET status = 'sent', sent_at = NOW(), error = NULL
          WHERE id = $1`,
        [row.id]
      )
      sent++
    } catch (err) {
      await pool.query(
        `UPDATE ochr_scheduled_notifications
            SET status = 'failed', error = $2
          WHERE id = $1`,
        [row.id, err.message ?? String(err)]
      )
      failed++
    }
  }

  return { processed: claimed.length, sent, failed, gaveUp }
}
