// Session lifecycle + race-duplicate guards (Master Engineering Audit,
// H5 + M1).
//
// 1. H5 — ochr_users.token_version makes JWTs revocable. The version is
//    embedded in every token at issue; requireAuth compares it to the
//    live row. Bumping the version (password reset, sign-out-everywhere)
//    invalidates every outstanding token at once. Existing tokens have
//    no `tv` claim and are treated as version 1 — the default — so this
//    deploy signs nobody out.
//
// 2. M1 — DB-level guards for the two check-then-act races the app
//    layer can't close alone (the 050 payment_ref pattern, reused):
//    duplicate pending swap requests and kiosk double-tap check-ins.
//    Each dedupes existing rows (keep the earliest) before the index.

import pool from '../db.js'

export async function up() {
  console.log('Migration 055: session-and-race-guards — applying...')

  // ── H5: revocable sessions ─────────────────────────────────────
  await pool.query(`
    ALTER TABLE ochr_users
      ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 1
  `)

  // ── M1a: one pending swap request per (event, requester, target) ─
  await pool.query(`
    DELETE FROM ochr_swap_requests a
     USING ochr_swap_requests b
     WHERE a.status = 'pending' AND b.status = 'pending'
       AND a.organization_id = b.organization_id
       AND a.calendar_event_id = b.calendar_event_id
       AND a.requester_client_id = b.requester_client_id
       AND a.target_client_id = b.target_client_id
       AND a.id > b.id
  `)
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_swap_requests_pending
      ON ochr_swap_requests(organization_id, calendar_event_id, requester_client_id, target_client_id)
      WHERE status = 'pending'
  `)

  // ── M1b: one ACTIVE check-in per (event, member) ───────────────
  // Guests and children check in by name (client_id NULL) and may
  // legitimately repeat, so the guard is partial. Checked-out rows are
  // history, not an active presence — also excluded.
  await pool.query(`
    DELETE FROM ochr_checkins a
     USING ochr_checkins b
     WHERE a.client_id IS NOT NULL AND b.client_id IS NOT NULL
       AND a.checked_out_at IS NULL AND b.checked_out_at IS NULL
       AND a.calendar_event_id = b.calendar_event_id
       AND a.client_id = b.client_id
       AND a.id > b.id
  `)
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_checkins_active
      ON ochr_checkins(calendar_event_id, client_id)
      WHERE client_id IS NOT NULL AND checked_out_at IS NULL
  `)

  console.log('Migration 055: session-and-race-guards — applied.')
}
