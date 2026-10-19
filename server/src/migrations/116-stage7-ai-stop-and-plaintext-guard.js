import pool from '../db.js'

// Stage 7 (TARS review of #280 at ba12d348). Additive only: no column is
// dropped, no historical row is changed or deleted, no retention is set.
//
// 1. ochr_platform_ai_switch: the Dale/CoS-controlled platform AI stop.
//    One row (id = 1). No row = never stopped. Read by ai/gate.js before
//    every provider dispatch, sync and async, managed and BYOK; a failed read
//    is treated as stopped. No automatic resume: only an explicit PUT by an
//    authorized operator clears it. Every change is appended to
//    ochr_platform_ai_switch_events.
// 2. ochr_assistant_messages.question loses NOT NULL so NEW assistant
//    telemetry can be metadata only. Existing rows keep their text
//    (inventoried, restricted, no purge decided).
// 3. ochr_checkins.security_code (legacy plaintext, nulled by 043): a guard
//    refuses any NEW non-null value — on INSERT, or an UPDATE that changes it
//    to non-null. Existing values are untouched, and an UPDATE that leaves a
//    legacy value as it was is not refused, so checkout of any legacy row
//    still works. Hash-only is the runtime target; the column stays.
export async function up() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_platform_ai_switch (
      id          INTEGER PRIMARY KEY CHECK (id = 1),
      stopped     BOOLEAN NOT NULL DEFAULT FALSE,
      reason      TEXT,
      changed_by  INTEGER REFERENCES ochr_users(id) ON DELETE SET NULL,
      changed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_platform_ai_switch_events (
      id          BIGSERIAL PRIMARY KEY,
      stopped     BOOLEAN NOT NULL,
      reason      TEXT,
      changed_by  INTEGER REFERENCES ochr_users(id) ON DELETE SET NULL,
      changed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  // R3-4: platform tables with no organization_id, enabled like 096/112
  // (post-080 tables). Idempotent; the app role owns the tables.
  await pool.query('ALTER TABLE ochr_platform_ai_switch ENABLE ROW LEVEL SECURITY')
  await pool.query('ALTER TABLE ochr_platform_ai_switch_events ENABLE ROW LEVEL SECURITY')
  await pool.query('ALTER TABLE ochr_assistant_messages ALTER COLUMN question DROP NOT NULL')
  await pool.query(`
    CREATE OR REPLACE FUNCTION ochr_checkins_no_plaintext_code() RETURNS trigger AS $$
    BEGIN
      IF NEW.security_code IS NOT NULL
         AND (TG_OP = 'INSERT' OR NEW.security_code IS DISTINCT FROM OLD.security_code) THEN
        RAISE EXCEPTION 'plaintext pickup code is not stored (security_code_hash only)'
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END
    $$ LANGUAGE plpgsql
  `)
  await pool.query('DROP TRIGGER IF EXISTS trg_checkins_no_plaintext_code ON ochr_checkins')
  await pool.query(`
    CREATE TRIGGER trg_checkins_no_plaintext_code
      BEFORE INSERT OR UPDATE OF security_code ON ochr_checkins
      FOR EACH ROW EXECUTE FUNCTION ochr_checkins_no_plaintext_code()
  `)
}
