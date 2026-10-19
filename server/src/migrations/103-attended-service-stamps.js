// 103 — DDR-CHK-04: stamp service date, title, and time at check-in write.
//
// A check-in is a record that a person was at a named service at a named
// date and time. Those facts are copied from the org-scoped Mass at INSERT.
// A later rename, move, or time change must not rewrite them.
// calendar_event_id stays the live link to today's tile — it is not the
// historical identity of the service as attended.
//
// Three nullable columns. No default. No CHECK that forces them on
// existing rows. No backfill — rows already written stay NULL /
// LEGACY UNKNOWN. Today's calendar is not a proven as-attended fact.
//
// Never COALESCE a stamp to the live calendar. NULL means unknown, not
// "follow calendar_event_id to ce.title".

import pool from '../db.js'

export async function up() {
  console.log('Migration 103: attended-service-stamps — applying...')

  await pool.query(`
    ALTER TABLE ochr_checkins
      ADD COLUMN IF NOT EXISTS attended_date  DATE,
      ADD COLUMN IF NOT EXISTS attended_title TEXT,
      ADD COLUMN IF NOT EXISTS attended_time  TIME
  `)

  const { rows: cols } = await pool.query(`
    SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'ochr_checkins'
       AND column_name IN (
         'attended_date',
         'attended_title',
         'attended_time'
       )
     ORDER BY column_name
  `)
  const byName = Object.fromEntries(cols.map(c => [c.column_name, c]))
  for (const name of ['attended_date', 'attended_title', 'attended_time']) {
    const col = byName[name]
    if (!col) throw new Error(`103: ${name} is missing`)
    if (col.is_nullable !== 'YES') throw new Error(`103: ${name} must be nullable`)
    if (col.column_default != null) throw new Error(`103: ${name} must have no default`)
  }
  if (byName.attended_date.data_type !== 'date') {
    throw new Error('103: attended_date must be DATE')
  }
  if (byName.attended_title.data_type !== 'text') {
    throw new Error('103: attended_title must be TEXT')
  }
  if (byName.attended_time.data_type !== 'time without time zone') {
    throw new Error('103: attended_time must be TIME')
  }

  console.log('Migration 103: attended-service-stamps — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
