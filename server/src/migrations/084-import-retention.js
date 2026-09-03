// 084 — Migration Studio retention bookkeeping (MIG.1.1).
//
// The Studio keeps every parsed row of a parish's source file so a person
// can see what will happen before it happens. That is the right design
// for the hour of the import and the wrong one for the year after it: a
// committed batch of two thousand members is a second copy of the parish
// roster, sitting in staging, with nothing left to review.
//
// So raw staged rows expire. Everything that makes the import
// ACCOUNTABLE does not:
//
//   kept forever   the receipt, the batch, the source name and kind, the
//                  mapping summary, the counts, the follow-up reasons,
//                  who prepared it, who approved it, the audit history
//   kept 30 days   the raw and normalized rows themselves
//
// Two columns are enough to make that honest. `rows_purged_at` is the
// difference between "you can still look at row 412" and "you cannot,
// and here is when that changed" — without it the rows simply stop
// existing and the interface has to guess why. `rows_purged_count`
// preserves the fact that there WERE rows, which `row_count` alone
// cannot distinguish from an empty batch.
//
// Deliberately NOT a status. A batch does not become 'archived' or
// 'expired' when its rows go: its status still describes what happened
// to the import — committed, abandoned — and overloading that field
// would make a committed import look like something else a year later.
//
// The original source FILE was never stored, so nothing here expires it.
// When Vault-backed file retention exists, it attaches to the batch id.

import pool from '../db.js'

export async function up() {
  console.log('Migration 084: import retention — applying...')

  await pool.query(`
    ALTER TABLE ochr_import_batches
      ADD COLUMN IF NOT EXISTS rows_purged_at    TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS rows_purged_count INTEGER
  `)

  // The prune walks batches whose rows have not yet gone, oldest activity
  // first. Partial, because a purged batch is never revisited.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_import_batches_unpurged
      ON ochr_import_batches(updated_at)
     WHERE rows_purged_at IS NULL
  `)

  // Row issues become localizable: the key and its variables are stored
  // beside the rendered English sentence, so the same row can be read in
  // Spanish without the server having to re-derive it — and without
  // translating anything at request time.
  await pool.query(`
    ALTER TABLE ochr_import_rows
      ADD COLUMN IF NOT EXISTS issue_key  TEXT,
      ADD COLUMN IF NOT EXISTS issue_vars JSONB
  `)

  console.log('Migration 084: import retention — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
