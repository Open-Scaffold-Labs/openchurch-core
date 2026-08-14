// ochr_feedback_ledger (FB.1) — the founder's workbench.
//
// A gated, in-app, accountless-feeling feedback channel for the Founding
// Parishes cohort: any authenticated user can send a short note (bug,
// suggestion, or pastoral note) that lands directly in this table. We
// deliberately chose this over a public forum to keep the loop calm and
// personal.
//
//   user_id / user_email / user_role — captured from the caller's verified
//     JWT claims at submit time (email/role denormalized so the record still
//     makes sense if the user is later removed; user_id ON DELETE SET NULL).
//   category — 'bug' | 'suggestion' | 'pastoral_note' (CHECK).
//   route    — the client path the user was on (window.location.pathname),
//              so a bug report carries its own context.

import pool from '../db.js'

export async function up() {
  console.log('Migration 051: feedback-ledger — applying...')

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_feedback_ledger (
      id               BIGSERIAL PRIMARY KEY,
      organization_id  INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      user_id          INTEGER REFERENCES ochr_users(id) ON DELETE SET NULL,
      user_email       TEXT,
      user_role        TEXT,
      category         TEXT NOT NULL CHECK (category IN ('bug', 'suggestion', 'pastoral_note')),
      message          TEXT NOT NULL,
      route            TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_feedback_org_created ON ochr_feedback_ledger(organization_id, created_at DESC)`)

  // RLS enabled with no policy — the ochr_* invariant (tenancy enforced in
  // the route layer; advisors flag rls_disabled_in_public otherwise).
  await pool.query(`ALTER TABLE ochr_feedback_ledger ENABLE ROW LEVEL SECURITY`)

  console.log('Migration 051: feedback-ledger — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
