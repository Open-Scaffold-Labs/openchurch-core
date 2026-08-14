// ochr_rooms + ochr_checkins.room_id
//
// Check-in, CHK.6 — rooms/classes. A church assigns check-ins to a room
// (Nursery, Toddlers, K-2, ...) so the kiosk + reports can break
// attendance down by space and watch capacity. Rooms are a flat
// per-org list; a check-in optionally points at one.
//
//   ochr_rooms.capacity  — soft cap (nullable); the UI warns past it,
//                          the API doesn't block.
//   ochr_checkins.room_id — nullable, SET NULL so deleting a room leaves
//                           the historical check-in intact.

import pool from '../db.js'

export async function up() {
  console.log('Migration 036: rooms — applying...')

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_rooms (
      id               BIGSERIAL PRIMARY KEY,
      organization_id  INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      name             TEXT NOT NULL,
      capacity         INTEGER,
      active           BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order       INTEGER NOT NULL DEFAULT 0,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rooms_org_active ON ochr_rooms(organization_id, active)`)

  await pool.query(`
    ALTER TABLE ochr_checkins
      ADD COLUMN IF NOT EXISTS room_id BIGINT REFERENCES ochr_rooms(id) ON DELETE SET NULL
  `)

  console.log('Migration 036: rooms — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
