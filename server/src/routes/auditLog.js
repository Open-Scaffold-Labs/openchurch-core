// Read-only audit log endpoint. Mounted admin-only — the audit table
// is the high-trust signal for "who did what?" so non-admins should
// not be able to enumerate it. Writes happen via the auditLog
// middleware (server/src/middleware/auditLog.js); this router doesn't
// expose POST/PATCH/DELETE.

import { Router } from 'express'
import pool from '../db.js'
import { parseIntId } from '../utils/params.js'
import { monitor } from '../monitoring/index.js'

const router = Router()

const MAX_LIMIT = 200
const DEFAULT_LIMIT = 50
// Past this many matches the footer stops counting and says "N+". High
// enough that a normal parish never sees the cap; low enough that the count
// is bounded work on a log that only ever grows.
//
// Mutable solely so the tests can cross it. Seeding 10,001 audit rows to
// prove the cap works would add minutes to every suite run — and a cap that
// is never crossed in a test is a cap nobody has watched work. Lowering it
// to 3 for four assertions costs nothing and exercises the real branch.
let COUNT_CAP = 10000

// Test seam. Returns the previous value so a test can restore it, and
// refuses anything that isn't a positive integer so a typo can't silently
// disable the cap in production.
export function _setAuditCountCapForTests(n) {
  const previous = COUNT_CAP
  if (!Number.isInteger(n) || n < 1) throw new Error('count cap must be a positive integer')
  COUNT_CAP = n
  return previous
}

const ALLOWED_ACTIONS = new Set(['create', 'update', 'delete'])
// Keep in step with the entity_type tags used at the call sites in
// app.js. New routers added to the audit middleware should be added
// here so the filter dropdown UI can validate input.
//
// One tag per top-level router: 'payroll' covers both /staff and
// /shifts under /api/payroll; 'donation' covers both /donations and
// /cash-counts. The audit row's summary (built from name/title) gives
// admins the granularity they care about without splitting the tag.
const ALLOWED_ENTITY_TYPES = new Set([
  'client', 'event', 'task', 'calendar_event',
  'donation', 'payroll', 'user', 'organization',
  'attendance', 'pledge',
  // AUD.1 — these tags are emitted by auditLog('x') mounts in app.js
  // but were missing from this allowlist, so filtering the log by them
  // returned 400 even though the rows existed. Keep in lockstep with
  // app.js (and the ENTITY_TYPES dropdown in client/src/pages/Audit.jsx).
  'group', 'group_interest', 'fund', 'availability', 'checkin',
  'room', 'kiosk', 'parish_feast', 'swap_request', 'form', 'bulletin',
  'service_plan', 'sacrament', 'mass_intention',
  'support_ticket', // SUP.2 — /api/support-tickets mount
  'import_batch',   // MIG.1 — /api/imports mount
  'fee_schedule', 'invoice', // BILL.0/BILL.1 — offerings & fees mounts
])

// Build a parameterized WHERE from the shared filter query params. Both
// the JSON list and the CSV export run through this so their filtering
// can never drift. Returns { where, params } or { error } on a bad
// filter value (the caller maps that to a 400).
function buildAuditFilters(organizationId, query) {
  const clauses = ['organization_id = $1']
  const params  = [organizationId]

  if (query.action) {
    if (!ALLOWED_ACTIONS.has(query.action)) return { error: 'Invalid action filter' }
    params.push(query.action)
    clauses.push(`action = $${params.length}`)
  }
  if (query.entity_type) {
    if (!ALLOWED_ENTITY_TYPES.has(query.entity_type)) return { error: 'Invalid entity_type filter' }
    params.push(query.entity_type)
    clauses.push(`entity_type = $${params.length}`)
  }
  if (query.entity_id) {
    params.push(String(query.entity_id))
    clauses.push(`entity_id = $${params.length}`)
  }
  if (query.user_id) {
    const uid = parseIntId(query.user_id)
    if (uid === null) return { error: 'Invalid user_id' }
    params.push(uid)
    clauses.push(`user_id = $${params.length}`)
  }
  if (query.since) {
    const since = new Date(query.since)
    if (Number.isNaN(since.getTime())) return { error: 'Invalid since' }
    params.push(since.toISOString())
    clauses.push(`created_at >= $${params.length}`)
  }
  if (query.until) {
    const until = new Date(query.until)
    if (Number.isNaN(until.getTime())) return { error: 'Invalid until' }
    params.push(until.toISOString())
    clauses.push(`created_at <= $${params.length}`)
  }
  // `scoped` keeps organization_id VISIBLE in each caller's SQL instead of
  // burying it inside an interpolated WHERE. A tenant filter that exists only
  // in a builder is invisible to review and to scripts/audit-tenancy.mjs,
  // which is a tripwire over the query text — and a tripwire that cannot see
  // the clause cannot tell a scoped query from an unscoped one.
  // organizationId stays $1, so every later placeholder is unchanged.
  const extra = clauses.slice(1).join(' AND ')
  return {
    where: clauses.join(' AND '),
    // Only the OPTIONAL filters, pre-joined with a leading AND. Callers write
    // `WHERE organization_id = $1${extraSql}` so the tenant clause is literal
    // text in the query rather than something a builder promises to have
    // added. organizationId stays $1, so every later placeholder is unchanged.
    extraSql: extra ? ` AND ${extra}` : '',
    params,
  }
}

// GET /api/audit-log
//   ?limit=50&offset=0
//   &action=create
//   &entity_type=client
//   &entity_id=42
//   &user_id=7
//   &since=2026-04-01T00:00:00Z
//   &until=2026-05-01T00:00:00Z
router.get('/', async (req, res) => {
  try {
    // Parse + clamp pagination.
    const rawLimit  = parseIntId(req.query.limit)
    const rawOffset = req.query.offset !== undefined ? Number(req.query.offset) : 0
    const limit  = rawLimit ? Math.min(rawLimit, MAX_LIMIT) : DEFAULT_LIMIT
    const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0

    const filters = buildAuditFilters(req.organizationId, req.query)
    if (filters.error) return res.status(400).json({ error: filters.error })
    const { extraSql, params } = filters

    // Count, but only up to COUNT_CAP. An exact COUNT(*) has to visit every
    // matching row, so it grew without bound while the page it decorates
    // stayed fixed at 50 rows. Measured on a 400,000-entry log:
    //
    //     the page itself (50 rows)   0.205 ms       16 buffers
    //     COUNT(*) beside it         32.5   ms    7,540 buffers
    //
    // 158x the cost of the thing it was labelling, and the gap widens every
    // day the log grows. Stopping at COUNT_CAP + 1 bounds that work: past
    // the cap the footer says "10,000+" instead of a precise number nobody
    // reads, and the count touches a fixed slice of index instead of the
    // whole table.
    const countParams = [...params, COUNT_CAP + 1]
    const countQ = await pool.query(
      `SELECT COUNT(*)::int AS total FROM (
         SELECT 1 FROM ochr_audit_log WHERE organization_id = $1${extraSql} LIMIT $${countParams.length}
       ) capped`,
      countParams)
    const counted = countQ.rows[0].total
    const totalCapped = counted > COUNT_CAP
    const total = totalCapped ? COUNT_CAP : counted

    // Then pull the page itself. Same WHERE, same params, plus limit/offset.
    // limit + 1 rather than limit: the extra row is how we know whether a
    // next page exists. hasMore used to be derived from `total`, which meant
    // capping the count would have silently capped the Load-more button too
    // — an admin scrolling a busy log would have hit an invisible wall at
    // entry 10,000. The probe row is exact at any depth and costs one row.
    const pageParams = [...params, limit + 1, offset]
    const rowsQ = await pool.query(
      `SELECT id, user_id, user_email, user_name, action, entity_type, entity_id,
              summary, metadata, request_method, request_path, status_code,
              ip_address, created_at
         FROM ochr_audit_log
        WHERE organization_id = $1${extraSql}
        ORDER BY created_at DESC, id DESC
        LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
      pageParams
    )
    const hasMore  = rowsQ.rows.length > limit
    const pageRows = hasMore ? rowsQ.rows.slice(0, limit) : rowsQ.rows

    // 30s private cache. Audit-log entries are append-only, so a brief
    // browser cache of an admin's filtered/paginated view is safe even
    // when concurrent activity is producing new rows — the new rows
    // surface on next manual reload (Audit page already exposes a
    // refresh button) or after the cache expires. `private` keeps it
    // out of any shared CDN cache; we don't want one admin's filtered
    // result served to another tenant's admin.
    res.set('Cache-Control', 'private, max-age=30')
    res.json({
      rows: pageRows,
      total,
      // true when there are more than COUNT_CAP matches, so the UI can
      // render "10,000+" rather than claiming a precision it doesn't have.
      total_capped: totalCapped,
      limit,
      offset,
      hasMore,
    })
  } catch (err) {
    monitor.error('audit-log.list', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load audit log' })
  }
})

// Hard cap on an export so one click can't pull an unbounded table into
// memory. Plenty for an admin's date-bounded compliance pull; bigger
// jobs should narrow the date range.
const MAX_EXPORT = 5000

// One CSV cell — wraps in quotes and doubles embedded quotes so commas,
// newlines, and quotes in summaries/paths can't break the row shape.
// A leading =, +, -, @, tab or CR is prefixed with a single quote so a
// crafted value (e.g. a member named "=cmd|'/c calc'!A1") can't execute
// as a formula when an admin opens the export in Excel/Sheets.
function csvCell(v) {
  if (v === null || v === undefined) return ''
  let s = String(v)
  // Prefix only — a single leading apostrophe makes Excel/Sheets treat
  // the whole cell as text. A trailing one would just corrupt the value.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return `"${s.replace(/"/g, '""')}"`
}

// GET /api/audit-log/export.csv  — same filters as the list (AUD.2).
// Streams the filtered history as a CSV download for compliance /
// bookkeeping. No pagination; capped at MAX_EXPORT, newest first.
router.get('/export.csv', async (req, res) => {
  try {
    const filters = buildAuditFilters(req.organizationId, req.query)
    if (filters.error) return res.status(400).json({ error: filters.error })
    const { extraSql, params } = filters

    const { rows } = await pool.query(
      `SELECT created_at, user_name, user_email, action, entity_type, entity_id,
              summary, request_method, request_path, status_code, ip_address
         FROM ochr_audit_log
        WHERE organization_id = $1${extraSql}
        ORDER BY created_at DESC, id DESC
        LIMIT $${params.length + 1}`,
      [...params, MAX_EXPORT]
    )

    const header = [
      'timestamp', 'user_name', 'user_email', 'action', 'entity_type',
      'entity_id', 'summary', 'method', 'path', 'status', 'ip_address',
    ]
    const lines = [header.join(',')]
    for (const r of rows) {
      lines.push([
        csvCell(r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at),
        csvCell(r.user_name),
        csvCell(r.user_email),
        csvCell(r.action),
        csvCell(r.entity_type),
        csvCell(r.entity_id),
        csvCell(r.summary),
        csvCell(r.request_method),
        csvCell(r.request_path),
        csvCell(r.status_code),
        csvCell(r.ip_address),
      ].join(','))
    }

    const stamp = new Date().toISOString().slice(0, 10)
    res.set('Content-Type', 'text/csv; charset=utf-8')
    res.set('Content-Disposition', `attachment; filename="audit-log-${stamp}.csv"`)
    res.set('Cache-Control', 'private, no-store')
    res.send(lines.join('\n'))
  } catch (err) {
    monitor.error('audit-log.export', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to export audit log' })
  }
})

export default router
