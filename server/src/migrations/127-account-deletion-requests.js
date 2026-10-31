// 127 — account deletion REQUEST plumbing (P1 lane B, TARS #62 6380348243).
//
// ADDITIVE ONLY: one new table. No existing row is rewritten.
//
// A row here is a person's request that their account be deleted, and its
// confirmation/withdrawal status. It deletes nothing. Fulfilment (what is
// purged, what is kept for a lawful reason, who processes it) is NOT
// implemented: the field-level disposition policy is not approved
// (docs/app-store/P1-PRIVACY-DELETION-TABLE.md). `fulfilment_status` can
// therefore only be 'not_started'; widen the CHECK only together with the
// approved fulfilment code.

import pool from '../db.js'

const T = 'ochr_account_deletion_requests'

export async function up() {
  console.log('Migration 127: account-deletion-requests — applying...')
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${T} (
      id                BIGSERIAL PRIMARY KEY,
      organization_id   INTEGER     NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      user_id           INTEGER     NOT NULL,
      status            TEXT        NOT NULL DEFAULT 'requested',
      fulfilment_status TEXT        NOT NULL DEFAULT 'not_started',
      requested_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      confirmed_at      TIMESTAMPTZ,
      withdrawn_at      TIMESTAMPTZ,
      CONSTRAINT ochr_adr_status_check CHECK (status IN ('requested', 'confirmed', 'withdrawn')),
      CONSTRAINT ochr_adr_fulfilment_check CHECK (fulfilment_status IN ('not_started')),
      CONSTRAINT ochr_adr_user_fk FOREIGN KEY (user_id, organization_id)
        REFERENCES ochr_users (id, organization_id) ON DELETE CASCADE
    )
  `)
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ochr_adr_one_open
    ON ${T} (organization_id, user_id) WHERE status IN ('requested', 'confirmed')`)
  await pool.query(`ALTER TABLE ${T} ENABLE ROW LEVEL SECURITY`)
  const { rows: roles } = await pool.query(
    `SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')`)
  for (const { rolname } of roles) {
    await pool.query(`REVOKE ALL ON ${T} FROM ${rolname}`)
  }
  // HOLD boundary (Stage 6, migration 114): org-scoped tables carry the guard.
  await pool.query(`DROP TRIGGER IF EXISTS ochr_organization_hold_guard ON ${T}`)
  await pool.query(`CREATE TRIGGER ochr_organization_hold_guard
    BEFORE INSERT OR UPDATE OR DELETE ON ${T}
    FOR EACH ROW EXECUTE FUNCTION ochr_held_organization_write_guard()`)
  console.log('Migration 127: account-deletion-requests — done.')
}
