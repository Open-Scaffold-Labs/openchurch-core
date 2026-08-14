// ochr_parish_feasts — tenant-scoped liturgical feast overrides (LIT.5).
//
// The universal calendar (ochr_liturgical_calendar) is global by design:
// Easter, Advent and the fixed solemnities are the same for every
// church. But a parish also keeps its OWN days — its patronal feast, the
// anniversary of its dedication, a locally-kept saint. Those are
// church-specific, so they can't live in the global table without
// leaking across tenants.
//
// This table is the per-org layer that sits ABOVE the global calendar.
// Resolution precedence (routes/liturgical.js): parish feast → global
// override → computed. A parish feast names the day (and may recolor it)
// but does NOT change the computed season — your patron's feast is still
// kept in Ordinary Time, it just gets a name and, often, white/gold.

import pool from '../db.js'

export async function up() {
  console.log('Migration 039: parish-feasts — applying...')

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_parish_feasts (
      id               BIGSERIAL PRIMARY KEY,
      organization_id  BIGINT NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      date             DATE NOT NULL,
      feast_name       TEXT NOT NULL,
      liturgical_color TEXT,
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (organization_id, date)
    )
  `)

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_parish_feasts_org_date
      ON ochr_parish_feasts (organization_id, date)
  `)

  console.log('Migration 039: parish-feasts — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
