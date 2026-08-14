// Full-text search indexes. Replaces the previous ILIKE '%term%'
// pattern in routes/search.js — that scan-the-whole-table approach
// works at small scale but degrades fast past a few thousand rows
// per tenant.
//
// Each searchable table gets a `search_vec` tsvector column,
// computed as a GENERATED ALWAYS AS (...) STORED expression so
// Postgres maintains it automatically on every INSERT/UPDATE — no
// triggers, no app-side maintenance.
//
// Each column is then backed by a GIN index on `search_vec`. GIN is
// the right index for inverted-list lookups; it sizes well, supports
// the @@ operator natively, and gives sub-millisecond match times
// for typical churches.
//
// We use the 'english' text search config — it handles stemming
// (members searching "scheduling" find rows containing "scheduled"),
// stop-word elimination, and case folding. If we ever go bilingual
// for real (Spanish for the Hispanic congregation), we'd add a
// 'spanish' second column or switch to 'simple' to avoid stemming
// across languages.
//
// Idempotent — IF NOT EXISTS lets re-runs no-op on dev boots.

import pool from '../db.js'

export async function up() {
  console.log('Migration 009: search-index — applying...')

  // ── ochr_clients ──────────────────────────────────────────
  await pool.query(`
    ALTER TABLE ochr_clients
      ADD COLUMN IF NOT EXISTS search_vec tsvector
      GENERATED ALWAYS AS (
        to_tsvector('english',
          coalesce(name,    '') || ' ' ||
          coalesce(email,   '') || ' ' ||
          coalesce(company, '') || ' ' ||
          coalesce(tags,    '') || ' ' ||
          coalesce(role,    '')
        )
      ) STORED
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ochr_clients_search_vec
      ON ochr_clients USING GIN (search_vec)
  `)

  // ── ochr_events ───────────────────────────────────────────
  await pool.query(`
    ALTER TABLE ochr_events
      ADD COLUMN IF NOT EXISTS search_vec tsvector
      GENERATED ALWAYS AS (
        to_tsvector('english',
          coalesce(title,            '') || ' ' ||
          coalesce(service_division, '') || ' ' ||
          coalesce(location,         '')
        )
      ) STORED
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ochr_events_search_vec
      ON ochr_events USING GIN (search_vec)
  `)

  // ── ochr_tasks ────────────────────────────────────────────
  await pool.query(`
    ALTER TABLE ochr_tasks
      ADD COLUMN IF NOT EXISTS search_vec tsvector
      GENERATED ALWAYS AS (
        to_tsvector('english',
          coalesce(title,       '') || ' ' ||
          coalesce(description, '') || ' ' ||
          coalesce(category,    '')
        )
      ) STORED
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ochr_tasks_search_vec
      ON ochr_tasks USING GIN (search_vec)
  `)

  // ── ochr_payroll_staff ────────────────────────────────────
  await pool.query(`
    ALTER TABLE ochr_payroll_staff
      ADD COLUMN IF NOT EXISTS search_vec tsvector
      GENERATED ALWAYS AS (
        to_tsvector('english',
          coalesce(name, '') || ' ' ||
          coalesce(role, '')
        )
      ) STORED
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ochr_payroll_staff_search_vec
      ON ochr_payroll_staff USING GIN (search_vec)
  `)

  // ── ochr_donations ────────────────────────────────────────
  await pool.query(`
    ALTER TABLE ochr_donations
      ADD COLUMN IF NOT EXISTS search_vec tsvector
      GENERATED ALWAYS AS (
        to_tsvector('english',
          coalesce(donor_name, '') || ' ' ||
          coalesce(category,   '') || ' ' ||
          coalesce(notes,      '')
        )
      ) STORED
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ochr_donations_search_vec
      ON ochr_donations USING GIN (search_vec)
  `)

  console.log('Migration 009: search-index — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
