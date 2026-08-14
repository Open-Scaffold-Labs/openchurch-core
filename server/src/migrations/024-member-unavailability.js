// ochr_member_unavailability
//
// Volunteer-scheduling depth, VS.4a — blackout / unavailability dates
// for members. A row is an inclusive date RANGE a member can't serve
// (a single day is start_date = end_date; a vacation is a multi-day
// span). The rotation auto-fill reads these to skip/substitute people
// who are away, and (VS.4b) the EventModal warns when an assignee is
// blacked out on the event's date.
//
// Design notes:
//   - client_id ON DELETE CASCADE: removing a member clears their
//     blackout rows too — they're meaningless without the member.
//   - CHECK (end_date >= start_date) so a range can't invert at the
//     schema level; the route doesn't have to re-validate ordering.
//   - reason is optional free text ("Vacation", "Surgery") — shown to
//     the admin, never required.
//   - Indexed by (organization_id, client_id) for the per-member
//     editor and by (client_id, start_date, end_date) for the
//     date-overlap lookups the auto-fill does.

import pool from '../db.js'

export async function up() {
  console.log('Migration 024: member-unavailability — applying...')

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_member_unavailability (
      id               BIGSERIAL PRIMARY KEY,
      organization_id  INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      client_id        INTEGER NOT NULL REFERENCES ochr_clients(id)       ON DELETE CASCADE,
      start_date       DATE NOT NULL,
      end_date         DATE NOT NULL,
      reason           TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (end_date >= start_date)
    )
  `)

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_unavail_org_client ON ochr_member_unavailability(organization_id, client_id)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_unavail_client_span ON ochr_member_unavailability(client_id, start_date, end_date)`)

  console.log('Migration 024: member-unavailability — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
