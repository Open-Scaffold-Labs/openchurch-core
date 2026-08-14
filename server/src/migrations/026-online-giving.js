// ochr_funds + online-gift columns on ochr_donations
//
// Online giving, GIV.1 — parishioners give to a named fund from the
// public church site. The charge runs through the vendor-neutral
// payments stub (server/src/payments) and is recorded as an ordinary
// ochr_donations row, so online gifts flow into the existing stats and
// year-end giving statements with no extra plumbing.
//
// ochr_funds — the designations a church offers (General, Building,
// Missions, ...). active gates whether a fund shows on the give page;
// sort_order lets admins order the picker. A church with zero active
// funds simply isn't collecting online gifts yet.
//
// ochr_donations gains:
//   source         — 'manual' (admin entry / cash count, the default so
//                    every existing row keeps its meaning) vs 'online'.
//   fund_id        — the designated fund (nullable, SET NULL so deleting
//                    a fund doesn't erase the gift). category is still
//                    populated with the fund name so statements/stats
//                    that read category keep working unchanged.
//   payment_ref    — the charge id from the provider (stub today).
//   payment_status — 'succeeded' etc., straight from the charge.

import pool from '../db.js'

export async function up() {
  console.log('Migration 026: online-giving — applying...')

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_funds (
      id               BIGSERIAL PRIMARY KEY,
      organization_id  INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      name             TEXT NOT NULL,
      description      TEXT,
      active           BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order       INTEGER NOT NULL DEFAULT 0,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_funds_org_active ON ochr_funds(organization_id, active)`)

  await pool.query(`
    ALTER TABLE ochr_donations
      ADD COLUMN IF NOT EXISTS source         TEXT DEFAULT 'manual',
      ADD COLUMN IF NOT EXISTS fund_id        BIGINT REFERENCES ochr_funds(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS payment_ref    TEXT,
      ADD COLUMN IF NOT EXISTS payment_status TEXT
  `)

  console.log('Migration 026: online-giving — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
