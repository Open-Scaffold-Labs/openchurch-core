// 126 — durable "an offering amount was recorded" marker on a Mass intention.
//
// TARS R382-1 (#382): the SP-133 hard-delete guard used to prove an earlier
// amount from ochr_audit_log, which per-plan retention prunes. A refused row
// could become deletable once its audit aged out. This moves the proof onto
// the intention row itself.
//
// ADDITIVE ONLY. One BOOLEAN NOT NULL DEFAULT false column, one trigger
// function, one trigger, one bounded backfill. Nothing is dropped, no amount
// is rewritten, no audit row is touched.
//
//   offering_recorded — true once any write stores a non-NULL stipend
//     (an explicit 0.00 counts). Monotonic: the BEFORE trigger keeps it true
//     on every later UPDATE, whatever the stipend becomes (an admin
//     correction may null the amount; the marker stays). It means only
//     "an amount was recorded" — NOT paid, NOT waived.
//
// Separate from entered_history (120) on purpose, so scheduling / mark-said
// semantics are unchanged.
//
// Backfill: only from evidence that survives today — a current non-NULL
// stipend, or a SAME-ORGANIZATION audit row for this intention showing a
// non-NULL stipend_before/after. Rows whose amount was cleared before any
// surviving evidence remain UNKNOWN (false here); that history cannot be
// recovered and is not invented. It reaches held parishes too (same narrow,
// transaction-local hold-guard bypass as 120), and suspends the book
// revision trigger (122) for the statement so no client sees a phantom edit.

import pool from '../db.js'

export async function up() {
  console.log('Migration 126: mass-intention-offering-history — applying...')

  await pool.query(`
    ALTER TABLE ochr_mass_intentions
      ADD COLUMN IF NOT EXISTS offering_recorded BOOLEAN NOT NULL DEFAULT false
  `)

  await pool.query(`
    CREATE OR REPLACE FUNCTION ochr_mass_intention_offering_latch() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'UPDATE' AND OLD.offering_recorded THEN
        NEW.offering_recorded := true;
      END IF;
      IF NEW.stipend IS NOT NULL THEN
        NEW.offering_recorded := true;
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql
  `)
  await pool.query('DROP TRIGGER IF EXISTS ochr_mass_intention_offering_latch ON ochr_mass_intentions')
  await pool.query(`CREATE TRIGGER ochr_mass_intention_offering_latch
    BEFORE INSERT OR UPDATE ON ochr_mass_intentions
    FOR EACH ROW EXECUTE FUNCTION ochr_mass_intention_offering_latch()`)

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('ALTER TABLE ochr_mass_intentions DISABLE TRIGGER ochr_organization_hold_guard')
    await client.query('ALTER TABLE ochr_mass_intentions DISABLE TRIGGER ochr_mass_intention_book_revision')
    await client.query(`
      UPDATE ochr_mass_intentions mi SET offering_recorded = true
       WHERE mi.offering_recorded = false
         AND (mi.stipend IS NOT NULL
              OR EXISTS (
                SELECT 1 FROM ochr_audit_log a
                 WHERE a.organization_id = mi.organization_id
                   AND a.entity_type = 'mass_intention'
                   AND a.entity_id = mi.id::text
                   AND (a.metadata->>'stipend_before' IS NOT NULL
                        OR a.metadata->>'stipend_after' IS NOT NULL)))`)
    await client.query('ALTER TABLE ochr_mass_intentions ENABLE TRIGGER ochr_mass_intention_book_revision')
    await client.query('ALTER TABLE ochr_mass_intentions ENABLE TRIGGER ochr_organization_hold_guard')
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }

  const { rows } = await pool.query(
    `SELECT 1 FROM pg_trigger WHERE tgname = 'ochr_mass_intention_offering_latch' AND NOT tgisinternal`)
  if (!rows.length) throw new Error('126: offering latch trigger is missing')

  console.log('Migration 126: mass-intention-offering-history — done.')
}
