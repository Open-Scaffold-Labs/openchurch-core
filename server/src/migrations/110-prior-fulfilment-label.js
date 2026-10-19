// 110 — label a non-fulfilled intention that still carries a fulfilment stamp.
//
// Reopening an intention leaves fulfilled_mass_* in place. The book, the
// weekly sheet, and the Sunday Packet must not call that row fulfilled.
// The label is a view column only. No table change, no backfill, no
// rewrite of existing rows.
//
// CREATE OR REPLACE VIEW can only append. week_date stays where 102 put it.

import pool from '../db.js'

const PRIOR_LABEL = 'previously recorded fulfilment'

export async function up() {
  console.log('Migration 110: prior-fulfilment-label — applying...')

  await pool.query(`
    CREATE OR REPLACE VIEW ochr_sacristy_weekly_manifest AS
    SELECT
      mi.id,
      mi.organization_id,
      CASE
        WHEN mi.status = 'fulfilled' THEN mi.fulfilled_mass_date
        ELSE mi.mass_date
      END           AS mass_date,
      CASE
        WHEN mi.status = 'fulfilled' THEN mi.fulfilled_mass_title
        ELSE ce.title
      END           AS mass_title,
      CASE
        WHEN mi.status = 'fulfilled' THEN mi.fulfilled_mass_time
        ELSE ce.start_time
      END           AS mass_time,
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
      mi.calendar_event_id,
      CASE
        WHEN mi.status = 'fulfilled' AND mi.fulfilled_mass_date IS NOT NULL
          THEN mi.fulfilled_mass_date
        ELSE mi.mass_date
      END           AS week_date,
      CASE
        WHEN mi.status IS DISTINCT FROM 'fulfilled'
         AND (mi.fulfilled_mass_date IS NOT NULL
           OR mi.fulfilled_mass_title IS NOT NULL
           OR mi.fulfilled_mass_time IS NOT NULL)
        THEN '${PRIOR_LABEL}'
        ELSE NULL
      END           AS fulfilment_label
    FROM ochr_mass_intentions mi
    LEFT JOIN ochr_calendar_events ce
           ON ce.id = mi.calendar_event_id
          AND ce.organization_id = mi.organization_id
    LEFT JOIN ochr_clients c
           ON c.id = mi.requested_by_client_id
          AND c.organization_id = mi.organization_id
    WHERE mi.status <> 'cancelled'
      AND CASE
            WHEN mi.status = 'fulfilled' AND mi.fulfilled_mass_date IS NOT NULL
              THEN mi.fulfilled_mass_date
            ELSE mi.mass_date
          END IS NOT NULL
  `)

  const { rows } = await pool.query(
    `SELECT pg_get_viewdef('ochr_sacristy_weekly_manifest', true) AS def`
  )
  const def = rows[0]?.def || ''
  if (!/ce\.organization_id\s*=\s*mi\.organization_id/.test(def)) {
    throw new Error('110: calendar join is missing the tenant predicate')
  }
  if (!/c\.organization_id\s*=\s*mi\.organization_id/.test(def)) {
    throw new Error('110: clients join lost its tenant predicate')
  }
  if (!/fulfilled_mass_title/.test(def) || !/fulfilled_mass_time/.test(def) || !/fulfilled_mass_date/.test(def)) {
    throw new Error('110: view dropped the fulfilled stamps')
  }
  if (!/\bweek_date\b/.test(def)) {
    throw new Error('110: view dropped week_date')
  }
  if (!def.includes(PRIOR_LABEL) || !/\bfulfilment_label\b/.test(def)) {
    throw new Error('110: view does not label a prior fulfilment')
  }
  if (/COALESCE\s*\(\s*mi\.fulfilled_mass_/i.test(def) || /COALESCE\s*\(\s*fulfilled_mass_/i.test(def)) {
    throw new Error('110: view must not COALESCE fulfilled stamps to the live calendar')
  }

  console.log('Migration 110: prior-fulfilment-label — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
