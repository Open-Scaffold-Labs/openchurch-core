// 056 — carry calendar_event_id through the sacristy manifest view (MI.3).
//
// The Mass-intention ↔ calendar tie-in needs the schedule to know WHICH
// event an intention is offered at, not just its date. CREATE OR REPLACE
// VIEW permits appending columns at the end of the select list, so the
// existing column order from 047 is preserved exactly and
// calendar_event_id is added last.
//
// Everything else (formatting, tenancy note, cancelled-row exclusion)
// is unchanged from 047 — see that file for the reasoning.

import pool from '../db.js'

export async function up() {
  console.log('Migration 056: manifest-event-id — applying...')

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
    LEFT JOIN ochr_clients c
           ON c.id = mi.requested_by_client_id
          AND c.organization_id = mi.organization_id
    WHERE mi.mass_date IS NOT NULL
      AND mi.status <> 'cancelled'
  `)

  console.log('Migration 056: manifest-event-id — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
