// Level B — permanent staff/login closure.
//
// Distinct from reversible deactivation (111). The row stays so parish
// history can still point at the same actor. The personal name, email,
// avatar, and usable password do not. The original email can be used
// again only as a new login. This does not delete a member, a gift, a
// register row, or the organization, and it does not promise that every
// copy anywhere is gone.

import pool from '../db.js'

export async function up() {
  console.log('Migration 112: login-closure — applying...')

  await pool.query(`
    ALTER TABLE ochr_users
      ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS closed_by INTEGER
  `)

  await pool.query(`
    ALTER TABLE ochr_users DROP CONSTRAINT IF EXISTS ochr_users_closed_email_chk
  `)
  await pool.query(`
    ALTER TABLE ochr_users ADD CONSTRAINT ochr_users_closed_email_chk
      CHECK (
        closed_at IS NULL
        OR email = ('closed-user-' || id::text || '@login-closed.invalid')
      )
  `)
  await pool.query(`
    ALTER TABLE ochr_users DROP CONSTRAINT IF EXISTS ochr_users_closed_name_chk
  `)
  await pool.query(`
    ALTER TABLE ochr_users ADD CONSTRAINT ochr_users_closed_name_chk
      CHECK (closed_at IS NULL OR name = '')
  `)
  await pool.query(`
    ALTER TABLE ochr_users DROP CONSTRAINT IF EXISTS ochr_users_closed_avatar_chk
  `)
  await pool.query(`
    ALTER TABLE ochr_users ADD CONSTRAINT ochr_users_closed_avatar_chk
      CHECK (closed_at IS NULL OR avatar IS NULL)
  `)
  await pool.query(`
    ALTER TABLE ochr_users DROP CONSTRAINT IF EXISTS ochr_users_closed_deactivated_chk
  `)
  await pool.query(`
    ALTER TABLE ochr_users ADD CONSTRAINT ochr_users_closed_deactivated_chk
      CHECK (closed_at IS NULL OR deactivated_at IS NOT NULL)
  `)

  await pool.query(`
    CREATE OR REPLACE FUNCTION ochr_users_reject_closure_restore()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    BEGIN
      IF OLD.closed_at IS NOT NULL THEN
        IF NEW.closed_at IS DISTINCT FROM OLD.closed_at
           OR NEW.deactivated_at IS NULL
           OR NEW.email IS DISTINCT FROM OLD.email
           OR NEW.name IS DISTINCT FROM OLD.name
           OR NEW.password_hash IS DISTINCT FROM OLD.password_hash
           OR NEW.avatar IS DISTINCT FROM OLD.avatar
           OR COALESCE(NEW.token_version, 0) < COALESCE(OLD.token_version, 0)
        THEN
          RAISE EXCEPTION 'closed login cannot be restored'
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $fn$
  `)
  await pool.query(`DROP TRIGGER IF EXISTS ochr_users_reject_closure_restore ON ochr_users`)
  await pool.query(`
    CREATE TRIGGER ochr_users_reject_closure_restore
      BEFORE UPDATE ON ochr_users
      FOR EACH ROW
      EXECUTE FUNCTION ochr_users_reject_closure_restore()
  `)

  // A late insert that still carries the JWT's name or email is rewritten
  // at insert time. A one-time cleanup cannot see a write that has not
  // happened yet. An insert that commits while closure is still open
  // would miss closed_at under read committed, so the insert waits on
  // the user row first and then reads the committed closure.
  await pool.query(`
    CREATE OR REPLACE FUNCTION ochr_minimize_closed_login_copy()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    DECLARE
      is_closed boolean;
    BEGIN
      IF NEW.user_id IS NULL THEN
        RETURN NEW;
      END IF;
      IF TG_OP = 'INSERT' THEN
        PERFORM 1 FROM ochr_users WHERE id = NEW.user_id FOR SHARE;
      END IF;
      SELECT (closed_at IS NOT NULL) INTO is_closed
        FROM ochr_users
       WHERE id = NEW.user_id;
      IF is_closed IS TRUE THEN
        NEW.user_email := NULL;
        IF TG_TABLE_NAME = 'ochr_audit_log' THEN
          NEW.user_name := NULL;
        END IF;
      END IF;
      RETURN NEW;
    END;
    $fn$
  `)
  await pool.query(`DROP TRIGGER IF EXISTS ochr_audit_minimize_closed_login ON ochr_audit_log`)
  await pool.query(`
    CREATE TRIGGER ochr_audit_minimize_closed_login
      BEFORE INSERT ON ochr_audit_log
      FOR EACH ROW
      EXECUTE FUNCTION ochr_minimize_closed_login_copy()
  `)
  await pool.query(`DROP TRIGGER IF EXISTS ochr_feedback_minimize_closed_login ON ochr_feedback_ledger`)
  await pool.query(`
    CREATE TRIGGER ochr_feedback_minimize_closed_login
      BEFORE INSERT ON ochr_feedback_ledger
      FOR EACH ROW
      EXECUTE FUNCTION ochr_minimize_closed_login_copy()
  `)
  // A write that is already in flight can UPDATE the copy after the
  // closure transaction commits. Insert-only protection would miss it.
  await pool.query(`DROP TRIGGER IF EXISTS ochr_audit_minimize_closed_login_update ON ochr_audit_log`)
  await pool.query(`
    CREATE TRIGGER ochr_audit_minimize_closed_login_update
      BEFORE UPDATE ON ochr_audit_log
      FOR EACH ROW
      EXECUTE FUNCTION ochr_minimize_closed_login_copy()
  `)
  await pool.query(`DROP TRIGGER IF EXISTS ochr_feedback_minimize_closed_login_update ON ochr_feedback_ledger`)
  await pool.query(`
    CREATE TRIGGER ochr_feedback_minimize_closed_login_update
      BEFORE UPDATE ON ochr_feedback_ledger
      FOR EACH ROW
      EXECUTE FUNCTION ochr_minimize_closed_login_copy()
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_login_closures (
      id                      BIGSERIAL PRIMARY KEY,
      organization_id         INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      user_id                 INTEGER NOT NULL,
      closed_by               INTEGER,
      closed_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      access_revoked          BOOLEAN NOT NULL DEFAULT TRUE,
      live_profile_processed  BOOLEAN NOT NULL DEFAULT TRUE,
      review_remaining        BOOLEAN NOT NULL DEFAULT TRUE,
      provider_status         TEXT NOT NULL,
      backup_status           TEXT NOT NULL,
      all_copies_erased       BOOLEAN NOT NULL DEFAULT FALSE,
      UNIQUE (organization_id, user_id),
      CONSTRAINT ochr_login_closures_not_erased CHECK (all_copies_erased = FALSE)
    )
  `)
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ochr_login_closures_user_org_fkey'
      ) THEN
        ALTER TABLE ochr_login_closures
          ADD CONSTRAINT ochr_login_closures_user_org_fkey
          FOREIGN KEY (user_id, organization_id)
          REFERENCES ochr_users (id, organization_id)
          ON DELETE CASCADE;
      END IF;
    END $$
  `)
  await pool.query(`ALTER TABLE ochr_login_closures ENABLE ROW LEVEL SECURITY`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_login_closure_reviews (
      id               BIGSERIAL PRIMARY KEY,
      organization_id  INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      user_id          INTEGER NOT NULL,
      kind             TEXT NOT NULL,
      row_count        INTEGER NOT NULL DEFAULT 0,
      disposition      TEXT NOT NULL,
      note             TEXT NOT NULL,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ochr_login_closure_reviews_user_org_fkey'
      ) THEN
        ALTER TABLE ochr_login_closure_reviews
          ADD CONSTRAINT ochr_login_closure_reviews_user_org_fkey
          FOREIGN KEY (user_id, organization_id)
          REFERENCES ochr_users (id, organization_id)
          ON DELETE CASCADE;
      END IF;
    END $$
  `)
  await pool.query(`ALTER TABLE ochr_login_closure_reviews ENABLE ROW LEVEL SECURITY`)

  const { rows: col } = await pool.query(`
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'ochr_users' AND column_name = 'closed_at'
  `)
  if (!col.length) throw new Error('112: ochr_users.closed_at was not created')

  const { rows: trig } = await pool.query(`
    SELECT 1 FROM pg_trigger WHERE tgname = 'ochr_users_reject_closure_restore'
  `)
  if (!trig.length) throw new Error('112: closure restore trigger was not created')

  const { rows: rls } = await pool.query(`
    SELECT relrowsecurity FROM pg_class WHERE relname = 'ochr_login_closures'
  `)
  if (!rls.length || rls[0].relrowsecurity !== true) {
    throw new Error('112: row level security is not enabled on ochr_login_closures')
  }

  console.log('Migration 112: login-closure — applied.')
}
