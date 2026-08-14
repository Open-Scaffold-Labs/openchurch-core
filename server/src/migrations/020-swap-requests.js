// ochr_swap_requests + swap_token on ochr_clients
//
// Volunteer-scheduling depth, VS.2 — Path A (token-based magic links).
// Members don't have login accounts in v1, so each ochr_clients row
// carries a per-member swap_token. Public endpoints under
// /api/swap/by-token/:token resolve the token to a client and let
// them request / accept / decline swaps without authenticating.
//
// Design notes:
//   - swap_token is unique and nullable. Backfilling existing rows is
//     optional — admins generate on demand from the UI (same shape
//     as calendar_token).
//   - status is a CHECK constraint, not an enum, so adding a new
//     state later (e.g. 'expired') is a constraint replace rather
//     than a type migration.
//   - decided_at is null until the request leaves 'pending', so the
//     row history doubles as the audit trail of the decision.
//   - All FKs cascade with the natural lifetime of their parent: a
//     deleted event drops its swap requests, a deleted member drops
//     theirs, and an org delete cascades to all of it.

import pool from '../db.js'

export async function up() {
  console.log('Migration 020: swap-requests — applying...')

  await pool.query(`
    ALTER TABLE ochr_clients
      ADD COLUMN IF NOT EXISTS swap_token TEXT UNIQUE
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_swap_requests (
      id                   BIGSERIAL PRIMARY KEY,
      organization_id      INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      calendar_event_id    INTEGER NOT NULL REFERENCES ochr_calendar_events(id) ON DELETE CASCADE,
      requester_client_id  INTEGER NOT NULL REFERENCES ochr_clients(id) ON DELETE CASCADE,
      target_client_id     INTEGER NOT NULL REFERENCES ochr_clients(id) ON DELETE CASCADE,
      note                 TEXT,
      status               TEXT NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled')),
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      decided_at           TIMESTAMPTZ
    )
  `)

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_swap_requests_org_status ON ochr_swap_requests(organization_id, status)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_swap_requests_target    ON ochr_swap_requests(target_client_id, status)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_swap_requests_event     ON ochr_swap_requests(calendar_event_id)`)

  console.log('Migration 020: swap-requests — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
