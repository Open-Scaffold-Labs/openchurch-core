// 085 — undo a whole import (MIG.1.2).
//
// The Continuity Vault protects one deleted record at a time, which is
// the right shape for the mistake a person makes with a mouse. It is the
// wrong shape for the mistake a person makes with a mapping: map the
// phone column to `role`, approve, and four hundred members are now
// wrong in a way that is tedious rather than dramatic. Nobody is going to
// restore four hundred records one at a time, so in practice they live
// with it, or they ask for the parish to be rolled back.
//
// The data to undo it was already there. Every import row stores the
// `created_record_id` it produced, and the receipt already knows the
// counts. This migration only adds the bookkeeping for having done it.
//
// Two deliberate shapes:
//
//   The batch's STATUS does not change. It was committed; that is a fact
//   about the past and stays true. `undone_at` is a separate fact about
//   what happened afterwards — the same pattern as `rows_purged_at`.
//
//   `undo_summary` records what could NOT be undone as well as what
//   could: records somebody has edited since are left exactly alone, and
//   a receipt that quietly omitted them would be worse than no undo.
//
// The window is not new. Undo needs `created_record_id`, which lives on
// the staged rows, which are removed after 30 days — so undo is available
// for exactly as long as the rows are, and the refusal after that says so
// rather than reporting an empty result.

import pool from '../db.js'

export async function up() {
  console.log('Migration 085: import undo — applying...')

  await pool.query(`
    ALTER TABLE ochr_import_batches
      ADD COLUMN IF NOT EXISTS undone_at      TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS undone_by      INTEGER,
      ADD COLUMN IF NOT EXISTS undone_by_name TEXT,
      ADD COLUMN IF NOT EXISTS undo_summary   JSONB
  `)

  // Composite tenant key on the actor, per migration 071. Column-scoped
  // SET NULL so a departing user does not take organization_id with them;
  // the name snapshot beside it keeps the record readable.
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                      WHERE conname = 'ochr_import_batches_undone_by_org_fkey') THEN
        ALTER TABLE ochr_import_batches
          ADD CONSTRAINT ochr_import_batches_undone_by_org_fkey
          FOREIGN KEY (undone_by, organization_id)
          REFERENCES ochr_users(id, organization_id)
          ON DELETE SET NULL (undone_by);
      END IF;
    END $$;
  `)

  console.log('Migration 085: import undo — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
