// 124 — staff-requested, admin-approved void of a confirmed cash count
// (José, 21 Oct 2026, 7:38 PM PT).
//
// ADDITIVE ONLY: one new table, one nullable column on ochr_notifications,
// one (id, organization_id) key on ochr_cash_count_sessions so the request
// can name its count tenant-compositely. No existing row is rewritten.
//
//   ochr_cash_count_void_requests — a request moves no money. It is
//     pending until an admin who is not the requester approves (the #358
//     void then posts in the same transaction) or rejects it. A count has at
//     most one pending request (partial unique index). 'superseded' marks a
//     pending request whose count was voided directly by an admin.
//
//   ochr_notifications.recipient_user_id — the existing in-app bell feed is
//     parish-wide. A row with a recipient is shown only to that user, so a
//     void request can reach each admin without showing in everyone's bell.
//     NULL keeps today's parish-wide behaviour for every existing row.

import pool from '../db.js'

const T = 'ochr_cash_count_void_requests'

export async function up() {
  console.log('Migration 124: cash-count-void-requests — applying...')

  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ochr_cash_count_sessions_id_org_key') THEN
        ALTER TABLE ochr_cash_count_sessions ADD CONSTRAINT ochr_cash_count_sessions_id_org_key UNIQUE (id, organization_id);
      END IF;
    END $$
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${T} (
      id                   BIGSERIAL PRIMARY KEY,
      organization_id      INTEGER     NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      cash_count_id           INTEGER     NOT NULL,
      reason               TEXT        NOT NULL,
      status               TEXT        NOT NULL DEFAULT 'pending',
      requested_by_user_id INTEGER,
      requested_by_name    TEXT,
      requested_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      decided_by_user_id   INTEGER,
      decided_by_name      TEXT,
      decided_at           TIMESTAMPTZ,
      decision_note        TEXT,
      void_refund_id       BIGINT,
      CONSTRAINT ochr_ccvr_status_check CHECK (status IN ('pending', 'approved', 'rejected', 'superseded')),
      CONSTRAINT ochr_ccvr_reason_check CHECK (length(reason) > 0),
      CONSTRAINT ochr_ccvr_decided_check CHECK (status = 'pending' OR decided_at IS NOT NULL),
      CONSTRAINT ochr_ccvr_approved_check CHECK (status <> 'approved' OR void_refund_id IS NOT NULL),
      CONSTRAINT ochr_ccvr_session_fk FOREIGN KEY (cash_count_id, organization_id)
        REFERENCES ochr_cash_count_sessions (id, organization_id) ON DELETE RESTRICT,
      CONSTRAINT ochr_ccvr_requested_by_fk FOREIGN KEY (requested_by_user_id, organization_id)
        REFERENCES ochr_users (id, organization_id) ON DELETE SET NULL (requested_by_user_id),
      CONSTRAINT ochr_ccvr_decided_by_fk FOREIGN KEY (decided_by_user_id, organization_id)
        REFERENCES ochr_users (id, organization_id) ON DELETE SET NULL (decided_by_user_id),
      CONSTRAINT ochr_ccvr_void_refund_fk FOREIGN KEY (void_refund_id, organization_id)
        REFERENCES ochr_donation_refunds (id, organization_id) ON DELETE RESTRICT
    )
  `)
  await pool.query(`ALTER TABLE ${T} ENABLE ROW LEVEL SECURITY`)
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_ccvr_one_pending
      ON ${T} (organization_id, cash_count_id) WHERE status = 'pending'
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ccvr_org_status ON ${T} (organization_id, status, requested_at DESC)
  `)

  await pool.query(`ALTER TABLE ochr_notifications ADD COLUMN IF NOT EXISTS recipient_user_id INTEGER`)
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ochr_notifications_recipient_fk') THEN
        ALTER TABLE ochr_notifications ADD CONSTRAINT ochr_notifications_recipient_fk
          FOREIGN KEY (recipient_user_id, organization_id)
          REFERENCES ochr_users (id, organization_id) ON DELETE CASCADE;
      END IF;
    END $$
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ochr_notifications_recipient
      ON ochr_notifications (organization_id, recipient_user_id) WHERE recipient_user_id IS NOT NULL
  `)
  const { rows: roles } = await pool.query(
    `SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')`)
  for (const { rolname } of roles) {
    await pool.query(`REVOKE ALL ON ${T} FROM ${rolname}`)
  }
  // Same as 119/120: a new org-scoped table carries the 114 hold guard, so a
  // held parish cannot open or decide void requests.
  await pool.query(`DROP TRIGGER IF EXISTS ochr_organization_hold_guard ON ${T}`)
  await pool.query(`CREATE TRIGGER ochr_organization_hold_guard
    BEFORE INSERT OR UPDATE OR DELETE ON ${T}
    FOR EACH ROW EXECUTE FUNCTION ochr_held_organization_write_guard()`)
  console.log('Migration 124: cash-count-void-requests — done.')
}
