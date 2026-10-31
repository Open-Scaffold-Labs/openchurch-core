// SP-245 / SP-249: migration 132's template seed must apply on an UPGRADE
// where a parish is already HELD (migration 114 guard). Without the
// transaction-local bypass, the default mapping INSERT raises
// "Organization is on hold" (23514) and boot refuses to serve.
//
// Runs on its own throwaway database: the chain is applied through 133,
// 133 and 132 are reverted to the 131 shape, a held parish and an active
// control are seeded, then 132 and 133 are applied. HOLD must still refuse
// ordinary writes afterward. 133 creates empty catering tables only — it
// has no org-wide seed — so the held parish does not block it; this file
// still walks 131→133 so a future seed in 133 would fail the same way.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import 'dotenv/config'
import { createScratchDatabase, dropScratchDatabase } from './support/scratchDb.js'

const ORIGINAL_URL = process.env.DATABASE_URL
let scratch, pool, up132, up133

async function revertTo131() {
  await pool.query(`
    DROP TABLE IF EXISTS ochr_cat_agreement_events CASCADE;
    DROP TABLE IF EXISTS ochr_cat_agreements CASCADE;
    DROP TABLE IF EXISTS ochr_cat_beos CASCADE;
    DROP TABLE IF EXISTS ochr_cat_milestones CASCADE;
    DROP TABLE IF EXISTS ochr_cat_bookings CASCADE;
    DROP TABLE IF EXISTS ochr_cat_spaces CASCADE;
    DROP FUNCTION IF EXISTS ochr_cat_agreement_events_append_only();
    DROP FUNCTION IF EXISTS ochr_cat_agreement_text_frozen();
    DROP FUNCTION IF EXISTS ochr_cat_milestones_frozen_after_send();
    DELETE FROM ochr_schema_migrations WHERE name = '133-parish-catering';

    DROP TRIGGER IF EXISTS ochr_seed_category_defaults ON ochr_organizations;
    DROP TRIGGER IF EXISTS ochr_lock_parish_mappings ON ochr_donations;
    DROP TRIGGER IF EXISTS ochr_lock_parish_mappings ON ochr_donation_refunds;
    DROP TRIGGER IF EXISTS ochr_lock_parish_mappings ON ochr_payroll_shifts;
    DROP TRIGGER IF EXISTS ochr_lock_parish_mappings ON ochr_payroll_staff;
    DROP FUNCTION IF EXISTS ochr_lock_parish_mappings();
    DROP FUNCTION IF EXISTS ochr_seed_category_defaults();
    DROP VIEW IF EXISTS ochr_parish_ledger;
    DROP FUNCTION IF EXISTS ochr_mapping_account(integer, text, text, date);
    ALTER TABLE ochr_ledger_entries DROP CONSTRAINT IF EXISTS ochr_ledger_entries_import_fk;
    ALTER TABLE ochr_ledger_entries DROP COLUMN IF EXISTS import_id;
    DROP TABLE IF EXISTS ochr_ledger_imports;
    DROP TABLE IF EXISTS ochr_books_cutover;
    DELETE FROM ochr_coa_mappings WHERE set_by = 'template';
    DROP INDEX IF EXISTS uq_coa_mappings_open;
    DROP INDEX IF EXISTS idx_coa_mappings_resolution;
    ALTER TABLE ochr_coa_mappings DROP CONSTRAINT IF EXISTS ochr_coa_mappings_set_by_check;
    ALTER TABLE ochr_coa_mappings DROP CONSTRAINT IF EXISTS ochr_coa_mappings_supersede_check;
    ALTER TABLE ochr_coa_mappings
      DROP COLUMN IF EXISTS effective_from,
      DROP COLUMN IF EXISTS superseded_on,
      DROP COLUMN IF EXISTS set_by;
    ALTER TABLE ochr_coa_mappings
      ADD CONSTRAINT ochr_coa_mappings_organization_id_source_type_source_key_key
      UNIQUE (organization_id, source_type, source_key);
    DELETE FROM ochr_schema_migrations WHERE name = '132-effective-dated-mappings';
  `)
  // 130 installs the 131-era view when ochr_mapping_account is absent.
  const { up: upgrade130 } = await import('../src/migrations/130-event-deposits.js')
  await upgrade130()
}

beforeAll(async () => {
  scratch = await createScratchDatabase(ORIGINAL_URL, 'm132hold')
  process.env.DATABASE_URL = scratch.url
  pool = (await import('../src/db.js')).default
  const { runAllMigrations } = await import('../src/migrations/index.js')
  await runAllMigrations()
  up132 = (await import('../src/migrations/132-effective-dated-mappings.js')).up
  up133 = (await import('../src/migrations/133-parish-catering.js')).up
  await revertTo131()
}, 240_000)

afterAll(async () => {
  await pool?.end()
  process.env.DATABASE_URL = ORIGINAL_URL
  if (scratch) await dropScratchDatabase(scratch.admin, scratch.name)
})

describe('migration 132 upgrade with a held parish (SP-245/SP-249)', () => {
  it('applies 132 then 133, seeds templates for the held org, and HOLD still refuses ordinary writes', async () => {
    const org = async (name) => (await pool.query(
      `INSERT INTO ochr_organizations (name, slug, timezone, org_type)
       VALUES ($1, $2, 'America/Los_Angeles', 'parish') RETURNING id`,
      [name, `${name.toLowerCase().replace(/\W+/g, '-')}-${Date.now()}`])).rows[0].id
    const held = await org('M132 Hold Parish')
    const active = await org('M132 Active Parish')
    await pool.query('UPDATE ochr_organizations SET held_at = NOW() WHERE id = $1', [held])

    await up132()
    await up133()

    const { rows: heldMaps } = await pool.query(
      `SELECT source_key, account_code, set_by FROM ochr_coa_mappings
        WHERE organization_id = $1 AND set_by = 'template' AND superseded_on IS NULL
        ORDER BY source_key COLLATE "C"`, [held])
    expect(heldMaps.length).toBeGreaterThan(0)
    expect(heldMaps.every(r => r.set_by === 'template')).toBe(true)

    const { rows: activeMaps } = await pool.query(
      `SELECT count(*)::int AS n FROM ochr_coa_mappings
        WHERE organization_id = $1 AND set_by = 'template' AND superseded_on IS NULL`, [active])
    expect(activeMaps[0].n).toBe(heldMaps.length)

    const { rows: [cutover] } = await pool.query(`SELECT cutover_on FROM ochr_books_cutover`)
    expect(cutover).toBeTruthy()
    const { rows: cat } = await pool.query(
      `SELECT to_regclass('public.ochr_cat_spaces') AS spaces,
              to_regclass('public.ochr_cat_bookings') AS bookings`)
    expect(cat[0].spaces).toBeTruthy()
    expect(cat[0].bookings).toBeTruthy()

    // HOLD is intact: ordinary writes to the held parish are still refused.
    await expect(pool.query(
      `INSERT INTO ochr_coa_mappings
         (organization_id, source_type, source_key, account_code, effective_from, set_by)
       VALUES ($1, 'donation_category', 'synthetic-hold-probe', '4110', '2026-01-01', 'parish')`,
      [held])).rejects.toMatchObject({ code: '23514' })
    await expect(pool.query(
      `INSERT INTO ochr_donations (organization_id, donor_name, amount, category, date, method)
       VALUES ($1, 'Synthetic', 1, 'offering', '2026-01-15', 'cash')`, [held]))
      .rejects.toMatchObject({ code: '23514' })
    await expect(pool.query(
      `INSERT INTO ochr_cat_spaces (organization_id, name, space_kind, vertical_key)
       VALUES ($1, 'Hall', 'fellowship_hall', 'open-church')`, [held]))
      .rejects.toMatchObject({ code: '23514' })

    // The guard trigger on mappings is enabled again.
    const t = await pool.query(`SELECT tgenabled FROM pg_trigger WHERE tgname = 'ochr_organization_hold_guard'
                                  AND tgrelid = 'ochr_coa_mappings'::regclass AND NOT tgisinternal`)
    expect(t.rows[0].tgenabled).toBe('O')

    // The active control still accepts writes.
    await pool.query(
      `INSERT INTO ochr_donations (organization_id, donor_name, amount, category, date, method)
       VALUES ($1, 'Synthetic', 1, 'offering', '2026-01-15', 'cash')`, [active])
  }, 120_000)
})
