// 057 — Finance ledger foundation (FIN.1): chart of accounts, mappings,
// manual/imported entries, and the parish ledger projection.
//
// This is Sprint A of the OpenDiocese blueprint, built parish-first: every
// parish gets uniform finance reporting against a standard chart of
// accounts today; the diocese roll-up (Sprint B+) will read the same
// shapes later.
//
// Design decisions:
//
//   • The ledger is a PROJECTION, not a second book. Donations and payroll
//     are already recorded elsewhere in the app; re-posting them into a
//     ledger table would mean hooking five separate write sites (manual
//     donations ×2, Stripe webhook, recurring gifts, kiosk giving) and
//     accepting drift/double-post risk at each. Instead the
//     ochr_parish_ledger VIEW derives those rows at read time through
//     ochr_coa_mappings, and the ochr_ledger_entries TABLE holds only what
//     has no other home: manual entries and trial-balance imports. Same
//     philosophy as the sacristy manifest (047).
//
//   • Chart of accounts: rows with organization_id NULL are the OpenChurch
//     standard template (modeled on USCCB Diocesan Financial Management
//     norms / typical diocesan parish CoAs — 4-digit codes, 1xxx assets,
//     2xxx liabilities, 3xxx net assets, 4xxx revenue, 5xxx expense). An
//     org row with the same code SHADOWS the template row for that org
//     (rename, retire, re-flag assessable). Dioceses will later publish
//     their own template set the same way.
//
//   • `assessable` marks revenue that typically counts toward a diocesan
//     assessment base (offertory, fees, unrestricted gifts, grants);
//     pass-through second collections and bequests default to exempt.
//     Per-diocese variation is expected — that's what shadowing is for.
//
//   • Money is NUMERIC(12,2) — same family as the app's NUMERIC(10,2)
//     donations, sized up because ledger lines include annual imports.

import pool from '../db.js'

// code, name, type, rollup_group, assessable, sort
const STANDARD_COA = [
  // ── Assets ─────────────────────────────────────────────
  ['1110', 'Cash — Operating',                    'asset',     'Cash & Bank',        false, 10],
  ['1120', 'Cash — Savings & Reserves',           'asset',     'Cash & Bank',        false, 20],
  ['1210', 'Accounts Receivable',                 'asset',     'Receivables',        false, 30],
  ['1510', 'Investments',                         'asset',     'Investments',        false, 40],
  // ── Liabilities ────────────────────────────────────────
  ['2110', 'Accounts Payable',                    'liability', 'Payables',           false, 50],
  ['2210', 'Deferred Revenue',                    'liability', 'Deferred',           false, 60],
  ['2510', 'Loans Payable',                       'liability', 'Debt',               false, 70],
  // ── Net assets ─────────────────────────────────────────
  ['3110', 'Net Assets — Unrestricted',           'net_asset', 'Net Assets',         false, 80],
  ['3120', 'Net Assets — Restricted',             'net_asset', 'Net Assets',         false, 90],
  // ── Revenue ────────────────────────────────────────────
  ['4110', 'Offertory — Sunday Collections',      'revenue',   'Offertory',          true, 100],
  ['4120', 'Offertory — Holy Days',               'revenue',   'Offertory',          true, 110],
  ['4130', 'Christmas & Easter Collections',      'revenue',   'Offertory',          true, 120],
  ['4210', 'Sacramental Offerings & Stipends',    'revenue',   'Sacramental',        true, 130],
  ['4220', 'Sacramental Fees',                    'revenue',   'Sacramental',        true, 140],
  ['4310', 'Religious Education Fees',            'revenue',   'Programs',           true, 150],
  ['4320', 'Program & Activity Income',           'revenue',   'Programs',           true, 160],
  ['4410', 'Fundraising Income',                  'revenue',   'Fundraising',        true, 170],
  ['4420', 'Gifts & Donations (Unrestricted)',    'revenue',   'Gifts & Donations',  true, 180],
  ['4430', 'Bequests & Memorials',                'revenue',   'Gifts & Donations',  false, 190],
  ['4440', 'Grants',                              'revenue',   'Gifts & Donations',  true, 200],
  ['4510', 'Second Collections (Pass-through)',   'revenue',   'Pass-through',       false, 210],
  ['4610', 'Investment & Interest Income',        'revenue',   'Investment',         false, 220],
  ['4710', 'Rental & Facility Use Income',        'revenue',   'Other Revenue',      false, 230],
  ['4910', 'Other Income',                        'revenue',   'Other Revenue',      false, 240],
  // ── Expenses ───────────────────────────────────────────
  ['5110', 'Clergy Salaries & Benefits',          'expense',   'Personnel',          false, 250],
  ['5120', 'Lay Staff Salaries & Wages',          'expense',   'Personnel',          false, 260],
  ['5130', 'Payroll Taxes & Benefits',            'expense',   'Personnel',          false, 270],
  ['5210', 'Office & Administration',             'expense',   'Administration',     false, 280],
  ['5220', 'Technology & Communications',         'expense',   'Administration',     false, 290],
  ['5310', 'Liturgy & Worship Supplies',          'expense',   'Ministry',           false, 300],
  ['5320', 'Religious Education & Formation',     'expense',   'Ministry',           false, 310],
  ['5330', 'Charity & Outreach',                  'expense',   'Ministry',           false, 320],
  ['5410', 'Buildings & Grounds Maintenance',     'expense',   'Facilities',         false, 330],
  ['5420', 'Utilities',                           'expense',   'Facilities',         false, 340],
  ['5430', 'Insurance',                           'expense',   'Facilities',         false, 350],
  ['5510', 'Diocesan Assessment',                 'expense',   'Diocesan',           false, 360],
  ['5520', 'Second Collections Remitted',         'expense',   'Pass-through',       false, 370],
  ['5910', 'Fundraising Expense',                 'expense',   'Fundraising',        false, 380],
  ['5990', 'Other Expense',                       'expense',   'Other Expense',      false, 390],
]

// Where unmapped derived money lands: donations without a category
// mapping read as unrestricted gifts; payroll reads as lay wages.
export const DEFAULT_DONATION_CODE = '4420'
export const DEFAULT_PAYROLL_CODE  = '5120'

export async function up() {
  console.log('Migration 057: finance-ledger — applying...')

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_coa_accounts (
      id               BIGSERIAL PRIMARY KEY,
      organization_id  INTEGER REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      code             TEXT NOT NULL,
      name             TEXT NOT NULL,
      acct_type        TEXT NOT NULL
                         CHECK (acct_type IN ('asset', 'liability', 'net_asset', 'revenue', 'expense')),
      rollup_group     TEXT NOT NULL,
      assessable       BOOLEAN NOT NULL DEFAULT false,
      sort_order       INTEGER NOT NULL DEFAULT 0,
      active           BOOLEAN NOT NULL DEFAULT true,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  // Template rows (organization_id NULL) are unique on code; org shadow
  // rows are unique per org. Two partial indexes because NULLs are
  // distinct under a plain UNIQUE constraint.
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_coa_template_code ON ochr_coa_accounts(code) WHERE organization_id IS NULL`)
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_coa_org_code      ON ochr_coa_accounts(organization_id, code) WHERE organization_id IS NOT NULL`)
  await pool.query(`ALTER TABLE ochr_coa_accounts ENABLE ROW LEVEL SECURITY`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_coa_mappings (
      id               BIGSERIAL PRIMARY KEY,
      organization_id  INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      source_type      TEXT NOT NULL CHECK (source_type IN ('donation_category', 'payroll')),
      source_key       TEXT NOT NULL,
      account_code     TEXT NOT NULL,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (organization_id, source_type, source_key)
    )
  `)
  await pool.query(`ALTER TABLE ochr_coa_mappings ENABLE ROW LEVEL SECURITY`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_ledger_entries (
      id               BIGSERIAL PRIMARY KEY,
      organization_id  INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      entry_date       DATE NOT NULL,
      account_code     TEXT NOT NULL,
      amount           NUMERIC(12,2) NOT NULL,
      memo             TEXT,
      source_type      TEXT NOT NULL DEFAULT 'manual'
                         CHECK (source_type IN ('manual', 'import')),
      import_batch     UUID,
      created_by       INTEGER REFERENCES ochr_users(id) ON DELETE SET NULL,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ledger_org_date ON ochr_ledger_entries(organization_id, entry_date)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ledger_org_code ON ochr_ledger_entries(organization_id, account_code)`)
  await pool.query(`ALTER TABLE ochr_ledger_entries ENABLE ROW LEVEL SECURITY`)

  // The parish ledger — one uniform money stream per org. Donation and
  // payroll rows are derived through the org's mappings at read time;
  // manual/import rows come from the table. Consumers MUST filter on
  // organization_id (route-layer tenancy, as everywhere).
  await pool.query(`
    CREATE OR REPLACE VIEW ochr_parish_ledger AS
    SELECT
      le.organization_id,
      le.entry_date,
      le.account_code,
      le.amount,
      le.source_type,
      le.id            AS source_id,
      le.memo
    FROM ochr_ledger_entries le

    UNION ALL

    SELECT
      d.organization_id,
      d.date::date                                   AS entry_date,
      COALESCE(m.account_code, '${DEFAULT_DONATION_CODE}') AS account_code,
      d.amount                                       AS amount,
      'donation'                                     AS source_type,
      d.id                                           AS source_id,
      COALESCE(NULLIF(TRIM(d.category), ''), 'Uncategorized') AS memo
    FROM ochr_donations d
    LEFT JOIN ochr_coa_mappings m
           ON m.organization_id = d.organization_id
          AND m.source_type = 'donation_category'
          AND m.source_key = COALESCE(NULLIF(TRIM(d.category), ''), 'Uncategorized')

    UNION ALL

    SELECT
      s.organization_id,
      sh.date::date                                  AS entry_date,
      COALESCE(m.account_code, '${DEFAULT_PAYROLL_CODE}') AS account_code,
      (sh.hours * s.pay_rate)::NUMERIC(12,2)         AS amount,
      'payroll'                                      AS source_type,
      sh.id                                          AS source_id,
      s.name                                         AS memo
    FROM ochr_payroll_shifts sh
    JOIN ochr_payroll_staff s ON s.id = sh.staff_id
    LEFT JOIN ochr_coa_mappings m
           ON m.organization_id = s.organization_id
          AND m.source_type = 'payroll'
          AND m.source_key = 'wages'
  `)

  // Seed the standard template (idempotent per-code via the partial index).
  for (const [code, name, type, group, assessable, sort] of STANDARD_COA) {
    await pool.query(
      `INSERT INTO ochr_coa_accounts (organization_id, code, name, acct_type, rollup_group, assessable, sort_order)
       VALUES (NULL, $1, $2, $3, $4, $5, $6)
       ON CONFLICT (code) WHERE organization_id IS NULL DO NOTHING`,
      [code, name, type, group, assessable, sort]
    )
  }

  console.log('Migration 057: finance-ledger — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
