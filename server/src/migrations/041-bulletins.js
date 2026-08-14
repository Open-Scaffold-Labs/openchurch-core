// ochr_bulletins — the weekly parish bulletin (BUL.1).
//
// One bulletin per (org, date). The bulletin pulls its liturgical day
// (season/feast/color) and that week's services live from the existing
// liturgical + calendar data at render time, so this table only stores
// the human-written parts: announcements, the day's readings (manual for
// v1 — auto-lectionary is a later add), prayer/Mass intentions, and a
// note from the pastor. `published` gates an optional public read-online
// link (BUL.3); drafts stay admin-only.

import pool from '../db.js'

export async function up() {
  console.log('Migration 041: bulletins — applying...')

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_bulletins (
      id               BIGSERIAL PRIMARY KEY,
      organization_id  BIGINT NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      date             DATE NOT NULL,
      title            TEXT,
      announcements    TEXT,
      readings         TEXT,
      intentions       TEXT,
      pastor_note      TEXT,
      published        BOOLEAN NOT NULL DEFAULT FALSE,
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      updated_at       TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (organization_id, date)
    )
  `)

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_bulletins_org_date
      ON ochr_bulletins (organization_id, date DESC)
  `)

  // Every ochr_* table in prod runs with RLS enabled (no policies) as a
  // blanket "deny direct PostgREST/anon access" backstop — tenancy itself
  // is enforced in the route's WHERE organization_id = $1. Enable it here
  // so the new table matches that invariant on deploy instead of needing
  // an out-of-band ALTER. Idempotent: ENABLE is a no-op if already on.
  await pool.query(`ALTER TABLE ochr_bulletins ENABLE ROW LEVEL SECURITY`)

  console.log('Migration 041: bulletins — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
