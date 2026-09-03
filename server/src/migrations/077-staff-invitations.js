// Staff invitations (PILOT.2).
//
// THE PROBLEM THIS FIXES IS NOT A MISSING FEATURE.
//
// Adding a colleague went through POST /api/users, which creates the
// account AND sets its password. So a chancery administrator had to invent
// a password for every colleague and convey it to them — which means the
// administrator knows it, the conveyance is usually a chat message or a
// sticky note, and almost nobody changes it afterwards.
//
// That is a credential-sharing workflow built into the product. It is not
// something to hand a real diocese during a pilot, and it is the reason
// this sprint comes before the prettier ones.
//
// WHAT REPLACES IT
//
// An invitation: the account exists, the person sets their own password
// from a one-time link, and nobody else ever knows it. The token machinery
// is `ochr_password_reset_tokens`, unchanged — a set-password link and a
// reset link are the same object with different words around them, and a
// second token table would be two things to expire correctly instead of
// one.
//
// The columns here exist only to answer "has this person accepted yet",
// which the token table cannot answer once a token is consumed or expires.
//
// password_hash stays NOT NULL. A pending user gets a hash of random bytes
// nobody holds, so the account is unusable rather than open — a nullable
// password column would make "no password" a state every login path has to
// remember to check, and one that forgets is a way in.

import pool from '../db.js'

export async function up() {
  console.log('Migration 077: staff invitations — applying...')

  await pool.query(`
    ALTER TABLE ochr_users
      ADD COLUMN IF NOT EXISTS invited_at        TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS invite_accepted_at TIMESTAMPTZ,
      -- Snapshot, per the 073/074 pattern: who opened the door stays
      -- answerable even after that person leaves.
      ADD COLUMN IF NOT EXISTS invited_by_name   TEXT
  `)

  // Everyone who already exists got here by some other route and has a
  // password they chose or were given. Marking them accepted keeps them out
  // of the pending list; leaving invited_at null records honestly that we
  // do not know how they were added.
  const { rowCount } = await pool.query(`
    UPDATE ochr_users SET invite_accepted_at = COALESCE(created_at, NOW())
     WHERE invite_accepted_at IS NULL AND invited_at IS NULL
  `)
  console.log(`  ✓ ${rowCount} existing user(s) marked as already active`)

  // Finding the pending ones is the common read on the team page.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_users_pending_invites
      ON ochr_users(organization_id)
      WHERE invite_accepted_at IS NULL
  `)

  console.log('Migration 077: staff invitations — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
