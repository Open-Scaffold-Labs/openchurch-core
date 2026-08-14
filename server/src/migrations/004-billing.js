// Adds billing fields to ochr_organizations. Provider-agnostic — the
// columns are named generically (`provider_customer_id`,
// `provider_subscription_id`) so we don't bake Stripe vs Lemon Squeezy
// vs Paddle into the schema.
//
// All defaults are sensible for an org that hasn't subscribed yet:
//   plan = 'free', billing_status NULL, no provider IDs.
//
// Idempotent — ADD COLUMN IF NOT EXISTS lets re-runs no-op.

import pool from '../db.js'

export async function up() {
  console.log('Migration 004: billing — applying...')

  await pool.query(`
    ALTER TABLE ochr_organizations
      ADD COLUMN IF NOT EXISTS plan                     TEXT DEFAULT 'free',
      ADD COLUMN IF NOT EXISTS billing_status           TEXT,
      ADD COLUMN IF NOT EXISTS provider_customer_id     TEXT,
      ADD COLUMN IF NOT EXISTS provider_subscription_id TEXT,
      ADD COLUMN IF NOT EXISTS current_period_end       TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS trial_ends_at            TIMESTAMPTZ
  `)

  // Lookup index for webhook handlers — the incoming event arrives
  // with a customer_id, and we need to find the matching org fast.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ochr_organizations_provider_customer
      ON ochr_organizations(provider_customer_id)
      WHERE provider_customer_id IS NOT NULL
  `)

  console.log('Migration 004: billing — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
