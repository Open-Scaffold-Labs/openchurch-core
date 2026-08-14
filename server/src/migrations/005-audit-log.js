// Audit log table — one row per successful mutation across the
// tenant-scoped routes. Designed so admins can answer "who changed
// what, when?" without grepping logs.
//
// Design notes:
//   - user_id is nullable + ON DELETE SET NULL so deleting a user
//     doesn't blow away the org's history. user_email + user_name
//     snapshots survive the deletion so the row stays interpretable.
//   - entity_id is TEXT — ochr_tasks uses TEXT primary keys; everything
//     else uses INT. Storing as TEXT keeps the column uniform.
//   - metadata is JSONB so we can stash request/response details
//     without a schema change.
//   - Indexes target the two queries the admin page will run:
//     (org, created_at) for the chronological list and
//     (org, entity_type, entity_id) for "show history of this thing".
//
// Idempotent — IF NOT EXISTS makes re-runs no-op on dev boots.

import pool from '../db.js'

export async function up() {
  console.log('Migration 005: audit-log — applying...')

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_audit_log (
      id              SERIAL PRIMARY KEY,
      organization_id INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      user_id         INTEGER REFERENCES ochr_users(id) ON DELETE SET NULL,
      user_email      TEXT,
      user_name       TEXT,
      action          TEXT NOT NULL,
      entity_type     TEXT NOT NULL,
      entity_id       TEXT,
      summary         TEXT,
      metadata        JSONB DEFAULT '{}',
      request_method  TEXT,
      request_path    TEXT,
      status_code     INTEGER,
      ip_address      TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `)

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_audit_log_org_created
      ON ochr_audit_log(organization_id, created_at DESC)
  `)

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_audit_log_entity
      ON ochr_audit_log(organization_id, entity_type, entity_id)
  `)

  console.log('Migration 005: audit-log — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
