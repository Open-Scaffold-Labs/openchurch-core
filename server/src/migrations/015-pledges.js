// Donation pledges (Sprint D). A pledge is a member's (or non-member
// donor's) stated commitment to give X dollars at Y frequency over a
// period. Pledge fulfillment is computed on the fly by aggregating
// matching donations during the period — we don't store the rolling
// total, since donations land continuously and any stored value would
// drift out of sync.
//
// Match key: pledge.member_id → ochr_clients.email when present,
// else pledge.donor_email directly. Mirrors the giving-statements
// matching strategy from Sprint Y so a donor's pledge + statement
// stay consistent.
//
// CHECK constraint: at least one of member_id or donor_email must
// be present. Both are allowed when a donor IS a member AND a
// canonical email is on file (gives the admin redundancy if they
// later edit the member's email).
//
// frequency: 'weekly' | 'monthly' | 'yearly' | 'one_time'
//   The annualized total is amount × frequency_multiplier, computed
//   in the route layer for query simplicity (no GENERATED column —
//   the multiplier is product policy, not data shape).

import pool from '../db.js'

export async function up() {
  console.log('Migration 015: pledges — applying...')

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_pledges (
      id              SERIAL PRIMARY KEY,
      organization_id INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      member_id       INTEGER REFERENCES ochr_clients(id) ON DELETE SET NULL,
      donor_email     TEXT,
      amount          NUMERIC(10,2) NOT NULL CHECK (amount > 0),
      frequency       TEXT NOT NULL CHECK (frequency IN ('weekly','monthly','yearly','one_time')),
      start_date      DATE NOT NULL DEFAULT CURRENT_DATE,
      end_date        DATE,
      notes           TEXT,
      status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','cancelled')),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (member_id IS NOT NULL OR donor_email IS NOT NULL),
      CHECK (end_date IS NULL OR end_date >= start_date)
    )
  `)

  // Hot path: list active pledges for an org. Covered by composite
  // (organization_id, status). Sort-by-start-date listing is fine
  // with this — the table is small per tenant.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ochr_pledges_org_status
      ON ochr_pledges (organization_id, status)
  `)

  // Member lookup — Member profile page (Sprint D / D.3) queries
  // "active pledges for this member" on every render.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ochr_pledges_member
      ON ochr_pledges (member_id)
      WHERE member_id IS NOT NULL
  `)

  console.log('Migration 015: pledges — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
