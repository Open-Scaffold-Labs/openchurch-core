// ochr_sacramental_records.meta_attributes (SAC.5) — structured sacrament
// sub-fields, replacing the habit of packing godparents/sponsors/spouse
// into the free-text notes column.
//
// JSONB rather than three columns because the shape is per-sacrament
// (baptism → godparents, confirmation → sponsors, marriage → spouse) and
// canonical practice varies; the route layer enforces a closed key
// allowlist so this never becomes a junk drawer. GIN-indexed for the
// register's future "find records naming sponsor X" search.
//
//   godparents       — array of names (strings)
//   sponsors         — array of names (strings)
//   spouse_client_id — member link, validated against the caller's org
//                      in the route (app-level scoping, like client_id).

import pool from '../db.js'

export async function up() {
  console.log('Migration 048: sacrament-meta — applying...')

  await pool.query(`
    ALTER TABLE ochr_sacramental_records
      ADD COLUMN IF NOT EXISTS meta_attributes JSONB NOT NULL DEFAULT '{}'
  `)

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_sacramental_meta_gin
      ON ochr_sacramental_records USING GIN (meta_attributes)
  `)

  console.log('Migration 048: sacrament-meta — applied.')
}
