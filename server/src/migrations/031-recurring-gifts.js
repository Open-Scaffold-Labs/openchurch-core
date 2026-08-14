// ochr_recurring_gifts
//
// Giving, GIV.7 — a donor can set up a repeating gift from the public
// give page. The first charge happens at setup; a cron then charges due
// rows on each cycle (weekly/monthly), recording an ordinary donation
// every time so recurring giving flows into the same stats/statements.
//
//   frequency        — 'weekly' | 'monthly'.
//   status           — 'active' | 'cancelled'.
//   next_charge_date — when the next charge is due; advanced each cycle.
//   fund_id          — SET NULL if the fund is deleted; charges fall
//                      back to a generic label.

import pool from '../db.js'

export async function up() {
  console.log('Migration 031: recurring-gifts — applying...')

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_recurring_gifts (
      id                BIGSERIAL PRIMARY KEY,
      organization_id   INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      fund_id           BIGINT  REFERENCES ochr_funds(id) ON DELETE SET NULL,
      donor_name        TEXT NOT NULL,
      donor_email       TEXT,
      amount            NUMERIC(10,2) NOT NULL,
      frequency         TEXT NOT NULL CHECK (frequency IN ('weekly', 'monthly')),
      status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
      next_charge_date  DATE NOT NULL,
      last_charged_at   TIMESTAMPTZ,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_recurring_org_status ON ochr_recurring_gifts(organization_id, status)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_recurring_due ON ochr_recurring_gifts(status, next_charge_date)`)

  console.log('Migration 031: recurring-gifts — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
