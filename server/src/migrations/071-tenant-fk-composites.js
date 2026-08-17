// 071 — Composite tenant foreign keys: make a cross-tenant reference
// impossible rather than merely unlikely.
//
// WHAT THIS IS
//
// Every OpenChurch table carries organization_id and every query filters
// on it. That is the real protection and it works. This is the second
// lock: a foreign key that carries organization_id alongside the id, so
// the DATABASE refuses a row in org A that points at a row in org B —
// even if a future route forgets its validator. 044 did this for the
// join tables, 061 for pledges after the leak, 067–069 for billing.
// A 2026-08-16 audit (scripts/tenant-fk-audit.mjs) found 49 references
// still single-column. This closes 44 of them.
//
// WHY ON DELETE SET NULL IS WRITTEN THE WAY IT IS — READ BEFORE EDITING
//
// 34 of these are ON DELETE SET NULL. Plain `SET NULL` on a
// COMPOSITE key nulls EVERY column in the key — which would include
// organization_id, silently detaching a live row from its parish the
// moment an unrelated record was deleted. That is far worse than the
// weak FK we are replacing.
//
// PostgreSQL 15 added column-scoped `ON DELETE SET NULL (col)`. Every
// SET NULL below names ONLY its own reference column, so organization_id
// is never touched. The version guard exists because on PG14 this syntax
// is a parse error, and a half-applied security migration is the worst
// outcome available.
//
// WHAT THIS DELIBERATELY DOES NOT TOUCH
//
// 4 references have no organization_id on the CHILD, and that is
// correct rather than missing:
//   ochr_payroll_shifts → ochr_payroll_staff
//   ochr_password_reset_tokens → ochr_users
//   ochr_notification_prefs → ochr_users
//   ochr_diocese_affiliations → ochr_users
//
// Password-reset tokens are a pre-auth credential with no org context by
// design; notification prefs and payroll shifts inherit their tenant
// through the parent row; a diocese affiliation spans two organizations
// as its entire purpose. Adding organization_id to any of them would be
// denormalisation, not safety. The audit script classifies these
// separately so they never read as an outstanding gap.
//
// A fifth is excluded for a different and more interesting reason:
//
//   ochr_report_submissions.reviewed_by → ochr_users
//
// The row belongs to the PARISH; the reviewer is a user in the DIOCESE.
// That cross-organization reference is the entire point of the chancery
// review workflow (diocese.js sets reviewed_by = the chancery user on
// the parish's submission), so a composite FK would forbid the feature
// rather than protect it. Caught by DIO.2 going 500 on approval when a
// first draft of this migration hardened it. `submitted_by` on the same
// table IS hardened — that one is always the parish's own user.
//
// The lesson worth keeping: "child and parent must share a tenant" holds
// for every reference in this system EXCEPT the ones the diocese model
// deliberately spans. Before hardening a reference, check who writes it.
//
// SAFETY
//
// Refuses to run if any existing row already crosses tenants — that is a
// data-integrity finding a human must see, not something a migration
// quietly repairs. Idempotent: re-running is a no-op.

import pool from '../db.js'

// Pinned from pg_constraint rather than discovered at run time. A
// migration that computes its own DDL is not reviewable, and this is a
// security change. `del`: 'c' = CASCADE, 'n' = SET NULL (col only).
const GAPS = [
  { child: 'ochr_ai_usage', col: 'user_id', parent: 'ochr_users', ref: 'id', del: 'n', old: 'ochr_ai_usage_user_id_fkey' },
  { child: 'ochr_assistant_messages', col: 'user_id', parent: 'ochr_users', ref: 'id', del: 'n', old: 'ochr_assistant_messages_user_id_fkey' },
  { child: 'ochr_attendance', col: 'marked_by', parent: 'ochr_users', ref: 'id', del: 'n', old: 'ochr_attendance_marked_by_fkey' },
  { child: 'ochr_audit_log', col: 'user_id', parent: 'ochr_users', ref: 'id', del: 'n', old: 'ochr_audit_log_user_id_fkey' },
  { child: 'ochr_calendar_events', col: 'group_id', parent: 'ochr_groups', ref: 'id', del: 'n', old: 'ochr_calendar_events_group_id_fkey' },
  { child: 'ochr_calendar_events', col: 'recurrence_parent_id', parent: 'ochr_calendar_events', ref: 'id', del: 'c', old: 'ochr_calendar_events_recurrence_parent_id_fkey' },
  { child: 'ochr_cash_count_sessions', col: 'donation_id', parent: 'ochr_donations', ref: 'id', del: 'n', old: 'ochr_cash_count_sessions_donation_id_fkey' },
  { child: 'ochr_checkins', col: 'calendar_event_id', parent: 'ochr_calendar_events', ref: 'id', del: 'c', old: 'ochr_checkins_calendar_event_id_fkey' },
  { child: 'ochr_checkins', col: 'client_id', parent: 'ochr_clients', ref: 'id', del: 'n', old: 'ochr_checkins_client_id_fkey' },
  { child: 'ochr_checkins', col: 'room_id', parent: 'ochr_rooms', ref: 'id', del: 'n', old: 'ochr_checkins_room_id_fkey' },
  { child: 'ochr_checklist_runs', col: 'template_id', parent: 'ochr_checklist_templates', ref: 'id', del: 'c', old: 'ochr_checklist_runs_template_id_fkey' },
  { child: 'ochr_donations', col: 'fund_id', parent: 'ochr_funds', ref: 'id', del: 'n', old: 'ochr_donations_fund_id_fkey' },
  { child: 'ochr_fee_schedules', col: 'fund_id', parent: 'ochr_funds', ref: 'id', del: 'n', old: 'ochr_fee_schedules_fund_id_fkey' },
  { child: 'ochr_feedback_ledger', col: 'user_id', parent: 'ochr_users', ref: 'id', del: 'n', old: 'ochr_feedback_ledger_user_id_fkey' },
  { child: 'ochr_form_responses', col: 'form_id', parent: 'ochr_forms', ref: 'id', del: 'c', old: 'ochr_form_responses_form_id_fkey' },
  { child: 'ochr_forms', col: 'created_by', parent: 'ochr_users', ref: 'id', del: 'n', old: 'ochr_forms_created_by_fkey' },
  { child: 'ochr_group_interests', col: 'client_id', parent: 'ochr_clients', ref: 'id', del: 'n', old: 'ochr_group_interests_client_id_fkey' },
  { child: 'ochr_group_interests', col: 'group_id', parent: 'ochr_groups', ref: 'id', del: 'n', old: 'ochr_group_interests_group_id_fkey' },
  { child: 'ochr_groups', col: 'leader_client_id', parent: 'ochr_clients', ref: 'id', del: 'n', old: 'ochr_groups_leader_client_id_fkey' },
  { child: 'ochr_invoice_lines', col: 'fund_id', parent: 'ochr_funds', ref: 'id', del: 'n', old: 'ochr_invoice_lines_fund_id_fkey' },
  { child: 'ochr_invoice_payments', col: 'received_by', parent: 'ochr_users', ref: 'id', del: 'n', old: 'ochr_invoice_payments_received_by_fkey' },
  { child: 'ochr_invoices', col: 'created_by', parent: 'ochr_users', ref: 'id', del: 'n', old: 'ochr_invoices_created_by_fkey' },
  { child: 'ochr_invoices', col: 'waived_by', parent: 'ochr_users', ref: 'id', del: 'n', old: 'ochr_invoices_waived_by_fkey' },
  { child: 'ochr_ledger_entries', col: 'created_by', parent: 'ochr_users', ref: 'id', del: 'n', old: 'ochr_ledger_entries_created_by_fkey' },
  { child: 'ochr_mass_intentions', col: 'calendar_event_id', parent: 'ochr_calendar_events', ref: 'id', del: 'n', old: 'ochr_mass_intentions_calendar_event_id_fkey' },
  { child: 'ochr_mass_intentions', col: 'requested_by_client_id', parent: 'ochr_clients', ref: 'id', del: 'n', old: 'ochr_mass_intentions_requested_by_client_id_fkey' },
  { child: 'ochr_member_unavailability', col: 'client_id', parent: 'ochr_clients', ref: 'id', del: 'c', old: 'ochr_member_unavailability_client_id_fkey' },
  { child: 'ochr_notification_log', col: 'user_id', parent: 'ochr_users', ref: 'id', del: 'n', old: 'ochr_notification_log_user_id_fkey' },
  { child: 'ochr_notifications', col: 'member_id', parent: 'ochr_clients', ref: 'id', del: 'c', old: 'ochr_notifications_member_id_fkey' },
  { child: 'ochr_push_subscriptions', col: 'user_id', parent: 'ochr_users', ref: 'id', del: 'c', old: 'ochr_push_subscriptions_user_id_fkey' },
  { child: 'ochr_recurring_gifts', col: 'fund_id', parent: 'ochr_funds', ref: 'id', del: 'n', old: 'ochr_recurring_gifts_fund_id_fkey' },
  { child: 'ochr_report_submissions', col: 'submitted_by', parent: 'ochr_users', ref: 'id', del: 'n', old: 'ochr_report_submissions_submitted_by_fkey' },
  { child: 'ochr_sacramental_drafts', col: 'committed_record_id', parent: 'ochr_sacramental_records', ref: 'id', del: 'n', old: 'ochr_sacramental_drafts_committed_record_id_fkey' },
  { child: 'ochr_sacramental_drafts', col: 'created_by', parent: 'ochr_users', ref: 'id', del: 'n', old: 'ochr_sacramental_drafts_created_by_fkey' },
  { child: 'ochr_sacramental_records', col: 'client_id', parent: 'ochr_clients', ref: 'id', del: 'n', old: 'ochr_sacramental_records_client_id_fkey' },
  { child: 'ochr_scheduled_notifications', col: 'user_id', parent: 'ochr_users', ref: 'id', del: 'n', old: 'ochr_scheduled_notifications_user_id_fkey' },
  { child: 'ochr_service_elements', col: 'assigned_client_id', parent: 'ochr_clients', ref: 'id', del: 'n', old: 'ochr_service_elements_assigned_client_id_fkey' },
  { child: 'ochr_service_elements', col: 'plan_id', parent: 'ochr_service_plans', ref: 'id', del: 'c', old: 'ochr_service_elements_plan_id_fkey' },
  { child: 'ochr_service_plans', col: 'calendar_event_id', parent: 'ochr_calendar_events', ref: 'id', del: 'n', old: 'ochr_service_plans_calendar_event_id_fkey' },
  { child: 'ochr_support_tickets', col: 'user_id', parent: 'ochr_users', ref: 'id', del: 'n', old: 'ochr_support_tickets_user_id_fkey' },
  { child: 'ochr_swap_requests', col: 'calendar_event_id', parent: 'ochr_calendar_events', ref: 'id', del: 'c', old: 'ochr_swap_requests_calendar_event_id_fkey' },
  { child: 'ochr_swap_requests', col: 'requester_client_id', parent: 'ochr_clients', ref: 'id', del: 'c', old: 'ochr_swap_requests_requester_client_id_fkey' },
  { child: 'ochr_swap_requests', col: 'target_client_id', parent: 'ochr_clients', ref: 'id', del: 'c', old: 'ochr_swap_requests_target_client_id_fkey' },
  { child: 'ochr_tasks', col: 'assigned_member_id', parent: 'ochr_clients', ref: 'id', del: 'n', old: 'ochr_tasks_assigned_member_id_fkey' },
]

// Parents needing UNIQUE (id, organization_id) before they can be the
// target of a composite FK. Some already have it from 044/067–069; the
// guard below makes that a no-op.
const PARENTS = [
  'ochr_calendar_events',
  'ochr_checklist_templates',
  'ochr_clients',
  'ochr_donations',
  'ochr_forms',
  'ochr_funds',
  'ochr_groups',
  'ochr_rooms',
  'ochr_sacramental_records',
  'ochr_service_plans',
  'ochr_users',
]

export async function up() {
  console.log('Migration 071: tenant-fk-composites — applying...')

  const { rows: [{ v }] } = await pool.query(
    "SELECT current_setting('server_version_num')::int AS v"
  )
  if (v < 150000) {
    throw new Error(
      `Migration 071 needs PostgreSQL 15+ for column-scoped ON DELETE SET NULL ` +
      `(server is ${v}). Without it, SET NULL would also null organization_id ` +
      `and detach rows from their parish. Refusing to apply.`
    )
  }

  // 1. Contamination scan. Report everything, then refuse — a partial
  //    picture invites a partial fix.
  const contaminated = []
  for (const g of GAPS) {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n
         FROM ${g.child} c
         JOIN ${g.parent} p ON p.${g.ref} = c.${g.col}
        WHERE c.organization_id IS DISTINCT FROM p.organization_id`
    )
    if (rows[0].n > 0) contaminated.push(`${g.child}.${g.col} → ${g.parent}: ${rows[0].n} row(s)`)
  }
  if (contaminated.length) {
    throw new Error(
      'Migration 071 found cross-tenant references already in the data:\n  ' +
      contaminated.join('\n  ') +
      '\n\nThese must be reviewed by a human before the constraints can be added. ' +
      'Repointing or nulling another parish\'s data is a founder decision, not a migration\'s.'
    )
  }

  // 2. Composite-unique on every parent (no-op where 044/067–069 got there first).
  for (const parent of PARENTS) {
    const name = `${parent}_id_org_uniq`
    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') THEN
          ALTER TABLE ${parent} ADD CONSTRAINT ${name} UNIQUE (id, organization_id);
        END IF;
      END $$;
    `)
  }

  // 3. Swap each single-column FK for its composite equivalent.
  let swapped = 0
  for (const g of GAPS) {
    const name = `${g.child}_${g.col}_org_fkey`
    const { rows: exists } = await pool.query(
      'SELECT 1 FROM pg_constraint WHERE conname = $1', [name]
    )
    if (exists.length) continue

    const onDelete = g.del === 'c'
      ? 'ON DELETE CASCADE'
      : `ON DELETE SET NULL (${g.col})`

    await pool.query(`ALTER TABLE ${g.child} DROP CONSTRAINT IF EXISTS ${g.old}`)
    await pool.query(`
      ALTER TABLE ${g.child}
        ADD CONSTRAINT ${name}
        FOREIGN KEY (${g.col}, organization_id)
        REFERENCES ${g.parent}(${g.ref}, organization_id)
        ${onDelete}
    `)
    swapped++
  }

  console.log(`Migration 071: tenant-fk-composites — applied (${swapped} reference(s) hardened).`)
}
