// Year-end giving statements (Sprint Y). Adds the data needed to
// generate a US-501(c)(3) compliant donation receipt for every donor
// who gave in a calendar year — without forcing donations to link to
// a member row.
//
// Two surfaces get new columns:
//
// 1. ochr_donations gains donor_email and donor_address. Email is the
//    grouping key for the statement aggregation (donor_name falls
//    back when email is unknown — older rows, walk-in cash gifts).
//    Address is needed on the printed statement so the church can
//    mail receipts to donors who prefer paper.
//
// 2. ochr_organizations gains the letterhead fields admins set ONCE
//    and reuse on every statement:
//      - address           street+city+state+zip block
//      - tax_id            EIN (XX-XXXXXXX) — required by the IRS
//                          for the receipt to be a valid deduction
//      - signatory_name    e.g. "Pastor Jane Doe"
//      - signatory_title   e.g. "Senior Pastor" / "Treasurer"
//      - statement_letterhead  free-text override the admin can use
//                          to paste a custom preamble (denomination
//                          line, fiscal sponsor info, IRS warning
//                          language overrides, etc.). Optional.
//
// All ADD COLUMN IF NOT EXISTS so re-running this migration on a
// dev DB is safe. No NOT NULL constraints — older orgs that haven't
// filled in the letterhead yet still have working donations; the
// printed statement just shows placeholder text where a field is
// missing.
//
// Indexes:
//   - idx_ochr_donations_donor_email_year — speeds the aggregation
//     query in /api/giving-statements/preview. Covers
//     (organization_id, EXTRACT(YEAR FROM date), donor_email).
//     Partial-indexed WHERE donor_email IS NOT NULL since we group
//     by email when present and by donor_name otherwise.

import pool from '../db.js'

export async function up() {
  console.log('Migration 012: giving-statements — applying...')

  // ── ochr_donations: donor contact ─────────────────────────
  await pool.query(`
    ALTER TABLE ochr_donations
      ADD COLUMN IF NOT EXISTS donor_email   TEXT,
      ADD COLUMN IF NOT EXISTS donor_address TEXT
  `)

  // Partial index — only donors with a known email are grouped by
  // email. Donors without one fall back to (donor_name) grouping in
  // the query, which is a separate index path.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ochr_donations_donor_email
      ON ochr_donations (organization_id, donor_email)
      WHERE donor_email IS NOT NULL
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ochr_donations_donor_name_date
      ON ochr_donations (organization_id, donor_name, date)
  `)

  // ── ochr_organizations: letterhead ────────────────────────
  await pool.query(`
    ALTER TABLE ochr_organizations
      ADD COLUMN IF NOT EXISTS address              TEXT,
      ADD COLUMN IF NOT EXISTS tax_id               TEXT,
      ADD COLUMN IF NOT EXISTS signatory_name       TEXT,
      ADD COLUMN IF NOT EXISTS signatory_title      TEXT,
      ADD COLUMN IF NOT EXISTS statement_letterhead TEXT
  `)

  console.log('Migration 012: giving-statements — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
