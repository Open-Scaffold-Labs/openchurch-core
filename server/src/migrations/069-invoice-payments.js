// 069 — Invoice payments: deposits, balances, and the absence of dunning.
//
// One row per money-in event against an invoice. The deposit on a wedding
// booked next June is just a payment with is_deposit = TRUE received months
// before the balance; nothing special-cased, and the event drawer can show
// "deposit received, balance due" from a two-row sum.
//
// Reconciliation posture mirrors donations: method + optional provider
// payment_ref (Stripe today via the existing platform account; when the
// Stripe Connect posture lands and parishes collect into their own
// accounts, the ref format changes but this table does not). Refunds are
// recorded in place (refunded_at / refund_ref) rather than as negative
// rows, same convention as 030 chose for donations.
//
// amount_paid on the invoice is DENORMALIZED and recomputed by the route
// layer inside the same transaction as any payment insert/refund — the
// same single-writer discipline the assessment lines use for paid totals.
// Status transitions live in the route layer too: issued → partially_paid
// → paid as sums cross thresholds; never automatically to anything that
// nags a person.

import pool from '../db.js'

async function addConstraintIfMissing(name, ddl) {
  await pool.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') THEN
      ${ddl};
    END IF;
  END $$;`)
}

export async function up() {
  console.log('Migration 069: invoice-payments — applying...')

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_invoice_payments (
      id               BIGSERIAL PRIMARY KEY,
      organization_id  INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      invoice_id       BIGINT NOT NULL,
      amount           NUMERIC(10,2) NOT NULL CHECK (amount > 0),
      method           TEXT NOT NULL DEFAULT 'cash'
                         CHECK (method IN ('cash', 'check', 'card', 'online', 'other')),
      payment_ref      TEXT,
      is_deposit       BOOLEAN NOT NULL DEFAULT FALSE,
      received_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      received_by      INTEGER REFERENCES ochr_users(id) ON DELETE SET NULL,
      refunded_at      TIMESTAMPTZ,
      refund_ref       TEXT,
      notes            TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await addConstraintIfMissing('ochr_invoice_payments_invoice_org_fk',
    `ALTER TABLE ochr_invoice_payments ADD CONSTRAINT ochr_invoice_payments_invoice_org_fk
       FOREIGN KEY (invoice_id, organization_id)
       REFERENCES ochr_invoices(id, organization_id) ON DELETE CASCADE`)

  // The invoice detail's payment history, and the day's receipts view.
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_invoice_payments_invoice
                    ON ochr_invoice_payments(invoice_id, received_at)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_invoice_payments_org_date
                    ON ochr_invoice_payments(organization_id, received_at DESC)`)

  await pool.query(`ALTER TABLE ochr_invoice_payments ENABLE ROW LEVEL SECURITY`)

  console.log('Migration 069: invoice-payments — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
