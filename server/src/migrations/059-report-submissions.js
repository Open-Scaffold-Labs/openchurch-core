// 059 — Period report submissions (DIO.2): the workflow dioceses actually
// run, and the data the roll-up reads.
//
// A parish closes a period → its ledger totals are computed once and
// FROZEN into totals_json → the chancery approves (or returns with a
// note). The diocese roll-up reads ONLY approved submissions, so
// consolidated numbers can never shift retroactively under the
// chancery's feet — later edits to the parish ledger simply don't exist
// diocese-side until a new period is submitted.
//
//   totals_json = {
//     groups:   [{ acct_type, rollup_group, assessable, total }],
//     accounts: [{ code, name, acct_type, assessable, total }],
//     totals:   { revenue, expense, net, assessable_base }
//   }
//
// Grant levels resolve at read time from the affiliation: 'summary'
// exposes groups + totals; 'detail' additionally exposes accounts.
// Freezing both shapes at submit time means a later grant change never
// requires recomputation.
//
// One row per (parish, diocese, period); a returned submission is
// resubmitted in place (totals recomputed, status back to 'submitted'),
// keeping the period's history at exactly one authoritative row.

import pool from '../db.js'

export async function up() {
  console.log('Migration 059: report-submissions — applying...')

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_report_submissions (
      id               BIGSERIAL PRIMARY KEY,
      organization_id  INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      diocese_org_id   INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      period_start     DATE NOT NULL,
      period_end       DATE NOT NULL,
      status           TEXT NOT NULL DEFAULT 'submitted'
                         CHECK (status IN ('submitted', 'approved', 'returned')),
      totals_json      JSONB NOT NULL,
      submitted_by     INTEGER REFERENCES ochr_users(id) ON DELETE SET NULL,
      submitted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reviewed_by      INTEGER REFERENCES ochr_users(id) ON DELETE SET NULL,
      reviewed_at      TIMESTAMPTZ,
      review_note      TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (period_end >= period_start),
      UNIQUE (organization_id, diocese_org_id, period_start, period_end)
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_submissions_diocese_status ON ochr_report_submissions(diocese_org_id, status, period_end DESC)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_submissions_parish ON ochr_report_submissions(organization_id, period_end DESC)`)
  await pool.query(`ALTER TABLE ochr_report_submissions ENABLE ROW LEVEL SECURITY`)

  console.log('Migration 059: report-submissions — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
