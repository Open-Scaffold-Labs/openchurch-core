// Scheduled-notification queue. The trigger points (POST /api/events,
// task assignment, etc.) write a row here with a future send_at; a
// drainer (manual POST /api/admin/notifications/drain today, Vercel
// cron once the deploy lands) picks up due rows, runs them through
// notify(), and marks them sent/failed.
//
// Status lifecycle:
//   'pending'   — created by scheduleNotification, waiting for send_at
//   'sent'      — drainer ran notify() successfully
//   'failed'    — notify() threw; error column captures the message
//   'cancelled' — reserved for a future "cancel scheduled reminders
//                 when the event is deleted" pass; not used yet
//
// vars is JSONB so the templated payload survives a redeploy without
// schema-versioning the templates. The drainer hands vars straight
// into notify({ vars }) which renders against the current template.
//
// Idempotent — IF NOT EXISTS lets re-runs no-op on dev boots.

import pool from '../db.js'

export async function up() {
  console.log('Migration 008: scheduled-notifications — applying...')

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_scheduled_notifications (
      id                SERIAL PRIMARY KEY,
      organization_id   INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      user_id           INTEGER REFERENCES ochr_users(id) ON DELETE SET NULL,
      recipient_email   TEXT,
      notification_type TEXT NOT NULL,
      vars              JSONB NOT NULL DEFAULT '{}',
      send_at           TIMESTAMPTZ NOT NULL,
      status            TEXT NOT NULL DEFAULT 'pending',
      attempted_at      TIMESTAMPTZ,
      sent_at           TIMESTAMPTZ,
      error             TEXT,
      created_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `)

  // The drainer's hot query is "pending rows whose send_at has
  // passed". Index supports it so the drainer scales as the queue
  // grows.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_due
      ON ochr_scheduled_notifications(status, send_at)
      WHERE status = 'pending'
  `)

  console.log('Migration 008: scheduled-notifications — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
