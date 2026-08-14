// ochr_checkins.security_code_hash (CHK.3 hardening / child-data safety)
//
// The kid-pickup code used to be stored as PLAINTEXT in
// ochr_checkins.security_code — a database dump revealed every active
// child-pickup code, and it was inconsistent with the SHA-256 hashing we
// already apply to password-reset tokens. This migration:
//
//   1. adds security_code_hash TEXT,
//   2. backfills the hash for any still-active (not-yet-checked-out) child
//      so an in-progress pickup keeps working across the deploy, and
//   3. NULLs every plaintext security_code so none remain at rest.
//
// From here on the routes store only the hash; the plaintext code is shown
// to the guardian once in the check-in response and never persisted.

import pool from '../db.js'
// Reuse the single source of truth for hashing so the migration and the
// runtime routes can never drift (same normalization, same keyed HMAC).
import { hashSecurityCode as hashCode } from '../utils/pickupCode.js'

export async function up() {
  console.log('Migration 043: checkin-code-hash — applying...')

  await pool.query(`
    ALTER TABLE ochr_checkins
      ADD COLUMN IF NOT EXISTS security_code_hash TEXT
  `)

  // Preserve in-flight pickups: hash the codes of children still checked
  // in, so staff can still release them with the code the guardian holds.
  const { rows } = await pool.query(
    `SELECT id, security_code FROM ochr_checkins
      WHERE security_code IS NOT NULL AND checked_out_at IS NULL`
  )
  for (const r of rows) {
    await pool.query(
      'UPDATE ochr_checkins SET security_code_hash = $1 WHERE id = $2',
      [hashCode(r.security_code), r.id]
    )
  }

  // Purge ALL plaintext codes at rest (active ones are now hashed above;
  // checked-out ones are spent and don't need a hash).
  await pool.query(
    `UPDATE ochr_checkins SET security_code = NULL WHERE security_code IS NOT NULL`
  )

  console.log(`Migration 043: checkin-code-hash — applied (hashed ${rows.length} active code(s)).`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
