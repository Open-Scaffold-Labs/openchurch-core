// Notification infrastructure — vendor-neutral persistence so the
// reminder feature can ship now (with a stub transport that logs
// everything it would have sent) and flip to a real provider when the
// team lead picks Resend / Postmark / SES / etc.
//
// Two tables:
//   ochr_notification_prefs  — per-user × per-notification-type enable
//                              flag. Opt-out model (no row = enabled).
//   ochr_notification_log    — every notification dispatched through
//                              notify(), including the rendered subject
//                              + body. Status field tracks lifecycle:
//                              'stubbed' (current default), 'skipped'
//                              (user pref off), 'queued' (sent to a
//                              real provider), 'sent', 'failed'.
//
// Idempotent — IF NOT EXISTS lets re-runs no-op on dev boots.

import pool from '../db.js'

export async function up() {
  console.log('Migration 007: notifications — applying...')

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_notification_prefs (
      user_id           INTEGER NOT NULL REFERENCES ochr_users(id) ON DELETE CASCADE,
      notification_type TEXT NOT NULL,
      enabled           BOOLEAN NOT NULL DEFAULT TRUE,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_id, notification_type)
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_notification_log (
      id                SERIAL PRIMARY KEY,
      organization_id   INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      user_id           INTEGER REFERENCES ochr_users(id) ON DELETE SET NULL,
      recipient_email   TEXT,
      notification_type TEXT NOT NULL,
      channel           TEXT NOT NULL DEFAULT 'email',
      subject           TEXT,
      body              TEXT,
      status            TEXT NOT NULL,
      error             TEXT,
      created_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `)

  // Org-scoped chronological list — for an admin "what notifications
  // went out lately?" view we may build later.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_notification_log_org_created
      ON ochr_notification_log(organization_id, created_at DESC)
  `)

  // Per-recipient lookup — for "show me what I've been notified
  // about" views (e.g. an inbox panel).
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_notification_log_user
      ON ochr_notification_log(user_id, created_at DESC)
  `)

  console.log('Migration 007: notifications — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
