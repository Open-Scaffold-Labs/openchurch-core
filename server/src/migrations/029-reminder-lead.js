// ochr_organizations.reminder_lead_hours
//
// Reminders, RM.3 — how far ahead serving reminders go was hardcoded at
// 24h. Churches want control (morning-of, a day, a couple days), so the
// lead time moves onto the org row. The reminder sync reads it per
// event. Default 24 keeps existing behaviour.

import pool from '../db.js'

export async function up() {
  console.log('Migration 029: reminder-lead — applying...')

  await pool.query(`
    ALTER TABLE ochr_organizations
      ADD COLUMN IF NOT EXISTS reminder_lead_hours INTEGER NOT NULL DEFAULT 24
  `)

  console.log('Migration 029: reminder-lead — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
