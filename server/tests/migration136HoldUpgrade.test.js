// SP-250 P1 N1: migration 136's per-org 2330 seed must apply on an UPGRADE
// where a parish is already HELD (migration 114 guard). Same pattern as
// #435 / migrations 120 and 126 / migration132HoldUpgrade.test.js.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import 'dotenv/config'
import pg from 'pg'
import { createScratchDatabase, dropScratchDatabase } from './support/scratchDb.js'
import { LEDGER_DEPOSIT_BRANCH } from '../src/migrations/130-event-deposits.js'

const ORIGINAL_URL = process.env.DATABASE_URL
let scratch, pool, up136

const DONATION_ACCOUNT = `COALESCE(
      CASE WHEN d.fund_id IS NOT NULL
           THEN ochr_mapping_account(d.organization_id, 'fund', d.fund_id::text, d.date::date)
      END,
      ochr_mapping_account(
        d.organization_id, 'donation_category',
        COALESCE(NULLIF(TRIM(d.category), ''), 'Uncategorized'), d.date::date),
      CASE WHEN d.date::date < (SELECT cutover_on FROM ochr_books_cutover) THEN '4420' ELSE NULL END
    )`

const LEDGER_VIEW_132 = `
    CREATE OR REPLACE VIEW ochr_parish_ledger WITH (security_invoker = true) AS
    SELECT
      le.organization_id, le.entry_date, le.account_code, le.amount,
      le.source_type, le.id AS source_id, le.memo
    FROM ochr_ledger_entries le
    UNION ALL
    SELECT
      d.organization_id, d.date::date AS entry_date, ${DONATION_ACCOUNT} AS account_code,
      d.amount AS amount, 'donation' AS source_type, d.id AS source_id,
      COALESCE(NULLIF(TRIM(d.category), ''), 'Uncategorized') AS memo
    FROM ochr_donations d
    UNION ALL
    SELECT
      r.organization_id, d.date::date AS entry_date, ${DONATION_ACCOUNT} AS account_code,
      (-r.amount)::NUMERIC(12,2) AS amount, 'donation_refund' AS source_type, r.id AS source_id,
      COALESCE(NULLIF(TRIM(d.category), ''), 'Uncategorized') AS memo
    FROM ochr_donation_refunds r
    JOIN ochr_donations d ON d.id = r.donation_id AND d.organization_id = r.organization_id
    WHERE r.status = 'posted'
    UNION ALL
    SELECT
      d.organization_id, d.date::date AS entry_date, ${DONATION_ACCOUNT} AS account_code,
      (-d.amount)::NUMERIC(12,2) AS amount, 'donation_refund' AS source_type, d.id AS source_id,
      COALESCE(NULLIF(TRIM(d.category), ''), 'Uncategorized') AS memo
    FROM ochr_donations d
    WHERE d.payment_status = 'refunded'
      AND NOT EXISTS (
        SELECT 1 FROM ochr_donation_refunds r
         WHERE r.donation_id = d.id AND r.organization_id = d.organization_id AND r.status = 'posted')
    UNION ALL
    SELECT
      s.organization_id, sh.date::date AS entry_date,
      COALESCE(ochr_mapping_account(s.organization_id, 'payroll', 'wages', sh.date::date), '5120') AS account_code,
      (sh.hours * s.pay_rate)::NUMERIC(12,2) AS amount, 'payroll' AS source_type, sh.id AS source_id, s.name AS memo
    FROM ochr_payroll_shifts sh
    JOIN ochr_payroll_staff s ON s.id = sh.staff_id
    ${LEDGER_DEPOSIT_BRANCH}
  `

async function revert136() {
  // Hold-guard may refuse DELETE of 2330 if a held org is present; disable
  // for the revert only (mirrors the production seed bypass under test).
  await pool.query('ALTER TABLE ochr_coa_accounts DISABLE TRIGGER ochr_organization_hold_guard').catch(() => {})
  try {
    await pool.query(`
      DROP VIEW IF EXISTS ochr_parish_ledger CASCADE;
      DROP TRIGGER IF EXISTS ochr_mass_stipend_facts_append_only ON ochr_mass_stipend_facts;
      DROP TRIGGER IF EXISTS ochr_organization_hold_guard ON ochr_mass_stipend_facts;
      DROP FUNCTION IF EXISTS ochr_mass_stipend_facts_append_only();
      DROP TABLE IF EXISTS ochr_mass_stipend_facts CASCADE;
      DELETE FROM ochr_coa_accounts WHERE code = '2330';
      DELETE FROM ochr_schema_migrations WHERE name = '136-mass-stipend-liability';
    `)
  } finally {
    await pool.query('ALTER TABLE ochr_coa_accounts ENABLE TRIGGER ochr_organization_hold_guard').catch(() => {})
  }
  await pool.query(LEDGER_VIEW_132)
}

beforeAll(async () => {
  scratch = await createScratchDatabase(ORIGINAL_URL, 'm136hold')
  process.env.DATABASE_URL = scratch.url
  // Own pool on scratch. Migration modules import ../db.js — re-bind that
  // singleton to scratch so up()/runAllMigrations write here, not the suite DB.
  const dbMod = await import('../src/db.js')
  try { await dbMod.default.end() } catch { /* ok */ }
  const fresh = new pg.Pool({ connectionString: scratch.url })
  // Replace callable surface used by migrations (query/connect/end).
  dbMod.default.query = fresh.query.bind(fresh)
  dbMod.default.connect = fresh.connect.bind(fresh)
  dbMod.default.end = async () => { /* keep for afterAll */ }
  dbMod.default.on = fresh.on.bind(fresh)
  pool = fresh

  const { runAllMigrations } = await import('../src/migrations/index.js')
  await runAllMigrations()
  up136 = (await import('../src/migrations/136-mass-stipend-liability.js')).up
  await revert136()
}, 240_000)

afterAll(async () => {
  await pool?.end().catch(() => {})
  process.env.DATABASE_URL = ORIGINAL_URL
  if (scratch) await dropScratchDatabase(scratch.admin, scratch.name)
})

describe('migration 136 upgrade with a held parish (SP-250 P1 N1)', () => {
  it('seeds 2330 for the held org and HOLD still refuses ordinary writes', async () => {
    const org = async (name) => (await pool.query(
      `INSERT INTO ochr_organizations (name, slug, timezone, org_type)
       VALUES ($1, $2, 'America/Los_Angeles', 'parish') RETURNING id`,
      [name, `${name.toLowerCase().replace(/\W+/g, '-')}-${Date.now()}`])).rows[0].id
    const held = await org('M136 Hold Parish')
    const active = await org('M136 Active Parish')
    await pool.query('UPDATE ochr_organizations SET held_at = NOW() WHERE id = $1', [held])

    await up136()

    const { rows: heldCoa } = await pool.query(
      `SELECT code, acct_type, assessable FROM ochr_coa_accounts
        WHERE organization_id = $1 AND code = '2330'`, [held])
    expect(heldCoa).toEqual([
      expect.objectContaining({ code: '2330', acct_type: 'liability', assessable: false }),
    ])
    const { rows: activeCoa } = await pool.query(
      `SELECT code FROM ochr_coa_accounts WHERE organization_id = $1 AND code = '2330'`, [active])
    expect(activeCoa).toHaveLength(1)

    const facts = await pool.query(
      `SELECT to_regclass('public.ochr_mass_stipend_facts') AS t`)
    expect(facts.rows[0].t).toBeTruthy()

    await expect(pool.query(
      `INSERT INTO ochr_coa_accounts
         (organization_id, code, name, acct_type, rollup_group, assessable, sort_order)
       VALUES ($1, '9999', 'Hold Probe', 'expense', 'Other', false, 999)`,
      [held])).rejects.toMatchObject({ code: '23514' })

    const t = await pool.query(
      `SELECT tgenabled FROM pg_trigger
        WHERE tgname = 'ochr_organization_hold_guard'
          AND tgrelid = 'ochr_coa_accounts'::regclass AND NOT tgisinternal`)
    expect(t.rows[0].tgenabled).toBe('O')

    await pool.query(
      `INSERT INTO ochr_coa_accounts
         (organization_id, code, name, acct_type, rollup_group, assessable, sort_order)
       VALUES ($1, '9999', 'Hold Probe', 'expense', 'Other', false, 999)`,
      [active])
  }, 120_000)
})
