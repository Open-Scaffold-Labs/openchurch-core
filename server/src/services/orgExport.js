// buildOrgExport(orgId) — the complete, portable copy of one parish's
// data. This single function backs BOTH trust promises:
//
//   1. "Your data exports anytime"  — GET /api/organization/export
//   2. "It's backed up off-site"    — the weekly cron digest
//
// Table discovery is dynamic (information_schema: every ochr_* table
// carrying an organization_id column) so new org-scoped tables are
// included automatically — a backup that silently omits a new module's
// table is worse than no backup. Two safety layers on top:
//
//   EXCLUDED_TABLES — transient queues / device-credential tables that
//     don't belong in a parish's copy of its own records.
//   SENSITIVE_COLUMN — no credential-shaped column ever leaves the DB,
//     even if a future migration forgets this file exists.

import pool from '../db.js'

const EXCLUDED_TABLES = new Set([
  'ochr_push_subscriptions',       // device push keys — re-subscribable, never exportable
  'ochr_scheduled_notifications',  // transient delivery queue
  'ochr_notification_log',         // high-volume operational log, not parish records
])

const SENSITIVE_COLUMN = /(password|secret|token|pepper|hash)/i

// Columns Postgres computes for itself. They must not be in the artifact:
// they cannot be inserted on the way back ("cannot insert a non-DEFAULT
// value into column"), they are derived from data already in the export,
// and they are large — a tsvector is most of a member row's bytes.
//
// This was found by running scripts/offsite-restore-drill.mjs, not by
// reading the code. Every members row and every giving row in the weekly
// off-site backup failed to restore, which meant the two tables a parish
// would most want back were the two the artifact could not return. The
// backup had been produced every Saturday for months and never restored.
let generatedCache = null
async function generatedColumns() {
  if (generatedCache) return generatedCache
  const { rows } = await pool.query(`
    SELECT table_name, column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name LIKE 'ochr\\_%' ESCAPE '\\'
       AND (is_generated <> 'NEVER' OR is_identity <> 'NO')`)
  const out = {}
  for (const r of rows) (out[r.table_name] ||= new Set()).add(r.column_name)
  generatedCache = out
  return out
}

// Identifier guard: table names come from information_schema (trusted),
// but they're interpolated into SQL, so belt-and-braces anyway.
const SAFE_TABLE = /^ochr_[a-z0-9_]+$/

export async function listOrgScopedTables() {
  // BASE TABLE only. information_schema.columns lists views too, and
  // three ochr_* views carry organization_id — ochr_parish_ledger,
  // ochr_sacristy_weekly_manifest, ochr_telemetry_dashboard. Exporting a
  // view means shipping the same rows twice, once as records and once as
  // a derived reading of those records, and a restore then tries to
  // INSERT into a view and fails. Found by the off-site restore drill.
  const { rows } = await pool.query(`
    SELECT DISTINCT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = 'public'
       AND c.column_name  = 'organization_id'
       AND c.table_name LIKE 'ochr\\_%' ESCAPE '\\'
       AND t.table_type = 'BASE TABLE'
     ORDER BY 1`)
  return rows
    .map(r => r.table_name)
    .filter(t => SAFE_TABLE.test(t) && !EXCLUDED_TABLES.has(t))
}

function stripSensitive(row, generated = null) {
  const out = {}
  for (const [k, v] of Object.entries(row)) {
    if (SENSITIVE_COLUMN.test(k)) continue
    if (generated?.has(k)) continue
    out[k] = v
  }
  return out
}

export async function buildOrgExport(orgId) {
  const { rows: orgRows } = await pool.query(
    'SELECT id, name, slug, created_at FROM ochr_organizations WHERE id = $1',
    [orgId]
  )
  if (!orgRows.length) throw new Error('Organization not found')

  const tables = await listOrgScopedTables()
  const generated = await generatedColumns()
  const out = {
    format:       'openchurch-export',
    version:      1,
    exported_at:  new Date().toISOString(),
    organization: orgRows[0],
    counts:       {},
    tables:       {},
  }

  for (const table of tables) {
    // ORDER BY 1 (first column = id everywhere in this schema) keeps
    // exports diffable run-to-run.
    const { rows } = await pool.query(
      `SELECT * FROM ${table} WHERE organization_id = $1 ORDER BY 1`,
      [orgId]
    )
    out.tables[table] = rows.map(r => stripSensitive(r, generated[table]))
    out.counts[table] = rows.length
  }

  return out
}
