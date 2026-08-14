// Attendance tracking (Sprint T). One row per (event, member) marking.
// Statuses: 'present' | 'absent' | 'excused'. The triplet captures
// the common church reality where a member RSVP'd but couldn't make
// it — and where the pastor wants to differentiate excused from
// no-show for future scheduling.
//
// Why a separate table over JSONB on ochr_events:
//   - Marks change incrementally during a service; row-level UPDATEs
//     are cheaper than JSONB rewrites
//   - Queryable for analytics (T.3 Insights cut: avg attendance per
//     event, trend by month)
//   - Audit log naturally tracks per-mark mutations
//
// Unique constraint on (event_id, member_id) so we get UPSERT
// semantics — clicking 'Present' then 'Absent' on the same member
// replaces rather than stacks.

import pool from '../db.js'

export async function up() {
  console.log('Migration 014: attendance — applying...')

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_attendance (
      id          SERIAL PRIMARY KEY,
      event_id    INTEGER NOT NULL REFERENCES ochr_events(id)  ON DELETE CASCADE,
      member_id   INTEGER NOT NULL REFERENCES ochr_clients(id) ON DELETE CASCADE,
      status      TEXT NOT NULL CHECK (status IN ('present', 'absent', 'excused')),
      marked_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      marked_by   INTEGER REFERENCES ochr_users(id) ON DELETE SET NULL,
      UNIQUE (event_id, member_id)
    )
  `)

  // Hot paths the Insights queries (T.3) hit: "events with attendance
  // in window" and "attendance for an event". Compound index covers
  // both.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ochr_attendance_event
      ON ochr_attendance (event_id, status)
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ochr_attendance_marked_at
      ON ochr_attendance (marked_at)
  `)

  console.log('Migration 014: attendance — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
