// 144 — PR-G online giving CoA: clearing asset + processing-fee expense.
//
// José 2026-10-29 2:48 PM PT + Ledger PASS on numbers:
//   1130 Online Giving Clearing (asset, Cash & Bank, sort 25) — nets to 0
//        after each payout; show the balance.
//   5230 Payment Processing Fees (expense, Administration, sort 295).
// Gifts recorded GROSS to 4110 / 4450 / 2320; parish absorbs card fees on
// second collections; 2320 clears only by remittance (Dr 2320 / Cr 1110).
// Payments remain ON HOLD — this migration seeds chart rows only; no
// Stripe / processor activation, no payout journal automation.
//
// ADDITIVE. One REPEATABLE READ transaction. Per-org seed uses the same
// transaction-local hold-guard DISABLE/ENABLE as migrations 120/126/132/136.

import pool from '../db.js'

export const ONLINE_GIVING_CLEARING = Object.freeze({
  code: '1130',
  name: 'Online Giving Clearing',
  acct_type: 'asset',
  rollup_group: 'Cash & Bank',
  assessable: false,
  sort_order: 25,
})

export const PAYMENT_PROCESSING_FEES = Object.freeze({
  code: '5230',
  name: 'Payment Processing Fees',
  acct_type: 'expense',
  rollup_group: 'Administration',
  assessable: false,
  sort_order: 295,
})

const ACCOUNTS = [ONLINE_GIVING_CLEARING, PAYMENT_PROCESSING_FEES]

async function seedOne(db, acct) {
  const params = [
    acct.code, acct.name, acct.acct_type, acct.rollup_group, acct.assessable, acct.sort_order,
  ]
  await db.query(
    `INSERT INTO ochr_coa_accounts (organization_id, code, name, acct_type, rollup_group, assessable, sort_order)
     SELECT NULL, $1::text, $2, $3, $4, $5, $6
      WHERE NOT EXISTS (SELECT 1 FROM ochr_coa_accounts WHERE organization_id IS NULL AND code = $1::text)`,
    params)
  await db.query(
    `INSERT INTO ochr_coa_accounts (organization_id, code, name, acct_type, rollup_group, assessable, sort_order)
     SELECT o.id, $1::text, $2, $3, $4, $5, $6
       FROM ochr_organizations o
      WHERE NOT EXISTS (
        SELECT 1 FROM ochr_coa_accounts c
         WHERE c.organization_id = o.id AND c.code = $1::text)`,
    params)
}

export async function up() {
  console.log('Migration 144: online-giving-clearing — applying...')
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
    await client.query(`SET LOCAL lock_timeout = '5s'`)

    // Held orgs refuse ordinary COA writes (P1 N1 / #435). DISABLE for the
    // seed only; ENABLE commits with the seed (any error rolls both back).
    await client.query('ALTER TABLE ochr_coa_accounts DISABLE TRIGGER ochr_organization_hold_guard')
    try {
      for (const acct of ACCOUNTS) {
        await seedOne(client, acct)
      }
    } finally {
      await client.query('ALTER TABLE ochr_coa_accounts ENABLE TRIGGER ochr_organization_hold_guard')
    }

    await client.query('COMMIT')
    console.log('Migration 144: online-giving-clearing — done.')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}
