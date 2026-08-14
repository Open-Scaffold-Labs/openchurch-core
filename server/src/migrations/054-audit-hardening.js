// Audit hardening (Master Engineering Audit, H2 + H8).
//
// 1. H2 — the permanent register must survive member deletion WITH the
//    person's identity. client_id is ON DELETE SET NULL (correct — the
//    record stays in the parish's books), but without a name snapshot a
//    deleted member's baptism became a record of nobody. Same pattern
//    as ochr_checkins.person_name and ochr_audit_log.user_name:
//    stamp the name at write time, backfill from the current join.
//
// 2. H8 — index debt. Postgres does not auto-index FK columns, so
//    every member/user/event delete was doing sequential scans across
//    the biggest child tables under strong locks. Plus the one missing
//    hot-path composite: ochr_events(organization_id, date), which the
//    events list sorts on every page load (033 covered donations and
//    calendar_events but missed the legacy events table).
//
// All statements are IF NOT EXISTS — idempotent, safe to re-run. At
// current data sizes these index builds are instant; the standing rule
// for LARGE production tables (CREATE INDEX CONCURRENTLY, outside a
// transaction) is recorded in OPERATOR.md and applies from here on.

import pool from '../db.js'

export async function up() {
  console.log('Migration 054: audit-hardening — applying...')

  // ── H2: register identity snapshot ─────────────────────────────
  await pool.query(`
    ALTER TABLE ochr_sacramental_records
      ADD COLUMN IF NOT EXISTS member_name TEXT
  `)
  // Backfill from members that still exist; rows already orphaned
  // (client_id IS NULL) are beyond recovery and stay NULL — honest.
  await pool.query(`
    UPDATE ochr_sacramental_records r
       SET member_name = c.name
      FROM ochr_clients c
     WHERE r.member_name IS NULL
       AND r.client_id = c.id
       AND c.organization_id = r.organization_id
  `)

  // ── H8: FK indexes (delete-path scans) ─────────────────────────
  const FK_INDEXES = [
    ['idx_ochr_attendance_member',            'ochr_attendance(member_id)'],
    ['idx_ochr_notifications_member',         'ochr_notifications(member_id)'],
    ['idx_ochr_swap_requests_requester',      'ochr_swap_requests(requester_client_id)'],
    ['idx_ochr_checkins_client',              'ochr_checkins(client_id)'],
    ['idx_ochr_checkins_room',                'ochr_checkins(room_id)'],
    ['idx_ochr_mass_intentions_requester',    'ochr_mass_intentions(requested_by_client_id)'],
    ['idx_ochr_mass_intentions_event',        'ochr_mass_intentions(calendar_event_id)'],
    ['idx_ochr_service_plans_event',          'ochr_service_plans(calendar_event_id)'],
    ['idx_ochr_service_elements_assignee',    'ochr_service_elements(assigned_client_id)'],
    ['idx_ochr_donations_fund',               'ochr_donations(fund_id)'],
    ['idx_ochr_recurring_gifts_fund',         'ochr_recurring_gifts(fund_id)'],
    ['idx_ochr_tasks_assigned_member',        'ochr_tasks(assigned_member_id)'],
    ['idx_ochr_group_interests_client',       'ochr_group_interests(client_id)'],
    ['idx_ochr_sacramental_drafts_committed', 'ochr_sacramental_drafts(committed_record_id)'],
    ['idx_ochr_audit_log_user',               'ochr_audit_log(user_id)'],
    ['idx_ochr_ai_usage_user',                'ochr_ai_usage(user_id)'],
    ['idx_ochr_scheduled_notifications_user', 'ochr_scheduled_notifications(user_id)'],
  ]
  for (const [name, def] of FK_INDEXES) {
    // Guard per index: a table that predates a rename (or an install
    // that never created an optional table) shouldn't fail the batch.
    try {
      await pool.query(`CREATE INDEX IF NOT EXISTS ${name} ON ${def}`)
    } catch (err) {
      console.warn(`Migration 054: skipped ${name} (${err.message})`)
    }
  }

  // ── H8: the missing hot-path composite ─────────────────────────
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ochr_events_org_date
      ON ochr_events(organization_id, date)
  `)

  console.log('Migration 054: audit-hardening — applied.')
}
