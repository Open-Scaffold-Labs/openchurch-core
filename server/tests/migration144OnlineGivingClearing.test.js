// PR-G / mig 144: template + per-org seed for 1130 / 5230, including held orgs
// (hold-guard DISABLE/ENABLE pattern). Payments stay ON HOLD — chart only.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import 'dotenv/config'
import pg from 'pg'
import { createScratchDatabase, dropScratchDatabase } from './support/scratchDb.js'
import {
  ONLINE_GIVING_CLEARING,
  PAYMENT_PROCESSING_FEES,
} from '../src/migrations/144-online-giving-clearing.js'

const ORIGINAL_URL = process.env.DATABASE_URL
let scratch, pool, up144

const CODES = [ONLINE_GIVING_CLEARING.code, PAYMENT_PROCESSING_FEES.code]

async function revert144() {
  await pool.query('ALTER TABLE ochr_coa_accounts DISABLE TRIGGER ochr_organization_hold_guard').catch(() => {})
  try {
    await pool.query(`DELETE FROM ochr_coa_accounts WHERE code = ANY($1::text[])`, [CODES])
    await pool.query(`DELETE FROM ochr_schema_migrations WHERE name = '144-online-giving-clearing'`)
  } finally {
    await pool.query('ALTER TABLE ochr_coa_accounts ENABLE TRIGGER ochr_organization_hold_guard').catch(() => {})
  }
}

beforeAll(async () => {
  scratch = await createScratchDatabase(ORIGINAL_URL, 'm144prg')
  process.env.DATABASE_URL = scratch.url
  const dbMod = await import('../src/db.js')
  try { await dbMod.default.end() } catch { /* ok */ }
  const fresh = new pg.Pool({ connectionString: scratch.url })
  dbMod.default.query = fresh.query.bind(fresh)
  dbMod.default.connect = fresh.connect.bind(fresh)
  dbMod.default.end = async () => { /* afterAll */ }
  dbMod.default.on = fresh.on.bind(fresh)
  pool = fresh

  const { runAllMigrations } = await import('../src/migrations/index.js')
  await runAllMigrations()
  up144 = (await import('../src/migrations/144-online-giving-clearing.js')).up
  await revert144()
}, 240_000)

afterAll(async () => {
  await pool?.end().catch(() => {})
  process.env.DATABASE_URL = ORIGINAL_URL
  if (scratch) await dropScratchDatabase(scratch.admin, scratch.name)
})

describe('migration 144 online giving clearing + fee expense (PR-G)', () => {
  it('seeds 1130 and 5230 on template, held org, and active org; hold guard stays on', async () => {
    const org = async (name) => (await pool.query(
      `INSERT INTO ochr_organizations (name, slug, timezone, org_type)
       VALUES ($1, $2, 'America/Los_Angeles', 'parish') RETURNING id`,
      [name, `${name.toLowerCase().replace(/\W+/g, '-')}-${Date.now()}`])).rows[0].id
    const held = await org('M144 Hold Parish')
    const active = await org('M144 Active Parish')
    await pool.query('UPDATE ochr_organizations SET held_at = NOW() WHERE id = $1', [held])

    await up144()

    const expectRow = async (orgId, acct) => {
      const { rows } = await pool.query(
        `SELECT code, name, acct_type, rollup_group, assessable, sort_order
           FROM ochr_coa_accounts
          WHERE organization_id IS NOT DISTINCT FROM $1 AND code = $2`,
        [orgId, acct.code])
      expect(rows).toEqual([expect.objectContaining({
        code: acct.code,
        name: acct.name,
        acct_type: acct.acct_type,
        rollup_group: acct.rollup_group,
        assessable: acct.assessable,
        sort_order: acct.sort_order,
      })])
    }

    for (const acct of [ONLINE_GIVING_CLEARING, PAYMENT_PROCESSING_FEES]) {
      await expectRow(null, acct)
      await expectRow(held, acct)
      await expectRow(active, acct)
    }

    // Idempotent re-run
    await up144()
    const { rows: tpl } = await pool.query(
      `SELECT code FROM ochr_coa_accounts WHERE organization_id IS NULL AND code = ANY($1::text[])`,
      [CODES])
    expect(tpl).toHaveLength(2)

    await expect(pool.query(
      `INSERT INTO ochr_coa_accounts
         (organization_id, code, name, acct_type, rollup_group, assessable, sort_order)
       VALUES ($1, '9998', 'Hold Probe', 'expense', 'Other', false, 998)`,
      [held])).rejects.toMatchObject({ code: '23514' })

    const t = await pool.query(
      `SELECT tgenabled FROM pg_trigger
        WHERE tgname = 'ochr_organization_hold_guard'
          AND tgrelid = 'ochr_coa_accounts'::regclass AND NOT tgisinternal`)
    expect(t.rows[0].tgenabled).toBe('O')
  }, 120_000)
})
