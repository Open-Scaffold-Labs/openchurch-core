// ARG-V2-1 — address-only mail to a CLOSED login's former address.
//
// NUMBERING: 119 (reset PR6), after 118-views-security-invoker.
//
// Closure rewrites ochr_users.email to a tombstone, so the dispatcher's
// send-time backstop can no longer recognise mail queued
// later by address only to the old address. We keep a one-way SHA-256 of
// the normalised former address per org (never the address itself) and
// dispatch admission (notifications/transport.js) refuses address-only
// mail that matches it. The
// suppression stops applying as soon as an ACTIVE login in the same org
// holds that address again (the address was released and re-used).
//
// PRIVACY NOTE (accepted by José 2026-10-17): this retains an unsalted SHA-256 of the normalised address, per
// parish. This is NOT anonymisation: email addresses are low-entropy, so
// anyone with the table can confirm a guessed address or run an offline
// dictionary attack (lists of known or likely addresses) to recover it.
// Limits: no backfill (logins closed before 119 have no row); no retention
// period has been chosen (rows stay until the parish is deleted); isolation
// is app-role scoping (RLS on with no policies, not forced; anon and
// authenticated revoked).

import pool from '../db.js'

export async function up() {
  console.log('Migration 119: closed-address-suppression — applying...')
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_closed_address_suppressions (
      organization_id INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      email_sha256    TEXT    NOT NULL CHECK (email_sha256 ~ '^[0-9a-f]{64}$'),
      closed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (organization_id, email_sha256)
    )
  `)
  await pool.query('ALTER TABLE ochr_closed_address_suppressions ENABLE ROW LEVEL SECURITY')
  // Same posture as 118 (Jarvis R9): no Supabase data-API grants at all.
  const { rows: roles } = await pool.query(
    `SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')`)
  for (const { rolname } of roles) {
    await pool.query(`REVOKE ALL ON ochr_closed_address_suppressions FROM ${rolname}`)
  }
  // HOLD boundary (Stage 6, migration 114): every org-scoped ochr_ table
  // carries the held-organization write guard. 114 attached it to the
  // tables that existed then; this table is new, so attach the same guard
  // here (114 itself is merged and stays untouched; re-running it re-creates
  // this identical trigger).
  await pool.query('DROP TRIGGER IF EXISTS ochr_organization_hold_guard ON ochr_closed_address_suppressions')
  await pool.query(`CREATE TRIGGER ochr_organization_hold_guard
    BEFORE INSERT OR UPDATE OR DELETE ON ochr_closed_address_suppressions
    FOR EACH ROW EXECUTE FUNCTION ochr_held_organization_write_guard()`)
  console.log('Migration 119: closed-address-suppression — done.')
}
