// D-1: bulk "Mark said" for Mass intentions.
//
// The book already records one fulfilment at a time. A secretary marking
// several said in one sitting needs the same ceremony for the set she
// actually chose: one batch, one audit row per intention, and an undo
// that is itself a recorded fact.
//
// Additive only. No backfill, no stipend column, no rewrite of rows that
// are already fulfilled. Two tables:
//   ochr_mass_intention_mark_batches — the confirmation (idempotency key,
//     who, the id-and-code outcome). Intention wording is not stored here.
//   ochr_mass_intention_mark_items — one row per intention in the batch,
//     with the typed before/after snapshot and the prior columns an undo
//     restores. The intention text is not a column; a digest detects a
//     later edit without keeping a second copy of the wording.
//
// The history latch (migration 120) still refuses an ordinary write that
// would clear entered_history. Undo sets a transaction-local flag the
// trigger honours, and only the undo route sets that flag.

import pool from '../db.js'

export async function up() {
  console.log('Migration 121: mass-intention-mark-said — applying...')

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_mass_intention_mark_batches (
      id              UUID PRIMARY KEY,
      organization_id INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      actor_user_id   INTEGER NOT NULL,
      payload_hash    TEXT NOT NULL,
      outcome         JSONB NOT NULL,
      undo_outcome    JSONB,
      undone_at       TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT ochr_mi_mark_batches_id_org_key UNIQUE (id, organization_id),
      CONSTRAINT ochr_mi_mark_batches_actor_fk
        FOREIGN KEY (actor_user_id, organization_id)
        REFERENCES ochr_users(id, organization_id)
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_mass_intention_mark_items (
      id                          SERIAL PRIMARY KEY,
      organization_id             INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      batch_id                    UUID NOT NULL,
      mass_intention_id           BIGINT NOT NULL,
      applied                     BOOLEAN NOT NULL,
      exclusion_code              TEXT,
      before_snapshot             JSONB NOT NULL,
      after_snapshot              JSONB NOT NULL,
      prior_status                TEXT NOT NULL,
      prior_entered_history       BOOLEAN NOT NULL,
      prior_calendar_event_id     INTEGER,
      prior_fulfilled_mass_date   DATE,
      prior_fulfilled_mass_title  TEXT,
      prior_fulfilled_mass_time   TIME,
      written_fulfilled_mass_date DATE,
      written_fulfilled_mass_title TEXT,
      written_fulfilled_mass_time TIME,
      after_digest                TEXT,
      undone                      BOOLEAN NOT NULL DEFAULT false,
      CONSTRAINT ochr_mi_mark_items_batch_fk
        FOREIGN KEY (batch_id, organization_id)
        REFERENCES ochr_mass_intention_mark_batches (id, organization_id),
      CONSTRAINT ochr_mi_mark_items_intention_fk
        FOREIGN KEY (mass_intention_id, organization_id)
        REFERENCES ochr_mass_intentions (id, organization_id),
      CONSTRAINT ochr_mi_mark_items_unique UNIQUE (organization_id, batch_id, mass_intention_id)
    )
  `)

  await pool.query(`CREATE INDEX IF NOT EXISTS ochr_mi_mark_items_batch_idx
    ON ochr_mass_intention_mark_items (organization_id, batch_id)`)

  // Same latch as migration 120, plus one transaction-local escape.
  // current_setting(..., true) returns NULL when the flag was never set,
  // which is every ordinary write. Only undo sets the flag, and only for
  // its own transaction (set_config third argument).
  await pool.query(`
    CREATE OR REPLACE FUNCTION ochr_mass_intention_history_latch() RETURNS trigger AS $$
    BEGIN
      IF current_setting('ochr.intention_undo', true) IS DISTINCT FROM '1' THEN
        IF TG_OP = 'UPDATE' AND OLD.entered_history THEN
          NEW.entered_history := true;
        END IF;
        IF NEW.status = 'fulfilled'
           OR NEW.fulfilled_mass_date IS NOT NULL
           OR NEW.fulfilled_mass_title IS NOT NULL
           OR NEW.fulfilled_mass_time IS NOT NULL
           OR NEW.voided_at IS NOT NULL THEN
          NEW.entered_history := true;
        END IF;
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql
  `)

  await pool.query('ALTER TABLE ochr_mass_intention_mark_batches ENABLE ROW LEVEL SECURITY')
  await pool.query('ALTER TABLE ochr_mass_intention_mark_items ENABLE ROW LEVEL SECURITY')
  const { rows: roles } = await pool.query(
    `SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')`)
  for (const { rolname } of roles) {
    await pool.query(`REVOKE ALL ON ochr_mass_intention_mark_batches FROM ${rolname}`)
    await pool.query(`REVOKE ALL ON ochr_mass_intention_mark_items FROM ${rolname}`)
  }
  for (const table of ['ochr_mass_intention_mark_batches', 'ochr_mass_intention_mark_items']) {
    await pool.query(`DROP TRIGGER IF EXISTS ochr_organization_hold_guard ON ${table}`)
    await pool.query(`CREATE TRIGGER ochr_organization_hold_guard
      BEFORE INSERT OR UPDATE OR DELETE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION ochr_held_organization_write_guard()`)
  }

  const { rows: tables } = await pool.query(
    `SELECT c.relname FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN ('ochr_mass_intention_mark_batches', 'ochr_mass_intention_mark_items')
        AND c.relrowsecurity`)
  if (tables.length !== 2) throw new Error('121: RLS missing on mark-said tables')

  const { rows: fks } = await pool.query(
    `SELECT conname FROM pg_constraint
      WHERE conname IN (
        'ochr_mi_mark_batches_actor_fk',
        'ochr_mi_mark_items_batch_fk',
        'ochr_mi_mark_items_intention_fk'
      )`)
  if (fks.length !== 3) throw new Error('121: composite tenant foreign keys missing')

  const { rows: fn } = await pool.query(
    `SELECT pg_get_functiondef('ochr_mass_intention_history_latch()'::regprocedure) AS def`)
  if (!fn[0]?.def?.includes('ochr.intention_undo')) {
    throw new Error('121: history latch is missing the undo flag')
  }
  console.log('Migration 121: mass-intention-mark-said — done.')
}
