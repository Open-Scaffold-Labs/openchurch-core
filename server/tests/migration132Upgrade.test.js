// Migration 132 on an UPGRADE with real-looking books (Atlas N1/N2,
// Ledger N1/N2/N4). Runs on its own throwaway database: the chain is
// applied, 132 is reverted to the 131 shape, and a parish is seeded with
//   · a gift dated its own today and one dated a few days ahead,
//   · a typo'd 2099 gift in a category with no mapping,
//   · pre-existing mappings that differ only by case ('Offering' / 'offering'),
// then 132 is applied. It must apply in one transaction, store a cutover
// after every parish's today, keep every total dated before the cutover,
// and keep both case variants. A 2099 period already submitted to the
// diocese must abort it and leave nothing behind.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import 'dotenv/config'
import { createScratchDatabase, dropScratchDatabase } from './support/scratchDb.js'

const ORIGINAL_URL = process.env.DATABASE_URL
let scratch, pool, up, upgrade130
let parish, other, diocese

const TOTALS = `
  SELECT organization_id, to_char(entry_date, 'YYYY-MM') AS month, account_code, SUM(amount)::text AS total
    FROM ochr_parish_ledger
   WHERE organization_id = ANY($1) AND entry_date < $2::date
   GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`

async function revertTo131() {
  await pool.query(`
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
  await upgrade130()
}

async function schema132Present() {
  const { rows: [r] } = await pool.query(`
    SELECT to_regclass('public.ochr_books_cutover') AS cutover,
           to_regclass('public.ochr_ledger_imports') AS imports,
           to_regclass('public.uq_coa_mappings_open') AS open_index,
           EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'ochr_coa_mappings' AND column_name = 'effective_from') AS effective_from,
           EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'ochr_mapping_account') AS fn`)
  return r
}

beforeAll(async () => {
  scratch = await createScratchDatabase(ORIGINAL_URL, 'm132')
  process.env.DATABASE_URL = scratch.url
  pool = (await import('../src/db.js')).default
  const { runAllMigrations } = await import('../src/migrations/index.js')
  await runAllMigrations()
  up = (await import('../src/migrations/132-effective-dated-mappings.js')).up
  upgrade130 = (await import('../src/migrations/130-event-deposits.js')).up
  await revertTo131()

  const org = async (name, tz, type = 'parish') => (await pool.query(
    `INSERT INTO ochr_organizations (name, slug, timezone, org_type)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [name, `${name.toLowerCase().replace(/\W+/g, '-')}-${Date.now()}`, tz, type])).rows[0].id
  // Kiritimati is UTC+14: the latest calendar day on Earth.
  parish = await org('M132 Kiritimati Parish', 'Pacific/Kiritimati')
  other = await org('M132 Pacific Parish', 'America/Los_Angeles')
  diocese = await org('M132 Diocese', 'America/Los_Angeles', 'diocese')

  const { rows: [{ today, soon }] } = await pool.query(
    `SELECT to_char((now() AT TIME ZONE 'Pacific/Kiritimati')::date, 'YYYY-MM-DD') AS today,
            to_char((now() AT TIME ZONE 'Pacific/Kiritimati')::date + 5, 'YYYY-MM-DD') AS soon`)
  const gift = (o, amount, category, date) => pool.query(
    `INSERT INTO ochr_donations (organization_id, donor_name, amount, category, date, method)
     VALUES ($1, 'Synthetic', $2, $3, $4::date, 'cash')`, [o, amount, category, date])
  await gift(parish, 50, 'offering', today)
  await gift(parish, 60, 'special collection', soon)
  await gift(parish, 70, 'missions', '2099-03-01')
  await gift(parish, 18, 'special collection', '2026-01-15')
  await gift(parish, 21, 'Offering', '2026-01-15')
  await gift(parish, 22, 'offering', '2026-01-15')
  await gift(other, 40, 'Offertory', today)
  await pool.query(
    `INSERT INTO ochr_coa_mappings (organization_id, source_type, source_key, account_code)
     VALUES ($1, 'donation_category', 'Offering', '4410'),
            ($1, 'donation_category', 'offering', '4110'),
            ($2, 'donation_category', 'Offertory', '4110'),
            ($2, 'donation_category', 'offertory', '4420')`,
    [parish, other])
}, 180_000)

afterAll(async () => {
  await pool?.end()
  process.env.DATABASE_URL = ORIGINAL_URL
  if (scratch) await dropScratchDatabase(scratch.admin, scratch.name)
})

describe('migration 132 on an existing database', () => {
  it('a submitted period holding a gift that would move aborts, and nothing is left half-applied', async () => {
    await pool.query(
      `INSERT INTO ochr_report_submissions (organization_id, diocese_org_id, period_start, period_end, totals_json)
       VALUES ($1, $2, '2099-03-01', '2099-03-31', '{}'::jsonb)`, [parish, diocese])
    await expect(up()).rejects.toThrow(/submitted or approved period/)
    expect(await schema132Present()).toEqual({
      cutover: null, imports: null, open_index: null, effective_from: false, fn: false,
    })
    await pool.query(`DELETE FROM ochr_report_submissions WHERE organization_id = $1`, [parish])
  })

  it('applies with gifts dated today, ahead, and in 2099, and keeps every earlier total', async () => {
    const { rows: [{ floor }] } = await pool.query(
      `SELECT to_char(GREATEST(DATE '2026-10-27', (now() AT TIME ZONE 'Pacific/Kiritimati')::date + 1), 'YYYY-MM-DD') AS floor`)
    const before = (await pool.query(TOTALS, [[parish, other], floor])).rows
    expect(before.length).toBeGreaterThan(0)

    await up()

    const { rows: [{ c }] } = await pool.query(
      `SELECT to_char(cutover_on, 'YYYY-MM-DD') AS c FROM ochr_books_cutover`)
    // After every parish's today, so nothing entered for today restates.
    expect(c >= floor).toBe(true)
    const after = (await pool.query(TOTALS, [[parish, other], c])).rows
    expect(after).toEqual(before)

    const acct = async (o, amount) => (await pool.query(
      `SELECT account_code FROM ochr_parish_ledger
        WHERE organization_id = $1 AND source_type = 'donation' AND amount = $2`, [o, amount])).rows[0]
    expect((await acct(parish, 50)).account_code).toBe('4110')   // today, exact 'offering'
    expect((await acct(other, 40)).account_code).toBe('4110')    // today, exact 'Offertory'
    expect((await acct(parish, 21)).account_code).toBe('4410')   // 'Offering' stays its own row
    expect((await acct(parish, 22)).account_code).toBe('4110')
    expect((await acct(parish, 18)).account_code).toBe('4420')   // history keeps 4420
    expect((await acct(parish, 70)).account_code).toBeNull()     // 2099 typo: unknown, held
  })

  it('keeps both case variants open, and the open index is exact', async () => {
    const { rows } = await pool.query(
      `SELECT source_key, account_code, set_by FROM ochr_coa_mappings
        WHERE organization_id = $1 AND source_type = 'donation_category'
          AND lower(source_key) = 'offering' AND superseded_on IS NULL
        ORDER BY source_key COLLATE "C"`, [parish])
    expect(rows).toEqual([
      { source_key: 'Offering', account_code: '4410', set_by: 'parish' },
      { source_key: 'offering', account_code: '4110', set_by: 'parish' },
    ])
    const { rows: [idx] } = await pool.query(`SELECT pg_get_indexdef('uq_coa_mappings_open'::regclass) AS d`)
    expect(idx.d).not.toMatch(/lower/i)
  })

  it('is idempotent on a second run', async () => {
    const { rows: [{ c }] } = await pool.query(`SELECT cutover_on::text AS c FROM ochr_books_cutover`)
    await up()
    const { rows: [again] } = await pool.query(`SELECT cutover_on::text AS c FROM ochr_books_cutover`)
    expect(again.c).toBe(c)
  })
})

// Ledger R1: an earlier head of 132 committed the cutover on its own and then
// failed. That row can now be a parish's today or earlier, and 132 is not
// recorded, so the next run must choose the cutover again.
describe('migration 132 after an earlier head failed part-way', () => {
  it('chooses the cutover again instead of keeping a stale one', async () => {
    if ((await schema132Present()).effective_from) await revertTo131()
    const { rows: [{ stale, floor }] } = await pool.query(
      `SELECT to_char((now() AT TIME ZONE 'America/Los_Angeles')::date - 1, 'YYYY-MM-DD') AS stale,
              to_char(GREATEST(DATE '2026-10-27', (now() AT TIME ZONE 'Pacific/Kiritimati')::date + 1), 'YYYY-MM-DD') AS floor`)
    // The partial state: the cutover table and its row survived the failure.
    await pool.query(`
      CREATE TABLE ochr_books_cutover (
        id BOOLEAN PRIMARY KEY DEFAULT TRUE,
        cutover_on DATE NOT NULL,
        CONSTRAINT ochr_books_cutover_one CHECK (id))`)
    await pool.query(`INSERT INTO ochr_books_cutover (id, cutover_on) VALUES (TRUE, $1::date)`, [stale])
    // Posted on the stale day, in a category the template sends to 2320.
    const { rows: [g] } = await pool.query(
      `INSERT INTO ochr_donations (organization_id, donor_name, amount, category, date, method)
       VALUES ($1, 'Synthetic', 77, 'special collection', $2::date, 'cash') RETURNING id`, [other, stale])

    await up()

    const { rows: [{ c }] } = await pool.query(
      `SELECT to_char(cutover_on, 'YYYY-MM-DD') AS c FROM ochr_books_cutover`)
    const { rows: [line] } = await pool.query(
      `SELECT account_code FROM ochr_parish_ledger WHERE source_type = 'donation' AND source_id = $1`, [g.id])
    expect({ cutoverAfterFloor: c >= floor, stale, cutover: c, account: line.account_code })
      .toEqual({ cutoverAfterFloor: true, stale, cutover: c, account: '4420' })
    const { rows: tmpl } = await pool.query(
      `SELECT DISTINCT to_char(effective_from, 'YYYY-MM-DD') AS f FROM ochr_coa_mappings WHERE set_by = 'template'`)
    expect(tmpl).toEqual([{ f: c }])
  })

  it('a complete run keeps its stored cutover on a direct second run', async () => {
    const { rows: [{ c }] } = await pool.query(`SELECT cutover_on::text AS c FROM ochr_books_cutover`)
    await pool.query(`UPDATE ochr_books_cutover SET cutover_on = cutover_on + 3`)
    await up()
    const { rows: [again] } = await pool.query(`SELECT (cutover_on - 3)::text AS c FROM ochr_books_cutover`)
    expect(again.c).toBe(c)
    await pool.query(`UPDATE ochr_books_cutover SET cutover_on = cutover_on - 3`)
  })
})

// Atlas P2-a: a wait for a lock is bounded, and the source tables are locked
// before the mappings table.
describe('migration 132 lock bounds', () => {
  it('gives up after lock_timeout behind an open gift write and leaves nothing applied', async () => {
    if ((await schema132Present()).effective_from) await revertTo131()
    const holder = await pool.connect()
    try {
      await holder.query('BEGIN')
      await holder.query(
        `INSERT INTO ochr_donations (organization_id, donor_name, amount, category, date, method)
         VALUES ($1, 'Synthetic', 5, 'tithe', '2026-01-20', 'cash')`, [other])
      const t0 = Date.now()
      await expect(up()).rejects.toThrow(/lock timeout/i)
      const waited = Date.now() - t0
      expect(waited).toBeGreaterThanOrEqual(4500)
      expect(waited).toBeLessThan(15000)
      // Source tables first: the mappings table was never taken.
      expect(await schema132Present()).toEqual({
        cutover: null, imports: null, open_index: null, effective_from: false, fn: false,
      })
    } finally {
      await holder.query('ROLLBACK')
      holder.release()
    }
    await up()
    expect((await schema132Present()).fn).toBe(true)
  }, 30_000)
})
