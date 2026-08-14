#!/usr/bin/env node
// Tenancy tripwire — static scan of every SQL query in src/routes/**.
//
// The invariant it guards: any query touching an org-scoped table must
// visibly involve organization_id. This is a TRIPWIRE, not a proof —
// dynamic WHERE-builders keep organization_id in nearby code rather
// than in the template literal, so a query passes if organization_id
// appears in the SQL itself OR within a few lines around it. What this
// reliably catches is the classic 11pm mistake: a brand-new query on a
// tenant table with no org scoping anywhere in sight.
//
// Escape hatch (rare, must be justified): put a SQL comment containing
//   tenancy: <reason>
// inside the query. Today's only legitimate uses are the founder
// workbench (cross-parish by design) and global reference tables.
//
// Runs in CI with no database. Exit 1 on any violation.

import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROUTES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'routes')

// Org-scoped tables as of migration 064 — regenerate with:
//   SELECT DISTINCT table_name FROM information_schema.columns
//    WHERE table_schema='public' AND column_name='organization_id'
//      AND table_name LIKE 'ochr\_%' ESCAPE '\';
const ORG_TABLES = [
  'ochr_ai_generations', 'ochr_ai_usage', 'ochr_attendance', 'ochr_audit_log',
  'ochr_bulletins', 'ochr_calendar_events', 'ochr_cash_count_sessions',
  'ochr_checkins', 'ochr_checklist_runs', 'ochr_checklist_templates',
  'ochr_clients', 'ochr_coa_accounts', 'ochr_coa_mappings', 'ochr_donations',
  'ochr_event_members', 'ochr_events', 'ochr_feedback_ledger',
  'ochr_form_responses', 'ochr_forms', 'ochr_funds', 'ochr_group_interests',
  'ochr_group_members', 'ochr_groups', 'ochr_ledger_entries',
  'ochr_mass_intentions', 'ochr_member_unavailability', 'ochr_notification_log',
  'ochr_notifications', 'ochr_parish_feasts', 'ochr_parish_ledger',
  'ochr_payroll_staff', 'ochr_pledges', 'ochr_push_subscriptions',
  'ochr_recurring_gifts', 'ochr_report_submissions', 'ochr_rooms',
  'ochr_sacramental_drafts', 'ochr_sacramental_records',
  'ochr_sacristy_weekly_manifest', 'ochr_schedule',
  'ochr_scheduled_notifications', 'ochr_service_elements',
  'ochr_service_plans', 'ochr_swap_requests', 'ochr_tasks',
  'ochr_telemetry_dashboard', 'ochr_translations', 'ochr_users',
]
const TABLE_RE = new RegExp(`\\b(${ORG_TABLES.join('|')})\\b`)

// How many source lines around the query may carry the org scoping
// (dynamic WHERE-array builders, params pushed just above, etc.).
const CONTEXT_LINES = 30

const files = readdirSync(ROUTES_DIR).filter(f => f.endsWith('.js'))
const violations = []
let scanned = 0

for (const file of files) {
  const text = readFileSync(join(ROUTES_DIR, file), 'utf8')
  const lines = text.split('\n')

  // Find every template literal that follows a query( call. Handles
  // pool.query(`...`) and client.query(`...`) across lines.
  const re = /\.query\(\s*`([^`]*)`/gs
  let m
  while ((m = re.exec(text)) !== null) {
    const sql = m[1]
    if (!TABLE_RE.test(sql)) continue
    scanned++

    if (/organization_id/i.test(sql)) continue          // scoped in the SQL itself
    if (/tenancy:/i.test(sql)) continue                 // explicit, justified escape

    const lineNo = text.slice(0, m.index).split('\n').length
    const lo = Math.max(0, lineNo - 1 - CONTEXT_LINES)
    const hi = Math.min(lines.length, lineNo - 1 + CONTEXT_LINES)
    const context = lines.slice(lo, hi).join('\n')
    if (/organization_id|organizationId/.test(context)) continue // scoped nearby

    violations.push({
      file,
      line: lineNo,
      table: TABLE_RE.exec(sql)?.[1],
      snippet: sql.trim().replace(/\s+/g, ' ').slice(0, 110),
    })
  }
}

if (violations.length) {
  console.error(`\nTENANCY AUDIT FAILED — ${violations.length} unscoped quer${violations.length === 1 ? 'y' : 'ies'} on org tables:\n`)
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [${v.table}]`)
    console.error(`    ${v.snippet}\n`)
  }
  console.error(`Scope it with organization_id, or — only if cross-tenant is truly intended —`)
  console.error(`add a SQL comment: /* tenancy: <reason> */ inside the query.\n`)
  process.exit(1)
}

console.log(`tenancy audit: ${scanned} org-table queries across ${files.length} route files — all scoped.`)
