// ochr_checkins
//
// Check-in foundation (CHK.1 / Sprint 4). Records a person checking in
// to a Schedule event (service, class, kids' ministry). A check-in is
// either a known member (client_id) or a walk-in/child captured by name
// only. person_name is always denormalized so the kiosk list renders
// without a join and survives a member rename.
//
//   kind          — 'member' | 'guest' | 'child'.
//   guardian_name — for child check-in (who dropped them off / picks up).
//   checked_out_at — set on check-out; NULL = still checked in.
//
// Tied to ochr_calendar_events (CASCADE) — deleting the event clears its
// check-ins. client_id SET NULL so a removed member leaves the historical
// count intact.

import pool from '../db.js'

export async function up() {
  console.log('Migration 034: checkins — applying...')

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_checkins (
      id                 BIGSERIAL PRIMARY KEY,
      organization_id    INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      calendar_event_id  INTEGER NOT NULL REFERENCES ochr_calendar_events(id) ON DELETE CASCADE,
      client_id          INTEGER REFERENCES ochr_clients(id) ON DELETE SET NULL,
      person_name        TEXT NOT NULL,
      kind               TEXT NOT NULL DEFAULT 'member'
                           CHECK (kind IN ('member', 'guest', 'child')),
      guardian_name      TEXT,
      checked_in_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      checked_out_at     TIMESTAMPTZ,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_checkins_event ON ochr_checkins(calendar_event_id)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_checkins_org ON ochr_checkins(organization_id)`)

  console.log('Migration 034: checkins — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
