// Reversible login deactivation.
//
// A deactivated row stays. Email, role, and parish records stay. The
// person cannot sign in, and every token they already hold dies because
// token_version moves. Turning the login back on is a separate update.
// This is not account deletion and it does not close the organization.

import pool from '../db.js'

export async function up() {
  console.log('Migration 111: login-deactivation — applying...')

  await pool.query(`
    ALTER TABLE ochr_users
      ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ
  `)
}
