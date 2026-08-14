// Locks ochr_users.role down to a known set of values via a CHECK
// constraint. Existing rows are all 'admin' (the signup default), so
// the constraint is satisfied at apply time.
//
// Roles:
//   admin  — full org access; manage users, billing, settings, all data
//   staff  — full CRUD on members/events/tasks/donations/schedule;
//            cannot manage users or org settings
//   viewer — read-only across the app
//
// Adds the constraint inside a DO block so a re-run that finds the
// constraint already present is a no-op rather than an error. Postgres
// doesn't have CREATE CONSTRAINT IF NOT EXISTS the way it has CREATE
// INDEX IF NOT EXISTS.

import pool from '../db.js'

export async function up() {
  console.log('Migration 003: roles-check — applying...')

  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ochr_users_role_check'
      ) THEN
        ALTER TABLE ochr_users
          ADD CONSTRAINT ochr_users_role_check
          CHECK (role IN ('admin', 'staff', 'viewer'));
      END IF;
    END
    $$
  `)

  console.log('Migration 003: roles-check — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
