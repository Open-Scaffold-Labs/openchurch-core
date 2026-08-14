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

// Identifier guard: table names come from information_schema (trusted),
// but they're interpolated into SQL, so belt-and-braces anyway.
const SAFE_TABLE = /^ochr_[a-z0-9_]+$/

export async function listOrgScopedTables() {
  const { rows } = await pool.query(`
    SELECT DISTINCT table_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND column_name  = 'organization_id'
       AND table_name LIKE 'ochr\\_%' ESCAPE '\\'
     ORDER BY table_name`)
  return rows
    .map(r => r.table_name)
    .filter(t => SAFE_TABLE.test(t) && !EXCLUDED_TABLES.has(t))
}

function stripSensitive(row) {
  const out = {}
  for (const [k, v] of Object.entries(row)) {
    if (SENSITIVE_COLUMN.test(k)) continue
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
    out.tables[table] = rows.map(stripSensitive)
    out.counts[table] = rows.length
  }

  return out
}
