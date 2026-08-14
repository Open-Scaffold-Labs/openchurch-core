// ochr_telemetry_dashboard (Manual 10) — the founder's Monday-morning
// read. One row per organization, trailing-28-day activity counts, so
// the weekly KPI tracker is a single SELECT instead of hand-run SQL.
//
// A read-only VIEW (not a table, no writers, no cron): the counts are
// cheap at OpenChurch scale and always current. Queried by the founder
// over a direct DB session — it is intentionally NOT exposed through
// any API route.
//
//   recent_register_rows — sacramental records + Mass intentions
//                          created in the window (the moat variable).
//   recent_schedules     — event roster assignments created (breadth
//                          of office adoption beyond the register).
//   recent_feedback      — Inner Circle notes received (engagement).

import pool from '../db.js'

export async function up() {
  console.log('Migration 052: telemetry-dashboard — applying...')

  await pool.query(`
    CREATE OR REPLACE VIEW ochr_telemetry_dashboard AS
    SELECT
      o.id   AS organization_id,
      o.name AS organization,
      (SELECT COUNT(*) FROM ochr_sacramental_records s
        WHERE s.organization_id = o.id
          AND s.created_at > NOW() - INTERVAL '28 days')
      +
      (SELECT COUNT(*) FROM ochr_mass_intentions mi
        WHERE mi.organization_id = o.id
          AND mi.created_at > NOW() - INTERVAL '28 days') AS recent_register_rows,
      (SELECT COUNT(*) FROM ochr_event_members em
        WHERE em.organization_id = o.id
          AND em.created_at > NOW() - INTERVAL '28 days') AS recent_schedules,
      (SELECT COUNT(*) FROM ochr_feedback_ledger f
        WHERE f.organization_id = o.id
          AND f.created_at > NOW() - INTERVAL '28 days') AS recent_feedback
    FROM ochr_organizations o
    ORDER BY o.name
  `)

  console.log('Migration 052: telemetry-dashboard — applied.')
}
