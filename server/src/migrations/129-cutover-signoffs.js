// 129 — parish accountant sign-off on a cutover scoreboard.
//
// ADDITIVE ONLY: one new table. APPEND-ONLY: a row is the fact that a staff
// member recorded that the named accountant signed off on the scoreboard
// (snapshot stored) as of a date. UPDATE is refused; a direct DELETE is
// refused. Only the organization's own ON DELETE CASCADE removes rows.
//
// Cascade exception (narrow, documented): a DELETE is allowed only when it
// is nested (pg_trigger_depth() > 1, i.e. fired by an RI trigger) AND the
// parent ochr_organizations row is already gone in this transaction. That
// is exactly the org-deletion cascade; any other nested DELETE (some
// future trigger, or a user-FK cascade — the recorder FK is RESTRICT) is
// refused. Regression: financeCutoverScoreboard.test.js "cascade".
//
// R414-1 (R2): installs ochr_finance_scoreboard_lock() on every table the
// scoreboard reads — finance data AND every input to the effective chart
// (template + diocesan COA rows, diocese affiliations). Locking protocol,
// key order and the deadlock-freedom argument: server/src/finance/locks.js.
// Writers never enter the PG lock queue (try-lock + bounded poll → 55P03),
// so a sign-off can never make an unrelated money write deadlock.
// Nothing here moves money or writes the ledger.

import pool from '../db.js'
import { FINANCE_LOCK_NS, CHART_LOCK_NS, TEMPLATE_CHART_OWNER } from '../finance/locks.js'

const T = 'ochr_cutover_signoffs'
const LOCKED_TABLES = ['ochr_ledger_entries', 'ochr_donations', 'ochr_donation_refunds',
  'ochr_coa_mappings', 'ochr_coa_accounts', 'ochr_payroll_staff', 'ochr_payroll_shifts',
  'ochr_diocese_affiliations']

export async function up() {
  console.log('Migration 129: cutover-signoffs — applying...')
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${T} (
      id               BIGSERIAL PRIMARY KEY,
      organization_id  INTEGER     NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      as_of            DATE        NOT NULL,
      accountant_name  TEXT        NOT NULL CHECK (length(btrim(accountant_name)) BETWEEN 1 AND 200),
      signed_on        DATE        NOT NULL,
      scoreboard       JSONB       NOT NULL,
      recorded_by      INTEGER     NOT NULL,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      -- R414-1: the instant the locks were held and the recompute read
      -- the books (clock_timestamp + pg_current_snapshot()).
      snapshot_at      TIMESTAMPTZ,
      snapshot_marker  TEXT,
      -- Atlas P1-2: the recorder is a user of THIS org; RESTRICT, not
      -- CASCADE, so deleting a user cannot erase an attestation.
      CONSTRAINT ochr_cutover_signoffs_recorder_fk FOREIGN KEY (recorded_by, organization_id)
        REFERENCES ochr_users (id, organization_id) ON DELETE RESTRICT
    )
  `)
  await pool.query(`ALTER TABLE ${T} ADD COLUMN IF NOT EXISTS snapshot_at TIMESTAMPTZ`)
  await pool.query(`ALTER TABLE ${T} ADD COLUMN IF NOT EXISTS snapshot_marker TEXT`)
  await pool.query(`CREATE INDEX IF NOT EXISTS ochr_cutover_signoffs_org ON ${T} (organization_id, created_at DESC)`)
  await pool.query(`ALTER TABLE ${T} ENABLE ROW LEVEL SECURITY`)
  const { rows: roles } = await pool.query(
    `SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')`)
  for (const { rolname } of roles) await pool.query(`REVOKE ALL ON ${T} FROM ${rolname}`)

  await pool.query(`
    CREATE OR REPLACE FUNCTION ochr_cutover_signoffs_append_only() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1
         AND NOT EXISTS (SELECT 1 FROM ochr_organizations o WHERE o.id = OLD.organization_id) THEN
        RETURN OLD;
      END IF;
      RAISE EXCEPTION 'cutover sign-offs are append-only' USING ERRCODE = 'check_violation';
    END $$ LANGUAGE plpgsql`)
  await pool.query(`DROP TRIGGER IF EXISTS ochr_cutover_signoffs_append_only ON ${T}`)
  await pool.query(`CREATE TRIGGER ochr_cutover_signoffs_append_only
    BEFORE UPDATE OR DELETE ON ${T} FOR EACH ROW EXECUTE FUNCTION ochr_cutover_signoffs_append_only()`)
  await pool.query(`DROP TRIGGER IF EXISTS ochr_organization_hold_guard ON ${T}`)
  await pool.query(`CREATE TRIGGER ochr_organization_hold_guard
    BEFORE INSERT ON ${T}
    FOR EACH ROW EXECUTE FUNCTION ochr_held_organization_write_guard()`)

  // Bounded, queue-free acquisition: try-lock, poll, give up with 55P03
  // after the session lock_timeout (10 s when unset). Never enters PG's
  // lock queue, so it can never sit in a deadlock cycle.
  await pool.query(`
    CREATE OR REPLACE FUNCTION ochr_finance_lock_take(ns INTEGER, k INTEGER, excl BOOLEAN) RETURNS void AS $$
    DECLARE
      budget INTERVAL := COALESCE(NULLIF(current_setting('lock_timeout'), '0')::interval, interval '10 seconds');
      deadline TIMESTAMPTZ := clock_timestamp() + budget;
      got BOOLEAN;
    BEGIN
      LOOP
        got := CASE WHEN excl THEN pg_try_advisory_xact_lock(ns, k) ELSE pg_try_advisory_xact_lock_shared(ns, k) END;
        EXIT WHEN got;
        IF clock_timestamp() >= deadline THEN
          RAISE EXCEPTION 'finance write waited too long for a cutover sign-off (lock %/%)', ns, k
            USING ERRCODE = 'lock_not_available';
        END IF;
        PERFORM pg_sleep(0.01);
      END LOOP;
    END $$ LANGUAGE plpgsql`)

  // Keys per written row, deduplicated and taken in ascending (ns, key).
  // R414-3: built explicitly per table, never by COALESCE over a mixed array.
  //  · finance data / affiliations: SHARED (${FINANCE_LOCK_NS}, org) for OLD and NEW org;
  //  · ochr_coa_accounts, per OLD/NEW row, exactly ONE key by chart owner:
  //      organization_id IS NULL (global template) → EXCLUSIVE (${CHART_LOCK_NS}, ${TEMPLATE_CHART_OWNER}), always;
  //      owner org_type = 'diocese'                → EXCLUSIVE (${CHART_LOCK_NS}, D) only — not the
  //        diocese's (${FINANCE_LOCK_NS}, D) data key (a diocese's own sign-off also holds
  //        (${CHART_LOCK_NS}, self) SHARED, so it is still excluded — locks.js);
  //      owner is a parish                         → SHARED (${FINANCE_LOCK_NS}, P) only, like any of
  //        its own finance data (no other parish inherits a parish chart).
  await pool.query(`
    CREATE OR REPLACE FUNCTION ochr_finance_scoreboard_lock() RETURNS trigger AS $$
    DECLARE orgs INTEGER[] := '{}'; charts INTEGER[] := '{}'; owners INTEGER[] := '{}';
            o INTEGER; r RECORD; is_tpl BOOLEAN := false;
    BEGIN
      IF TG_TABLE_NAME = 'ochr_payroll_shifts' THEN
        IF TG_OP <> 'INSERT' THEN orgs := orgs || (SELECT s.organization_id FROM ochr_payroll_staff s WHERE s.id = OLD.staff_id); END IF;
        IF TG_OP <> 'DELETE' THEN orgs := orgs || (SELECT s.organization_id FROM ochr_payroll_staff s WHERE s.id = NEW.staff_id); END IF;
      ELSIF TG_TABLE_NAME = 'ochr_diocese_affiliations' THEN
        IF TG_OP <> 'INSERT' THEN orgs := orgs || OLD.parish_org_id; END IF;
        IF TG_OP <> 'DELETE' THEN orgs := orgs || NEW.parish_org_id; END IF;
      ELSIF TG_TABLE_NAME = 'ochr_coa_accounts' THEN
        IF TG_OP <> 'INSERT' THEN
          IF OLD.organization_id IS NULL THEN is_tpl := true; ELSE owners := owners || OLD.organization_id; END IF;
        END IF;
        IF TG_OP <> 'DELETE' THEN
          IF NEW.organization_id IS NULL THEN is_tpl := true; ELSE owners := owners || NEW.organization_id; END IF;
        END IF;
        IF is_tpl THEN charts := charts || ${TEMPLATE_CHART_OWNER}; END IF;
        FOREACH o IN ARRAY owners LOOP
          IF EXISTS (SELECT 1 FROM ochr_organizations g WHERE g.id = o AND g.org_type = 'diocese')
          THEN charts := charts || o; ELSE orgs := orgs || o; END IF;
        END LOOP;
      ELSE
        IF TG_OP <> 'INSERT' THEN orgs := orgs || OLD.organization_id; END IF;
        IF TG_OP <> 'DELETE' THEN orgs := orgs || NEW.organization_id; END IF;
      END IF;
      FOR r IN
        SELECT DISTINCT ns, k, excl FROM (
          SELECT ${FINANCE_LOCK_NS} AS ns, x AS k, false AS excl FROM unnest(orgs) x WHERE x IS NOT NULL
          UNION ALL
          SELECT ${CHART_LOCK_NS}, x, true FROM unnest(charts) x WHERE x IS NOT NULL
        ) q ORDER BY ns, k
      LOOP
        PERFORM ochr_finance_lock_take(r.ns, r.k, r.excl);
      END LOOP;
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`)
  // Atlas P2-6: DDL on hot tables waits at most 5 s for its SHARE ROW
  // EXCLUSIVE lock instead of queueing writers behind a long transaction.
  const ddl = await pool.connect()
  try {
    await ddl.query('BEGIN')
    await ddl.query(`SET LOCAL lock_timeout = '5s'`)
    for (const t of LOCKED_TABLES) {
      await ddl.query(`DROP TRIGGER IF EXISTS ochr_finance_scoreboard_lock ON ${t}`)
      await ddl.query(`CREATE TRIGGER ochr_finance_scoreboard_lock
        BEFORE INSERT OR UPDATE OR DELETE ON ${t}
        FOR EACH ROW EXECUTE FUNCTION ochr_finance_scoreboard_lock()`)
    }
    await ddl.query('COMMIT')
  } catch (err) {
    await ddl.query('ROLLBACK').catch(() => {})
    throw err
  } finally { ddl.release() }

  const rls = await pool.query(`SELECT relrowsecurity FROM pg_class WHERE relname = '${T}'`)
  if (rls.rows[0]?.relrowsecurity !== true) throw new Error('129: RLS is not enabled')
  console.log('Migration 129: cutover-signoffs — done.')
}
