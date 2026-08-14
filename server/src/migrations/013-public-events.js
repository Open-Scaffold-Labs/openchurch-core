// Public events (Sprint P). Adds an is_public flag to ochr_events so
// admins can mark a subset of events parishioner-visible without
// exposing the whole roster.
//
// Default false — every existing event stays private until an admin
// explicitly opts in. The /api/public/:slug/events feed filters
// strictly on is_public = true AND organization (by slug), so a
// row that's not explicitly toggled never leaks.
//
// Chose 'is_public' over the bare word 'public' because 'public' is
// a Postgres schema name and some clients (and our own ergonomic
// brain) tend to autocomplete it as a keyword. Explicit prefix avoids
// the trap.

import pool from '../db.js'

export async function up() {
  console.log('Migration 013: public-events — applying...')

  await pool.query(`
    ALTER TABLE ochr_events
      ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT FALSE
  `)

  // Partial index — public events are a small fraction of all events
  // and the public feed hits this column on every request. The
  // partial WHERE keeps the index tiny.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ochr_events_public
      ON ochr_events (organization_id, date)
      WHERE is_public = TRUE
  `)

  console.log('Migration 013: public-events — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
