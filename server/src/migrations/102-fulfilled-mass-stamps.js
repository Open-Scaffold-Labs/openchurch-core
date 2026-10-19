// 102 — DDR-INT-01: stamp Mass date, title, and time at fulfillment.
//
// Once an intention is marked fulfilled, the book, weekly sacristy sheet,
// and Sunday Packet must name the Mass that was offered — not today's
// calendar row. Title and time had no home except the live event;
// mass_date is still the working schedule date for open/scheduled
// (followOpenScheduledToMassDate), so it cannot also be the as-of date.
//
// Three nullable columns. No default. No CHECK that forces them on
// existing fulfilled rows. No fulfilled_at. No backfill — rows already
// fulfilled stay NULL / LEGACY UNKNOWN. Today's calendar is not a
// proven as-of-fulfillment fact.
//
// The sacristy view projects fulfilled rows from the stamps and leaves
// open/scheduled on the live JOIN. Never COALESCE a stamp to the live
// calendar or to mass_date for a fulfilled presentation.
//
// week_date is the listing window only — not the as-offered date.
// Fulfilled rows with a stamp sit in that stamp's week. Fulfilled rows
// whose stamps are NULL (LEGACY UNKNOWN) still belong on the Packet and
// the weekly sheet: place them by the working mi.mass_date, and leave
// mass_date / mass_title / mass_time NULL. UNKNOWN ≠ EMPTY. Do not omit
// them, and do not fill the blanks from today's calendar.

import pool from '../db.js'

export async function up() {
  console.log('Migration 102: fulfilled-mass-stamps — applying...')

  await pool.query(`
    ALTER TABLE ochr_mass_intentions
      ADD COLUMN IF NOT EXISTS fulfilled_mass_date  DATE,
      ADD COLUMN IF NOT EXISTS fulfilled_mass_title TEXT,
      ADD COLUMN IF NOT EXISTS fulfilled_mass_time  TIME
  `)

  const { rows: cols } = await pool.query(`
    SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'ochr_mass_intentions'
       AND column_name IN (
         'fulfilled_mass_date',
         'fulfilled_mass_title',
         'fulfilled_mass_time'
       )
     ORDER BY column_name
  `)
  const byName = Object.fromEntries(cols.map(c => [c.column_name, c]))
  for (const name of ['fulfilled_mass_date', 'fulfilled_mass_title', 'fulfilled_mass_time']) {
    const col = byName[name]
    if (!col) throw new Error(`102: ${name} is missing`)
    if (col.is_nullable !== 'YES') throw new Error(`102: ${name} must be nullable`)
    if (col.column_default != null) throw new Error(`102: ${name} must have no default`)
  }
  if (byName.fulfilled_mass_date.data_type !== 'date') {
    throw new Error('102: fulfilled_mass_date must be DATE')
  }
  if (byName.fulfilled_mass_title.data_type !== 'text') {
    throw new Error('102: fulfilled_mass_title must be TEXT')
  }
  if (byName.fulfilled_mass_time.data_type !== 'time without time zone') {
    throw new Error('102: fulfilled_mass_time must be TIME')
  }

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
      -- Appended: CREATE OR REPLACE VIEW cannot insert a column mid-list.
      CASE
        WHEN mi.status = 'fulfilled' AND mi.fulfilled_mass_date IS NOT NULL
          THEN mi.fulfilled_mass_date
        ELSE mi.mass_date
      END           AS week_date
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
    throw new Error('102: calendar join is missing the tenant predicate')
  }
  if (!/c\.organization_id\s*=\s*mi\.organization_id/.test(def)) {
    throw new Error('102: clients join lost its tenant predicate')
  }
  if (!/fulfilled_mass_title/.test(def) || !/fulfilled_mass_time/.test(def) || !/fulfilled_mass_date/.test(def)) {
    throw new Error('102: view does not project the fulfilled stamps')
  }
  if (!/\bweek_date\b/.test(def)) {
    throw new Error('102: view must expose week_date as the listing window')
  }
  if (/COALESCE\s*\(\s*mi\.fulfilled_mass_/i.test(def) || /COALESCE\s*\(\s*fulfilled_mass_/i.test(def)) {
    throw new Error('102: view must not COALESCE fulfilled stamps to the live calendar')
  }

  console.log('Migration 102: fulfilled-mass-stamps — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
