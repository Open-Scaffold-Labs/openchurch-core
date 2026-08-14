// ochr_groups + ochr_group_members
//
// Anchor 4 / A4.1 — Groups. Flat model: each group has a name, a
// category enum, an optional description, an optional designated
// leader (ochr_clients.id), and a member roster stored as rows in
// ochr_group_members.
//
// Design notes:
//   - leader_client_id is nullable + ON DELETE SET NULL: a leader
//     leaving the church shouldn't nuke the group; admins reassign.
//   - ochr_group_members.UNIQUE (group_id, client_id) prevents dup
//     memberships at the schema level so the route doesn't have to
//     race-check.
//   - category is a CHECK constraint rather than an enum so adding
//     a new bucket later is a constraint replace, not a type
//     migration.
//   - A4.3 will add a nullable group_id column to ochr_calendar_events;
//     not in this migration so backend CRUD can ship on its own.

import pool from '../db.js'

export async function up() {
  console.log('Migration 021: groups — applying...')

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_groups (
      id                BIGSERIAL PRIMARY KEY,
      organization_id   INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      name              TEXT NOT NULL,
      category          TEXT NOT NULL DEFAULT 'ministry'
                          CHECK (category IN ('ministry', 'life_group', 'small_group', 'committee')),
      description       TEXT,
      leader_client_id  INTEGER REFERENCES ochr_clients(id) ON DELETE SET NULL,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_group_members (
      id          BIGSERIAL PRIMARY KEY,
      group_id    BIGINT  NOT NULL REFERENCES ochr_groups(id)  ON DELETE CASCADE,
      client_id   INTEGER NOT NULL REFERENCES ochr_clients(id) ON DELETE CASCADE,
      joined_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (group_id, client_id)
    )
  `)

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_groups_org           ON ochr_groups(organization_id)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_group_members_group  ON ochr_group_members(group_id)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_group_members_client ON ochr_group_members(client_id)`)

  console.log('Migration 021: groups — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
