// 058 — Diocese tenancy + affiliation (DIO.1): the umbrella layer.
//
// A diocese is just another organization (org_type = 'diocese') — same
// auth, users, roles, and billing as a parish, zero parallel systems.
// The ONLY bridge between a diocese and a parish is an affiliation row,
// created by a diocese invitation and activated by an explicit parish
// acceptance that names its grant level:
//
//   summary — the diocese sees period-level financial summaries only
//   detail  — the diocese may drill into account-level lines
//
// Tenant isolation stays the default everywhere; nothing in this
// migration gives a diocese implicit access to anything. The read
// surfaces that honor grant levels arrive with the roll-up (Sprint C).
//
//   status: invited → active (parish accepts) → suspended/ended
//           invited → ended (parish declines)
//   invited_email — the parish-admin email the invite targeted, kept
//     for the audit trail even after acceptance.

import pool from '../db.js'

export async function up() {
  console.log('Migration 058: diocese-affiliations — applying...')

  await pool.query(`
    ALTER TABLE ochr_organizations
      ADD COLUMN IF NOT EXISTS org_type TEXT NOT NULL DEFAULT 'parish'
  `)
  // CHECK constraint via DO block — Postgres has no ADD CONSTRAINT IF
  // NOT EXISTS (same pattern as migration 003).
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ochr_organizations_org_type_check'
      ) THEN
        ALTER TABLE ochr_organizations
          ADD CONSTRAINT ochr_organizations_org_type_check
          CHECK (org_type IN ('parish', 'diocese'));
      END IF;
    END $$
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_diocese_affiliations (
      id              BIGSERIAL PRIMARY KEY,
      diocese_org_id  INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      parish_org_id   INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      status          TEXT NOT NULL DEFAULT 'invited'
                        CHECK (status IN ('invited', 'active', 'suspended', 'ended')),
      grant_level     TEXT NOT NULL DEFAULT 'summary'
                        CHECK (grant_level IN ('summary', 'detail')),
      invited_email   TEXT,
      accepted_by     INTEGER REFERENCES ochr_users(id) ON DELETE SET NULL,
      accepted_at     TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (diocese_org_id <> parish_org_id),
      UNIQUE (diocese_org_id, parish_org_id)
    )
  `)
  // A parish belongs to at most one diocese at a time (counting invites,
  // so two dioceses can't race an invitation to the same parish).
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_affiliation_one_live_diocese
      ON ochr_diocese_affiliations(parish_org_id)
      WHERE status IN ('invited', 'active', 'suspended')
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_affiliations_diocese ON ochr_diocese_affiliations(diocese_org_id, status)`)
  await pool.query(`ALTER TABLE ochr_diocese_affiliations ENABLE ROW LEVEL SECURITY`)

  console.log('Migration 058: diocese-affiliations — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
