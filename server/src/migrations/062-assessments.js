// 062 — Assessments (DIO.4): the cathedraticum, computed instead of argued.
//
// The point of the whole financial core: once parishes report against a
// standard chart of accounts and the chancery approves their periods,
// the diocesan assessment stops being a spreadsheet argument and becomes
// arithmetic — rate × the assessable base already frozen in approved
// submissions.
//
//   ochr_assessments       — one row per (diocese, fiscal year): the rate
//     in BASIS POINTS (850 = 8.5%) and a draft → published → closed
//     lifecycle. Bases recompute freely while draft; publishing freezes
//     the year's lines as the authoritative bill.
//   ochr_assessment_lines  — one row per parish: its assessable base,
//     its rate (per-parish override allowed — hardship reductions are
//     normal diocesan practice), the assessed amount, and manual payment
//     tracking (paid / status). Real invoicing waits on the billing-
//     provider posture, same as parish billing.
//
// Money is NUMERIC(12,2); the basis is the SUM of totals_json→totals→
// assessable_base across the parish's APPROVED submissions whose period
// falls inside the fiscal (calendar) year.

import pool from '../db.js'

export async function up() {
  console.log('Migration 062: assessments — applying...')

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_assessments (
      id              BIGSERIAL PRIMARY KEY,
      diocese_org_id  INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      fiscal_year     TEXT NOT NULL CHECK (fiscal_year ~ '^[0-9]{4}$'),
      rate_bps        INTEGER NOT NULL CHECK (rate_bps >= 0 AND rate_bps <= 3000),
      basis           TEXT NOT NULL DEFAULT 'assessable_revenue',
      status          TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'published', 'closed')),
      notes           TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (diocese_org_id, fiscal_year)
    )
  `)
  await pool.query(`ALTER TABLE ochr_assessments ENABLE ROW LEVEL SECURITY`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_assessment_lines (
      id              BIGSERIAL PRIMARY KEY,
      assessment_id   BIGINT NOT NULL REFERENCES ochr_assessments(id) ON DELETE CASCADE,
      parish_org_id   INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      base            NUMERIC(12,2) NOT NULL DEFAULT 0,
      rate_bps        INTEGER NOT NULL CHECK (rate_bps >= 0 AND rate_bps <= 3000),
      assessed        NUMERIC(12,2) NOT NULL DEFAULT 0,
      paid            NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (paid >= 0),
      status          TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'partial', 'paid', 'waived')),
      note            TEXT,
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (assessment_id, parish_org_id)
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_assessment_lines_parish ON ochr_assessment_lines(parish_org_id)`)
  await pool.query(`ALTER TABLE ochr_assessment_lines ENABLE ROW LEVEL SECURITY`)

  console.log('Migration 062: assessments — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
