// F-02 — neutralize the seeded demo@openchurch.app admin on non-local
// databases.
//
// NUMBERING: 117 is an unpublished reservation on main 9609694 (116 is the
// last merged migration). Reconcile with main before any merge.
// APPROVAL: this WRITES to production when deployed. José/TARS must
// approve before it ships. It does not delete anything.
//
// migrate.js documents that demo@openchurch.app exists in production as
// id 1, role admin, with the public password 'demo1234'. The earlier fix
// stopped RE-creating it; it left the existing row alone. This migration
// makes that row unusable without deleting it (history keeps pointing at
// the same actor):
//   - deactivated_at set (requireAuth refuses the login),
//   - password_hash rotated to a bcrypt of 32 random bytes nobody holds,
//   - token_version bumped (every outstanding token dies),
//   - outstanding password-reset tokens marked used.
// Role, email, and organization are left as they are. Re-enabling it is a
// deliberate operator action (turn the login back on + set a new password).
//
// Skipped ONLY for a development/test process on a local database
// (isDevLocalTarget). SEED_DEMO=true does NOT skip it (ARG-PATCH-3-1): on any
// other target an existing demo row is neutralized even if seeding was
// forced, and a remote demo environment must re-enable its login on purpose.

import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import pool from '../db.js'
import { isDevLocalTarget, DEFAULT_DEMO_EMAIL } from '../migrate.js'

export async function neutralizeDemoAdmin(db = pool, email = DEFAULT_DEMO_EMAIL) {
  const hash = await bcrypt.hash(crypto.randomBytes(32).toString('base64url'), 10)
  const { rows } = await db.query(
    `UPDATE ochr_users
        SET deactivated_at = COALESCE(deactivated_at, NOW()),
            password_hash  = $2,
            token_version  = COALESCE(token_version, 1) + 1
      WHERE lower(btrim(email)) = lower(btrim($1))
        AND closed_at IS NULL
        -- R286-2: a held organization's users are already inaccessible
        -- (HOLD deactivated them and revoked sessions) and migration 114
        -- refuses writes to them. Skip, do not disable the guard.
        AND organization_id IN (SELECT id FROM ochr_organizations WHERE held_at IS NULL)
      RETURNING id`,
    [email, hash]
  )
  if (rows.length) {
    await db.query(
      `UPDATE ochr_password_reset_tokens SET used_at = NOW()
        WHERE user_id = ANY($1::int[]) AND used_at IS NULL`,
      [rows.map(r => r.id)]
    )
  }
  // Report what was left alone and why, so a replay is explainable.
  const { rows: skipped } = await db.query(
    `SELECT u.id, CASE WHEN u.closed_at IS NOT NULL THEN 'closed' ELSE 'held' END AS reason
       FROM ochr_users u JOIN ochr_organizations o ON o.id = u.organization_id
      WHERE lower(btrim(u.email)) = lower(btrim($1))
        AND (u.closed_at IS NOT NULL OR o.held_at IS NOT NULL)`,
    [email])
  return { neutralized: rows.map(r => r.id), skipped }
}

// R286-1: decided on the EFFECTIVE target (migrate.js targetIsLocal, the
// shared db-target-guard), never the URL authority alone.
export function shouldNeutralizeDemo(env = process.env, local) {
  return !(local === undefined ? isDevLocalTarget(env) : isDevLocalTarget(env, local))
}

export async function up() {
  console.log('Migration 117: neutralize-demo-admin — applying...')
  if (!shouldNeutralizeDemo()) {
    console.log('  development/test process on a local database — demo login left as is.')
    return
  }
  const { neutralized, skipped } = await neutralizeDemoAdmin(pool)
  console.log(`  demo admin neutralized: ${neutralized.length ? neutralized.join(',') : 'none found'}`)
  if (skipped.length) console.log(`  already inaccessible, left as is: ${skipped.map(r => `${r.id}(${r.reason})`).join(',')}`)
}
