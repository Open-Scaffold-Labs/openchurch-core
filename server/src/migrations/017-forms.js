// Forms module — schema (Sprint Forms / F.1).
//
// One row per form an admin builds. The field definitions live in
// JSONB so a schema migration isn't needed every time we add a new
// field type; the route handler does the structural validation.
//
// status flow:
//   draft  → admin is editing, never visible publicly
//   open   → accepting submissions on the public surface
//   closed → admin froze submissions but the form row is preserved
//            (history + the response inbox stay available)
//
// is_public + status='open' together gate public access. is_public
// alone is not enough — that lets an admin pre-flag a form as
// "intended to be public" while still iterating in draft.
//
// Partial index on (org, slug) WHERE is_public AND status='open' is
// for the parishioner hot path — that's the only lookup that runs
// on every public render. The full UNIQUE (org, slug) index handles
// admin uniqueness across all states.

import pool from '../db.js'

export async function up() {
  console.log('Migration 017: forms — applying...')

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_forms (
      id              SERIAL PRIMARY KEY,
      organization_id INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      slug            TEXT NOT NULL,
      title           TEXT NOT NULL,
      description     TEXT,
      fields          JSONB NOT NULL DEFAULT '[]'::jsonb,
      is_public       BOOLEAN NOT NULL DEFAULT FALSE,
      status          TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'open', 'closed')),
      created_by      INTEGER REFERENCES ochr_users(id) ON DELETE SET NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (organization_id, slug)
    )
  `)

  // Parishioner hot path: SELECT … WHERE org=$1 AND slug=$2 AND
  // is_public AND status='open'. Partial keeps the index footprint
  // proportional to publishable forms, not the whole table.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ochr_forms_public_lookup
      ON ochr_forms (organization_id, slug)
      WHERE is_public AND status = 'open'
  `)

  // Admin list view: tenant-scoped, newest-first.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ochr_forms_org
      ON ochr_forms (organization_id, created_at DESC)
  `)

  console.log('Migration 017: forms — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
