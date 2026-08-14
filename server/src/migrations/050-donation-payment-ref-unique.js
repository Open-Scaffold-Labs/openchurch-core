// Idempotency guard for online donations (GIV.5 hardening).
//
// recordDonationCheckoutCompleted() dedups incoming Stripe webhooks on
// (organization_id, payment_ref). Stripe intentionally re-delivers a
// webhook, and Vercel can run lambda invocations concurrently, so a
// SELECT-then-INSERT check races: two deliveries for the same session
// both see an empty SELECT and both INSERT, producing a duplicate
// donation row AND a duplicate receipt email.
//
// This partial unique index makes the dedup atomic: the second INSERT
// conflicts and the app path uses ON CONFLICT DO NOTHING + a rowCount
// check to decide whether to send the receipt. Partial (payment_ref
// IS NOT NULL) so manually-entered donations — which have no provider
// reference — are unaffected and can freely share a NULL payment_ref.

import pool from '../db.js'

export async function up() {
  console.log('Migration 050: donation-payment-ref-unique — applying...')

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_donations_org_payment_ref
      ON ochr_donations(organization_id, payment_ref)
      WHERE payment_ref IS NOT NULL
  `)

  console.log('Migration 050: donation-payment-ref-unique — applied.')
}
