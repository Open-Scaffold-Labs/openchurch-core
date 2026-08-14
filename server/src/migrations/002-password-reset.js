// Adds the password-reset tokens table.
//
// Design:
//   - We store SHA-256 hashes of tokens, not raw tokens. The user gets
//     the raw token in their email; we hash on insert and on lookup. If
//     the DB is ever dumped, the tokens in it can't be used directly.
//   - Tokens expire after 1 hour. Garbage collection is opportunistic
//     (lookups filter on expires_at > NOW); a periodic sweep can come
//     later if the table grows.
//   - One-shot use — once a token resets a password, used_at is set
//     and the token cannot be reused even if it hasn't expired.
//
// Idempotent: safe to re-run.

import pool from '../db.js'

export async function up() {
  console.log('Migration 002: password-reset-tokens — applying...')

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_password_reset_tokens (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES ochr_users(id) ON DELETE CASCADE,
      token_hash  TEXT NOT NULL UNIQUE,
      expires_at  TIMESTAMPTZ NOT NULL,
      used_at     TIMESTAMPTZ,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user
      ON ochr_password_reset_tokens(user_id)
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_expires
      ON ochr_password_reset_tokens(expires_at)
  `)

  console.log('Migration 002: password-reset-tokens — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
