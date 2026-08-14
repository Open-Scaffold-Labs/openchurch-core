// ochr_group_interests
//
// Connect card, CC.1 — a parishioner on the public church page expresses
// interest in a ministry/group. The submission is NOT an auto-add: it
// lands as a `pending` interest an admin reviews and approves (approval
// links or creates the member and adds them to the group). Public,
// unauthenticated writes go through here, so verification stays human.
//
// Design notes:
//   - group_id nullable + ON DELETE SET NULL: a "general interest" with
//     no specific group is allowed, and deleting a group doesn't erase
//     the interest history.
//   - client_id (nullable) is stamped on approval — the member the
//     interest resolved to (existing match or freshly created). ON
//     DELETE SET NULL so removing the member keeps the audit row.
//   - status is a CHECK, not an enum, so adding a state later is a
//     constraint swap rather than a type migration.
//   - Indexed by (organization_id, status) for the admin queue, which
//     reads pending rows for one org.

import pool from '../db.js'

export async function up() {
  console.log('Migration 025: group-interests — applying...')

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_group_interests (
      id               BIGSERIAL PRIMARY KEY,
      organization_id  INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      group_id         BIGINT  REFERENCES ochr_groups(id)  ON DELETE SET NULL,
      name             TEXT NOT NULL,
      email            TEXT,
      phone            TEXT,
      message          TEXT,
      status           TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'approved', 'declined')),
      client_id        INTEGER REFERENCES ochr_clients(id) ON DELETE SET NULL,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      decided_at       TIMESTAMPTZ
    )
  `)

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_group_interests_org_status ON ochr_group_interests(organization_id, status)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_group_interests_group ON ochr_group_interests(group_id)`)

  console.log('Migration 025: group-interests — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
