// 131 — self-serve login deletion (C3, Dale #342 comment 6429592110).
//
// ADDITIVE. Widens the deletion-request fulfilment check so a confirmed
// request can be marked completed, and stores a tombstone UUID in place
// of a telemetry/audit actor id.
//
// This migration does not update or delete ochr_sacramental_records,
// sacrament amendments, donations, refunds, or ledger rows. Voiding a
// gift is not a step here.
//
// It also adds a BEFORE INSERT OR UPDATE trigger on ochr_audit_log,
// ochr_ai_audit, and ochr_ai_usage that replaces a deleted login's actor
// id with its tombstone (CAROLINA-423 L1). It rewrites only the row being
// written; it does not touch existing rows.

import pool from '../db.js'

const T = 'ochr_login_deletion_tombstones'

export async function up() {
  console.log('Migration 131: login-deletion-tombstone — applying...')

  await pool.query(`ALTER TABLE ochr_account_deletion_requests DROP CONSTRAINT IF EXISTS ochr_adr_fulfilment_check`)
  await pool.query(`
    ALTER TABLE ochr_account_deletion_requests
      ADD CONSTRAINT ochr_adr_fulfilment_check
      CHECK (fulfilment_status IN ('not_started', 'completed'))
  `)

  await pool.query(`ALTER TABLE ochr_audit_log ADD COLUMN IF NOT EXISTS actor_tombstone_id UUID`)
  await pool.query(`ALTER TABLE ochr_ai_audit ADD COLUMN IF NOT EXISTS actor_tombstone_id UUID`)
  await pool.query(`ALTER TABLE ochr_ai_usage ADD COLUMN IF NOT EXISTS actor_tombstone_id UUID`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${T} (
      organization_id INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      user_id         INTEGER NOT NULL,
      tombstone_id    UUID    NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (organization_id, user_id),
      CONSTRAINT ochr_login_deletion_tombstones_user_fk
        FOREIGN KEY (user_id, organization_id)
        REFERENCES ochr_users (id, organization_id) ON DELETE CASCADE,
      CONSTRAINT ochr_login_deletion_tombstones_tombstone_uniq UNIQUE (tombstone_id)
    )
  `)
  await pool.query(`ALTER TABLE ${T} ENABLE ROW LEVEL SECURITY`)
  const { rows: roles } = await pool.query(
    `SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')`)
  for (const { rolname } of roles) {
    await pool.query(`REVOKE ALL ON ${T} FROM ${rolname}`)
  }
  await pool.query(`DROP TRIGGER IF EXISTS ochr_organization_hold_guard ON ${T}`)
  await pool.query(`CREATE TRIGGER ochr_organization_hold_guard
    BEFORE INSERT OR UPDATE OR DELETE ON ${T}
    FOR EACH ROW EXECUTE FUNCTION ochr_held_organization_write_guard()`)

  // CAROLINA-423 L1: an audit or telemetry write that commits after the
  // deletion (a request authenticated just before it) must not land on
  // the deleted id. A tombstone row for (organization, user) exists only
  // once a deletion committed. INSERT first waits on the login row (the
  // deletion holds it FOR UPDATE), then reads the committed tombstone,
  // the same wait as migration 112's closed-login trigger.
  await pool.query(`
    CREATE OR REPLACE FUNCTION ochr_tombstone_deleted_login_actor()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    DECLARE
      actor integer;
      tomb uuid;
    BEGIN
      IF TG_TABLE_NAME = 'ochr_ai_audit' THEN
        actor := NEW.actor_id;
      ELSE
        actor := NEW.user_id;
      END IF;
      IF actor IS NULL OR NEW.organization_id IS NULL THEN
        RETURN NEW;
      END IF;
      IF TG_OP = 'INSERT' THEN
        PERFORM 1 FROM ochr_users WHERE id = actor FOR SHARE;
      END IF;
      SELECT tombstone_id INTO tomb
        FROM ${T}
       WHERE organization_id = NEW.organization_id AND user_id = actor;
      IF tomb IS NULL THEN
        RETURN NEW;
      END IF;
      NEW.actor_tombstone_id := tomb;
      IF TG_TABLE_NAME = 'ochr_ai_audit' THEN
        NEW.actor_id := NULL;
      ELSE
        NEW.user_id := NULL;
      END IF;
      IF TG_TABLE_NAME = 'ochr_audit_log' THEN
        NEW.user_email := NULL;
        NEW.user_name := NULL;
      END IF;
      RETURN NEW;
    END;
    $fn$
  `)
  for (const table of ['ochr_audit_log', 'ochr_ai_audit', 'ochr_ai_usage']) {
    await pool.query(`DROP TRIGGER IF EXISTS ochr_tombstone_deleted_login_actor ON ${table}`)
    await pool.query(`
      CREATE TRIGGER ochr_tombstone_deleted_login_actor
        BEFORE INSERT OR UPDATE ON ${table}
        FOR EACH ROW
        EXECUTE FUNCTION ochr_tombstone_deleted_login_actor()
    `)
  }

  const { rows: check } = await pool.query(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'ochr_adr_fulfilment_check'`)
  if (!check.length || !/'completed'/.test(check[0].def) || !/'not_started'/.test(check[0].def)) {
    throw new Error('131: fulfilment check does not allow completed')
  }
  const { rows: cols } = await pool.query(`
    SELECT table_name FROM information_schema.columns
     WHERE column_name = 'actor_tombstone_id'
       AND table_name IN ('ochr_audit_log', 'ochr_ai_audit', 'ochr_ai_usage')
  `)
  if (cols.length !== 3) throw new Error('131: actor_tombstone_id did not land on audit and telemetry')
  const { rows: fk } = await pool.query(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'ochr_login_deletion_tombstones_user_fk'`)
  if (!fk.length || !/ochr_users/.test(fk[0].def) || !/organization_id/.test(fk[0].def)) {
    throw new Error('131: tombstone user FK is not a tenant composite onto ochr_users')
  }
  const { rows: rls } = await pool.query(
    `SELECT relrowsecurity FROM pg_class WHERE relname = '${T}'`)
  if (!rls[0]?.relrowsecurity) throw new Error('131: tombstone table has no row level security')
  const { rows: trig } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM pg_trigger WHERE tgname = 'ochr_tombstone_deleted_login_actor' AND NOT tgisinternal`)
  if (trig[0].n !== 3) throw new Error('131: late-write tombstone trigger is not on audit and telemetry')

  console.log('Migration 131: login-deletion-tombstone — done.')
}
