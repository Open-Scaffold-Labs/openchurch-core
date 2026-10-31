// 137 — Parish Stripe Connect account column (N443-1).
//
// Code has read ochr_organizations.stripe_connect_account_id since #416, but
// no migration ever added the column. findOrgBySlug also omitted it from its
// SELECT, so savedConnectAccountId(org) was always null and live Connect
// giving always 409'd even when a parish would have had an account. This
// migration is additive and nullable: it does not activate payments, write a
// value, or expose a public setter. Payments stay ON HOLD (OC_BETA_BILLING).

import pool from '../db.js'

export async function up() {
  console.log('Migration 137: stripe-connect-account — applying...')

  await pool.query(`
    ALTER TABLE ochr_organizations
      ADD COLUMN IF NOT EXISTS stripe_connect_account_id TEXT
  `)

  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ochr_organizations_stripe_connect_account_id_check'
      ) THEN
        ALTER TABLE ochr_organizations
          ADD CONSTRAINT ochr_organizations_stripe_connect_account_id_check
          CHECK (
            stripe_connect_account_id IS NULL
            OR stripe_connect_account_id ~ '^acct_[A-Za-z0-9]+$'
          );
      END IF;
    END $$;
  `)

  console.log('Migration 137: stripe-connect-account — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
