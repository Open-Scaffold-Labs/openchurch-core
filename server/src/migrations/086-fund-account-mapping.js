// 086 — a gift's FUND decides its account, not a typed category string.
//
// THE BUG THIS FIXES, precisely.
//
// `ochr_parish_ledger` resolves a donation's account like this today:
//
//     ochr_coa_mappings WHERE source_type = 'donation_category'
//                         AND source_key  = d.category          ← free text
//     …falling back to 4420 'Gifts & Donations (Unrestricted)'
//
// `d.fund_id` — a real foreign key to a real fund the parish set up and
// designates gifts to — is not consulted at all. So a parish that creates
// a "Roof Repair" fund, marks nothing else, and records fifty gifts to it
// gets fifty rows in **4420, which is assessable**.
//
// That is an assessment computed on restricted capital giving. It errs
// UPWARD, silently, on exactly the money every diocesan formula excludes:
// the Diocese of Maine's Qualifying Normal Operating Income leaves out
// restricted gifts and capital campaign proceeds by name. A parish would
// be billed on money it is not allowed to spend on operations, and
// nothing in the interface would explain why the number looked high.
//
// WHY THE FIX IS NOT A FLAG ON ochr_funds.
//
// The obvious move — `ochr_funds.assessable` — is wrong, and
// finance/effectiveCoa.js says why in its own header: assessability is
// deliberately the DIOCESE's to set, because otherwise "a parish could
// shrink its own assessment by unticking `assessable`, and the chancery
// would never see it." A parish-owned boolean that reduces the assessable
// base is precisely the lever that file exists to withhold.
//
// So the split stays where it was:
//   · the parish chooses which FUND a gift belongs to — legitimately its
//     own business, and a thing it already does
//   · the diocese decides whether that fund's ACCOUNT is assessable
//
// This migration only connects the two. It adds 'fund' as a mapping
// source, and teaches the ledger to prefer it.
//
// Nothing moves on its own. With no fund mappings recorded, every
// donation resolves exactly as it does today — the fallback chain is
// unchanged behind the new first step. A parish's numbers change when
// somebody maps a fund, and not before.

import pool from '../db.js'
import { EFFECTIVE_COA } from '../finance/effectiveCoa.js'

// A restricted-giving account to map those funds TO. The standard chart
// already carries non-assessable revenue lines (bequests, pass-through
// second collections, investment, rental) — it was simply missing the one
// that a restricted parish fund most obviously belongs in.
const RESTRICTED_GIFTS = ['4450', 'Gifts & Donations (Restricted)', 'revenue', 'Gifts & Donations', false, 185]

export async function up() {
  console.log('Migration 086: fund → account mapping — applying...')

  // 1 · allow 'fund' as a mapping source.
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'ochr_coa_mappings_source_type_check') THEN
        ALTER TABLE ochr_coa_mappings DROP CONSTRAINT ochr_coa_mappings_source_type_check;
      END IF;
      ALTER TABLE ochr_coa_mappings
        ADD CONSTRAINT ochr_coa_mappings_source_type_check
        CHECK (source_type IN ('donation_category', 'payroll', 'fund'));
    END $$;
  `)

  // 2 · the destination account, in the shared template.
  const [code, name, type, group, assessable, sort] = RESTRICTED_GIFTS
  await pool.query(
    `INSERT INTO ochr_coa_accounts (organization_id, code, name, acct_type, rollup_group, assessable, sort_order)
     VALUES (NULL, $1, $2, $3, $4, $5, $6)
     ON CONFLICT (code) WHERE organization_id IS NULL DO NOTHING`,
    [code, name, type, group, assessable, sort]
  )

  // 3 · the ledger prefers the fund.
  //
  // Resolution order for a donation, most specific first:
  //   fund mapping → category mapping → 4420
  //
  // The fund mapping is keyed on the fund's id as text, not its name: a
  // parish renaming "Roof Repair" to "Roof & Tower" must not silently
  // change which account its gifts land in, and therefore must not
  // silently change its own assessment.
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

  console.log('Migration 086: fund → account mapping — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
