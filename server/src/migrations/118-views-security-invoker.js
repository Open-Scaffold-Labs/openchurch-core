// F-03 — the four public views run with the CALLER's privileges.
//
// NUMBERING: 118 is an unpublished reservation on main 9609694. Reconcile
// with main before any merge.
//
// A plain view runs as its owner. Every table here has RLS enabled with no
// policies, so tenant isolation lives in app code; but a view owned by the
// table owner bypasses RLS for whoever can SELECT the view. If Supabase's
// PostgREST data API exposes `public`, anon/authenticated could read
// donor and ledger rows across parishes through these views.
//
// security_invoker = true (Postgres 15+) makes the view apply the caller's
// privileges and RLS. The app's own role reads the base tables directly
// already, so the rows it sees through the views do not change.
// We also REVOKE anon/authenticated grants where those roles exist.
//
// MAINTENANCE: CREATE OR REPLACE VIEW does not keep this option unless
// the new statement repeats it. Any later migration that redefines one of
// these views must say `CREATE OR REPLACE VIEW ... WITH (security_invoker
// = true) AS ...`. tests/viewsSecurityInvokerF03.test.js fails otherwise.

import pool from '../db.js'
import { monitor } from '../monitoring/index.js'

export const INVOKER_VIEWS = [
  'ochr_donation_live',            // 104-donation-refund-facts.js:154
  'ochr_parish_ledger',            // 104-donation-refund-facts.js:179
  'ochr_sacristy_weekly_manifest', // 110-prior-fulfilment-label.js:18
  'ochr_telemetry_dashboard',      // 052-telemetry-dashboard.js:22
]
const API_ROLES = ['anon', 'authenticated']

export async function up() {
  console.log('Migration 118: views-security-invoker — applying...')
  const { rows: [{ v }] } = await pool.query(`SELECT current_setting('server_version_num')::int AS v`)
  const { rows: roles } = await pool.query(
    'SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])', [API_ROLES])
  for (const view of INVOKER_VIEWS) {
    const { rows } = await pool.query(`SELECT to_regclass($1) AS r`, [`public.${view}`])
    if (!rows[0].r) continue
    if (v >= 150000) {
      await pool.query(`ALTER VIEW public.${view} SET (security_invoker = true)`)
    } else {
      // Cannot set it; the REVOKE below is the whole mitigation here.
      monitor.error('migrations.118', new Error(`Postgres ${v} < 15: security_invoker unavailable for ${view}`))
    }
    for (const { rolname } of roles) {
      await pool.query(`REVOKE ALL ON public.${view} FROM ${rolname}`)
    }
  }
}
