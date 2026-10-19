// 101 — HT-VIEW-01: tenant-scope the calendar join on the sacristy
// weekly manifest. Defense-in-depth only — not a proven exploit.
//
// 047 and 056 LEFT JOIN ochr_calendar_events on event id alone. The
// clients join on the same view already carries
// `c.organization_id = mi.organization_id`. The book SELECT in
// massIntentions.js already joins the calendar the same way. The
// composite tenant FK from 071 already makes a cross-org
// calendar_event_id unstorable on ochr_mass_intentions. This view
// still omitted the predicate, so a future FK weakening or a
// hand-written query reading the view would be the first place the
// Mass title/time of another parish could appear on a printed sheet.
//
// CREATE OR REPLACE VIEW keeps the 056 column order exactly.
// No new columns. No backfill. No claim that anyone has crossed
// tenants through this join.

import pool from '../db.js'

export async function up() {
  console.log('Migration 101: manifest-calendar-tenant — applying...')

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
      mi.note,
      mi.calendar_event_id
    FROM ochr_mass_intentions mi
    LEFT JOIN ochr_calendar_events ce
           ON ce.id = mi.calendar_event_id
          AND ce.organization_id = mi.organization_id
    LEFT JOIN ochr_clients c
           ON c.id = mi.requested_by_client_id
          AND c.organization_id = mi.organization_id
    WHERE mi.mass_date IS NOT NULL
      AND mi.status <> 'cancelled'
  `)

  const { rows } = await pool.query(
    `SELECT pg_get_viewdef('ochr_sacristy_weekly_manifest', true) AS def`
  )
  const def = rows[0]?.def || ''
  if (!/ce\.organization_id\s*=\s*mi\.organization_id/.test(def)) {
    throw new Error('101: calendar join is missing the tenant predicate')
  }
  if (!/c\.organization_id\s*=\s*mi\.organization_id/.test(def)) {
    throw new Error('101: clients join lost its tenant predicate')
  }

  console.log('Migration 101: manifest-calendar-tenant — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
