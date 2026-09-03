// Notification drain fairness — a newly queued reminder must not be
// starved behind a backlog that keeps failing to drain.
//
// The bug, precisely. `processDueNotifications` claims the oldest due
// rows first, which is right. It also reaps claims older than ten
// minutes back to 'pending', which is also right — a drainer killed by a
// cron timeout or a redeploy must not silently swallow the reminders it
// had claimed.
//
// Together they starve. If one row in the oldest batch reliably kills
// the drainer — a recipient the transport hangs on, a payload that
// throws before the per-row catch, a cron window shorter than the batch
// — then every tick reaps the same rows back to 'pending', re-claims the
// same oldest rows, dies in the same place, and nothing queued after
// them ever sends. Not slowly: never. The queue looks busy the whole
// time, and the row that mattered was somebody's baptism reminder.
//
// `attempts` is the fix, and it is deliberately a counter rather than a
// timestamp: ordering by (attempts, send_at) means a row that has
// already consumed drain capacity goes BEHIND a row that has never had a
// turn, while rows with equal history stay strictly oldest-first. FIFO
// where it is fair, and yielding where it is not.
//
// It also bounds the loop: a row that has been claimed MAX_ATTEMPTS
// times without ever confirming is parked as failed with its reason,
// where an operator can see it, instead of cycling forever.
//
// Backfilled to 0, not to 1. Rows already in the queue have not had
// their turn either.

import pool from '../db.js'

export async function up() {
  console.log('Migration 081: notification fairness — applying...')

  await pool.query(`
    ALTER TABLE ochr_scheduled_notifications
      ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0
  `)

  // The claim query's exact ordering, as a partial index: only pending
  // rows are ever selected, and a queue's pending set is the small part.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_claim
      ON ochr_scheduled_notifications(attempts ASC, send_at ASC)
     WHERE status = 'pending'
  `)

  console.log('Migration 081: notification fairness — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
