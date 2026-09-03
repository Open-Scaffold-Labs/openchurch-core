// Row-level security for the tables that predate the convention.
//
// Since 041-bulletins.js every migration that creates an `ochr_*` table has
// turned RLS on in the same up() that created it. Everything older did not:
// RLS was switched on for those tables directly against production on
// 2026-06-16, and that sweep was never written back as a migration. The
// result is two different databases wearing the same schema —
//
//   production            68 of 68 ochr_* tables with relrowsecurity
//   built from migrations 31 of 68
//
// — and the 37 in the gap are not marginal ones. They are ochr_clients,
// ochr_donations, ochr_audit_log, ochr_attendance, ochr_checkins,
// ochr_form_responses: the member roll, the giving history, and the record
// of who looked at them.
//
// That gap is only invisible while production keeps running. It becomes
// real the moment a database is built from this chain rather than restored
// from a snapshot — a recovery drill, a staging tenant, a new region, the
// throwaway Postgres the smoke suite runs against. Each of those comes up
// with the parish roll unprotected, and nothing in the boot log says so.
//
// The sweep is written against pg_class rather than a hardcoded list on
// purpose. A list would be a second copy of a fact the database already
// knows, and would rot the first time a table was added or renamed; asking
// the catalogue converges on the same posture no matter which point in the
// chain a database was built from. There is nothing to exclude: production
// enables RLS on every ochr_* table without exception, so "all of them" is
// the target state, not an approximation of it.
//
// Enabling RLS grants nothing and revokes nothing here. The app connects as
// the owning role, which bypasses RLS, so every query in the server behaves
// exactly as before — this migration is a no-op against production, which
// is the point. What it closes is the other door: the anon/PostgREST path,
// where no policy exists and RLS therefore denies by default. No migration
// in this repo defines a policy, deliberately; enable-only is the posture.

import pool from '../db.js'

export async function up() {
  console.log('Migration 080: RLS sweep — applying...')

  // The loop runs server-side so the set of tables and the ALTERs against
  // it cannot drift between two round trips. format(%I) quotes each
  // identifier rather than interpolating a name into SQL.
  await pool.query(`
    DO $$
    DECLARE
      t text;
    BEGIN
      FOR t IN
        SELECT c.relname
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind = 'r'
           AND n.nspname = 'public'
           AND c.relname LIKE 'ochr\\_%'
           AND NOT c.relrowsecurity
         ORDER BY c.relname
      LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
        RAISE NOTICE 'RLS enabled on %', t;
      END LOOP;
    END $$;
  `)

  // Verified in a second round trip: node-postgres hands back an array of
  // results for a multi-statement query, so the check has to be its own.
  const { rows } = await pool.query(`
    SELECT count(*)::int AS remaining
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind = 'r'
       AND n.nspname = 'public'
       AND c.relname LIKE 'ochr\\_%'
       AND NOT c.relrowsecurity
  `)

  // Fail loudly rather than leaving a half-protected database looking green.
  // The ledger records 080 as applied on success, so a partial sweep that
  // reported success would never be retried.
  const remaining = rows?.[0]?.remaining ?? 0
  if (remaining > 0) {
    throw new Error(
      `Migration 080: ${remaining} ochr_* table(s) still without RLS after the sweep`,
    )
  }

  console.log('Migration 080: RLS sweep — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
