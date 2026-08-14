// ochr_sacristy_weekly_manifest (MI.2) — read-optimized view backing the
// weekly sacristy list: "which intentions are being offered at which
// Masses this week", shaped for direct printing.
//
// A VIEW, not a table: the manifest is always a projection of the
// intention book + calendar — materializing it would just invent a
// cache-invalidation problem at parish scale.
//
//   formatted_intention — the traditional register formatting, applied
//     once here so every consumer (API, print sheet, future exports)
//     agrees: a leading "+" (the parish shorthand for a deceased
//     person) renders as "† Name".
//   mass_title/mass_time — from the linked calendar event when the
//     intention has been scheduled onto a Mass; null otherwise.
//
// Tenancy: the view carries organization_id through; consumers MUST
// filter on it (same route-layer scoping rule as the base tables).
// Cancelled intentions never appear; fulfilled ones stay visible so a
// reprint after the fact still shows the full week.

import pool from '../db.js'

export async function up() {
  console.log('Migration 047: sacristy-manifest — applying...')

  await pool.query(`
    CREATE OR REPLACE VIEW ochr_sacristy_weekly_manifest AS
    SELECT
      mi.id,
      mi.organization_id,
      mi.mass_date,
      ce.title      AS mass_title,
      ce.start_time AS mass_time,
      CASE
        WHEN mi.intention ~ '^\\s*\\+'
          THEN '† ' || regexp_replace(mi.intention, '^\\s*\\+\\s*', '')
        ELSE mi.intention
      END           AS formatted_intention,
      mi.intention,
      mi.requested_by,
      c.name        AS requester_name,
      mi.stipend,
      mi.status,
      mi.note
    FROM ochr_mass_intentions mi
    LEFT JOIN ochr_calendar_events ce
           ON ce.id = mi.calendar_event_id
    LEFT JOIN ochr_clients c
           ON c.id = mi.requested_by_client_id
          AND c.organization_id = mi.organization_id
    WHERE mi.mass_date IS NOT NULL
      AND mi.status <> 'cancelled'
  `)

  console.log('Migration 047: sacristy-manifest — applied.')
}
