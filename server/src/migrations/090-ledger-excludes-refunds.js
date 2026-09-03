// 090 — the parish ledger view must not count refunded gifts.
//
// The donation branch of ochr_parish_ledger (086) selected every row in
// ochr_donations with no predicate on payment_status. That view is not a
// reporting convenience: it feeds finance/periodTotals.js, which computes
// assessable_base, which is frozen into ochr_report_submissions.totals_json,
// which routes/assessments.js sums to produce what a diocese bills a parish.
//
// So a refunded gift did not merely show up on a screen. It raised the
// parish's assessment, and once the report is submitted and approved the
// totals are frozen — correcting the donation afterward does not correct the
// bill. Measured 23 Aug on a live parish:
//
//     assessable revenue     $22,465.99
//     after a $1,000 gift    $23,465.99   (+1,000.00)
//     after refunding it     $23,465.99   (    0.00)   <- not reversed
//
// This is a CREATE OR REPLACE of the whole view because Postgres will not let
// you alter one branch of a UNION. Everything except the added predicate is
// copied verbatim from 086; if that view changes again, this file is the one
// that has to be regenerated, not 086.
//
// Idempotent: CREATE OR REPLACE VIEW, safe to re-run.

import pool from '../db.js'

export async function up() {
  console.log('Migration 090: ledger excludes refunds — applying...')

  await pool.query(`
    CREATE OR REPLACE VIEW ochr_parish_ledger AS
    SELECT
      le.organization_id, le.entry_date, le.account_code, le.amount,
      le.source_type, le.id AS source_id, le.memo
    FROM ochr_ledger_entries le

    UNION ALL

    SELECT
      d.organization_id,
      d.date::date AS entry_date,
      COALESCE(fm.account_code, cm.account_code, '4420') AS account_code,
      d.amount AS amount,
      'donation' AS source_type,
      d.id AS source_id,
      COALESCE(NULLIF(TRIM(d.category), ''), 'Uncategorized') AS memo
    FROM ochr_donations d
    LEFT JOIN ochr_coa_mappings fm
           ON fm.organization_id = d.organization_id
          AND fm.source_type = 'fund'
          AND d.fund_id IS NOT NULL
          AND fm.source_key = d.fund_id::text
    LEFT JOIN ochr_coa_mappings cm
           ON cm.organization_id = d.organization_id
          AND cm.source_type = 'donation_category'
          AND cm.source_key = COALESCE(NULLIF(TRIM(d.category), ''), 'Uncategorized')
    -- The one line this migration exists for.
    WHERE d.payment_status IS DISTINCT FROM 'refunded'

    UNION ALL

    SELECT
      s.organization_id,
      sh.date::date AS entry_date,
      COALESCE(m.account_code, '5120') AS account_code,
      (sh.hours * s.pay_rate)::NUMERIC(12,2) AS amount,
      'payroll' AS source_type,
      sh.id AS source_id,
      s.name AS memo
    FROM ochr_payroll_shifts sh
    JOIN ochr_payroll_staff s ON s.id = sh.staff_id
    LEFT JOIN ochr_coa_mappings m
           ON m.organization_id = s.organization_id
          AND m.source_type = 'payroll'
          AND m.source_key = 'wages'
  `)

  // Prove the predicate actually landed rather than trusting that the
  // statement ran. A view whose text silently reverted would otherwise be
  // reported as applied.
  const { rows } = await pool.query(
    `SELECT pg_get_viewdef('ochr_parish_ledger', true) AS def`)
  if (!/payment_status IS DISTINCT FROM 'refunded'/.test(rows[0].def)) {
    throw new Error('090: the refund predicate is not in the installed view')
  }

  console.log('Migration 090: ledger excludes refunds — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
