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
//   credentialSanitize.js — the secret columns listed there are omitted
//     from each row. A vault snapshot is rows of their source table, so
//     the same list applies to snapshot roots and cascaded rows. jsonb
//     documents are not walked. security_code stays on that list:
//     stripping only the hash left the plaintext check-in code in the
//     parish dump (PORTABILITY-L2-01).

import pool from '../db.js'
import { isSecretColumn, sanitizeSnapshot } from './credentialSanitize.js'

export const EXCLUDED_TABLES = new Set([
  'ochr_push_subscriptions',       // device push keys — re-subscribable, never exportable
  'ochr_scheduled_notifications',  // transient delivery queue
  'ochr_notification_log',         // high-volume operational log, not parish records
])

// Secret columns are omitted by table. See credentialSanitize.js.
// Shared with vault capture and restore so the backup cannot drift
// from the download.

// Parish identity on the export header. ochr_organizations has no
// organization_id, so it is not picked up by the dynamic table scan; the
// header used to carry only id/name/slug/created_at and omitted the fields
// the settings page already treats as the parish's own (timezone, tradition,
// locale, address, letterhead, public-page copy). Billing provider ids and
// encrypted AI keys stay out — secrets and payment plumbing are not parish
// records for this artifact.
const ORG_IDENTITY_COLUMNS = [
  'id', 'name', 'slug', 'org_type', 'is_demo',
  'address', 'tax_id', 'signatory_name', 'signatory_title', 'statement_letterhead',
  'tagline', 'about', 'service_times', 'page_published',
  'reminder_lead_hours', 'timezone', 'tradition', 'locale',
  'created_at',
]

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

// Legacy check-in audit rows (Stage 7). Before #280 the audit middleware
// copied the check-in request body into metadata: child / guest / guardian
// names, notes and, on checkout, the pickup code spelling. New rows carry
// only the keys below. The export applies the same allowlist to every
// check-in audit row at read time, so old rows leave the system in the
// shape new rows are written in. The stored rows are not changed.
// Same four keys the writer keeps (auditLog.js CHECKIN_AUDIT_KEYS).
const CHECKIN_AUDIT_EXPORT_KEYS = ['calendar_event_id', 'client_id', 'kind', 'room_id']
// kind is the check-in kind (routes/checkins.js KINDS); ids are positive integers.
const CHECKIN_KINDS = new Set(['member', 'guest', 'child'])
// "Created checkin: <handle>" — the handle came from the request body.
const SUMMARY_HANDLE = /^([^:]*\bcheckin):.*$/s

function keepCheckinValue(k, v) {
  if (k === 'kind') return typeof v === 'string' && CHECKIN_KINDS.has(v)
  return Number.isSafeInteger(v) && v > 0
}

export function redactCheckinAudit(row) {
  if (row?.entity_type !== 'checkin') return { row, changed: false }
  let changed = false
  const out = { ...row }
  const md = row.metadata
  if (md && typeof md === 'object' && !Array.isArray(md)) {
    const kept = {}
    for (const k of CHECKIN_AUDIT_EXPORT_KEYS) {
      if (Object.hasOwn(md, k) && keepCheckinValue(k, md[k])) kept[k] = md[k]
    }
    if (Object.keys(kept).length !== Object.keys(md).length) changed = true
    out.metadata = kept
  } else if (md != null) {
    out.metadata = {}
    changed = true
  }
  if (typeof row.summary === 'string' && SUMMARY_HANDLE.test(row.summary)) {
    out.summary = row.summary.replace(SUMMARY_HANDLE, '$1')
    changed = true
  }
  // Before #280 request_path held the full URL, query string included.
  if (typeof row.request_path === 'string' && row.request_path.includes('?')) {
    out.request_path = row.request_path.split('?')[0]
    changed = true
  }
  return { row: out, changed }
}

function stripSensitive(table, row, generated = null) {
  const out = {}
  for (const [k, v] of Object.entries(row)) {
    if (isSecretColumn(table, k)) continue
    if (generated?.has(k)) continue
    // The snapshot column is not itself a secret. The rows inside it are
    // rows of entity_table / cascaded[].table, and only those columns
    // are omitted. answers, raw, and other jsonb cells are copied whole.
    if (table === 'ochr_vault_entries' && k === 'snapshot' && v && typeof v === 'object') {
      out[k] = sanitizeSnapshot(row.entity_table, v)
      continue
    }
    out[k] = v
  }
  return out
}

// options.projectRow is a test seam for the base-vs-head export diff.
// Production callers pass only orgId. The check-in audit redaction runs
// before projectRow, so the seam cannot bypass it and redactions.rows
// counts exactly the rows that were changed in this copy.
export async function buildOrgExport(orgId, options = {}) {
  const project = options.projectRow || stripSensitive
  const { rows: orgRows } = await pool.query(
    `SELECT ${ORG_IDENTITY_COLUMNS.join(', ')}
       FROM ochr_organizations WHERE id = $1`,
    [orgId]
  )
  if (!orgRows.length) throw new Error('Organization not found')

  const tables = await listOrgScopedTables()
  const generated = await generatedColumns()
  const out = {
    format:       'openchurch-export',
    // v2: parish identity header carries the settings-surface fields above
    // (timezone, tradition, locale, address, letterhead, …). Field names on
    // table rows are unchanged; additive only.
    version:      2,
    exported_at:  new Date().toISOString(),
    organization: orgRows[0],
    counts:       {},
    // What this copy deliberately leaves out of rows it does include.
    redactions:   {
      ochr_audit_log: {
        rows: 0,
        rule: 'Check-in audit entries keep only event, member, kind and room ids, and request paths lose any query string. Names, notes and pickup codes recorded in older entries are removed from this copy. The stored audit log is unchanged.',
      },
    },
    tables:       {},
  }

  for (const table of tables) {
    // ORDER BY 1 (first column = id everywhere in this schema) keeps
    // exports diffable run-to-run.
    const { rows } = await pool.query(
      `SELECT * FROM ${table} WHERE organization_id = $1 ORDER BY 1`,
      [orgId]
    )
    let redacted = 0
    out.tables[table] = rows.map(r => {
      if (table === 'ochr_audit_log') {
        const res = redactCheckinAudit(r)
        if (res.changed) redacted++
        r = res.row
      }
      return project(table, r, generated[table])
    })
    if (table === 'ochr_audit_log') out.redactions.ochr_audit_log.rows = redacted
    out.counts[table] = rows.length
  }

  return out
}
