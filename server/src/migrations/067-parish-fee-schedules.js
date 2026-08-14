// 067 — Parish fee schedules: the price list nobody calls a price list.
//
// Weddings, funerals, quinceañeras, hall rentals: parishes charge for these,
// but canonically sacraments are never SOLD (CIC c. 947–958 hovers over all
// of this), so the vocabulary is offerings and fees-for-use, pastors waive
// freely, and parishioner pricing is normal. The schema has to make the
// polite version the default, not a hack on top of an invoice engine built
// for merchants.
//
//   ochr_organizations       — gains billing_label (what the UI calls this
//     whole area; default "Offerings & Fees" — never "Billing" in parish-
//     facing copy) and invoice_next_no, the per-org sequential counter.
//     Invoice numbers are assigned at ISSUE time inside a transaction
//     (SELECT ... FOR UPDATE on the org row), same ceremony as certificate
//     numbers in the register: gaps allowed, duplicates never.
//   ochr_fee_schedules       — the catalog. Each item knows its category,
//     its standard amount, an optional parishioner_amount (NULL = same
//     price for everyone), an optional suggested deposit, and — the part
//     the chancery will ask about — where the money GOES: an account_code
//     into the parish chart of accounts and/or a designated fund. A
//     musician stipend is pass_through money owed onward to a person, not
//     parish revenue; the flag keeps it out of the offertory totals and
//     out of the assessable base.
//
// Money is NUMERIC(10,2), consistent with donations. No dunning machinery
// anywhere in this set — "Anxiety is a Defect" applies doubly to a widow
// being invoiced for a funeral.

import pool from '../db.js'

export async function up() {
  console.log('Migration 067: parish-fee-schedules — applying...')

  // Org-level knobs. billing_label is parish-facing vocabulary; the
  // counter backs sequential invoice numbers (route layer increments it
  // under FOR UPDATE at issue time — draft invoices have no number yet).
  await pool.query(`
    ALTER TABLE ochr_organizations
      ADD COLUMN IF NOT EXISTS billing_label   TEXT NOT NULL DEFAULT 'Offerings & Fees',
      ADD COLUMN IF NOT EXISTS invoice_next_no INTEGER NOT NULL DEFAULT 1
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_fee_schedules (
      id                 BIGSERIAL PRIMARY KEY,
      organization_id    INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      name               TEXT NOT NULL,
      description        TEXT,
      category           TEXT NOT NULL DEFAULT 'other'
                           CHECK (category IN (
                             'wedding', 'funeral', 'baptism', 'quinceanera',
                             'facility', 'stipend', 'other'
                           )),
      amount             NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
      parishioner_amount NUMERIC(10,2) CHECK (parishioner_amount IS NULL OR parishioner_amount >= 0),
      deposit_amount     NUMERIC(10,2) CHECK (deposit_amount IS NULL OR deposit_amount >= 0),
      pass_through       BOOLEAN NOT NULL DEFAULT FALSE,
      default_payee      TEXT,
      account_code       TEXT,
      fund_id            BIGINT REFERENCES ochr_funds(id) ON DELETE SET NULL,
      active             BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order         INTEGER NOT NULL DEFAULT 0,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  // The settings page lists by category then sort; invoice composition
  // filters to active items.
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_fee_schedules_org_active
                    ON ochr_fee_schedules(organization_id, active, category, sort_order)`)

  // Composite-FK target so invoice lines can prove the fee item belongs to
  // the same org (same posture as 044/061).
  await pool.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ochr_fee_schedules_id_org_uniq') THEN
      ALTER TABLE ochr_fee_schedules ADD CONSTRAINT ochr_fee_schedules_id_org_uniq UNIQUE (id, organization_id);
    END IF;
  END $$;`)

  // RLS enabled with no policy — the same blanket backstop every ochr_*
  // table carries; tenancy is enforced in the route layer.
  await pool.query(`ALTER TABLE ochr_fee_schedules ENABLE ROW LEVEL SECURITY`)

  console.log('Migration 067: parish-fee-schedules — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
