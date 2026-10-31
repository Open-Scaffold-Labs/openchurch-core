// R339-4: migration 120's latch backfill on an UPGRADE where a parish is
// already HELD (migration 114 guard). Runs on its own throwaway database:
// the chain is applied, 120 is reverted to reach the 119 shape, a held
// parish (fulfilled NULL-stamp, stamped, plain rows) and an active control
// are seeded, then 120 is applied twice.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import pg from 'pg'
import 'dotenv/config'

const baseUrl = process.env.DATABASE_URL
const dbName = `oc_m120_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
const url = new URL(baseUrl); url.pathname = `/${dbName}`
let pool, up

async function admin(sql) {
  const c = new pg.Client({ connectionString: baseUrl }); await c.connect()
  try { await c.query(sql) } finally { await c.end() }
}

beforeAll(async () => {
  await admin(`CREATE DATABASE ${dbName}`)
  process.env.DATABASE_URL = url.toString()
  pool = (await import('../src/db.js')).default
  const { runAllMigrations } = await import('../src/migrations/index.js')
  await runAllMigrations()
  up = (await import('../src/migrations/120-mass-intention-corrections.js')).up
  // Back to the 119 shape: remove everything 120 adds.
  // Later migrations pin FKs on the (id, organization_id) key 120 adds
  // (121 mark items; 136 stipend facts). Those tables go first or the
  // key cannot be dropped. Keep 136's tenant FK in production — this is
  // throwaway-DB teardown only.
  await pool.query(`
    DROP TABLE IF EXISTS ochr_mass_stipend_facts CASCADE;
    DELETE FROM ochr_schema_migrations WHERE name = '136-mass-stipend-liability';
    DROP TABLE IF EXISTS ochr_mass_intention_mark_items;
    DROP TABLE IF EXISTS ochr_mass_intention_mark_batches;
    DELETE FROM ochr_schema_migrations WHERE name = '121-mass-intention-mark-said';
    DROP TRIGGER IF EXISTS ochr_mass_intention_history_latch ON ochr_mass_intentions;
    DROP FUNCTION IF EXISTS ochr_mass_intention_history_latch();
    DROP TABLE IF EXISTS ochr_mass_intention_corrections;
    ALTER TABLE ochr_mass_intentions DROP CONSTRAINT IF EXISTS ochr_mass_intentions_voided_by_fk;
    ALTER TABLE ochr_mass_intentions DROP CONSTRAINT IF EXISTS ochr_mass_intentions_id_org_key;
    ALTER TABLE ochr_mass_intentions DROP COLUMN IF EXISTS entered_history,
      DROP COLUMN IF EXISTS voided_at, DROP COLUMN IF EXISTS voided_by, DROP COLUMN IF EXISTS void_reason;
    DELETE FROM ochr_schema_migrations WHERE name = '120-mass-intention-corrections';
  `)
}, 120_000)

afterAll(async () => {
  await pool?.end()
  await admin(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)
})

const SNAP = `SELECT id, organization_id, intention, status, note, stipend, calendar_event_id,
                     mass_date, fulfilled_mass_date, fulfilled_mass_title, fulfilled_mass_time, updated_at
                FROM ochr_mass_intentions WHERE organization_id = ANY($1) ORDER BY id`

describe('migration 120 upgrade with a held parish', () => {
  it('applies twice, latches only history rows, changes nothing else, and HOLD still refuses ordinary writes', async () => {
    const org = async (name) => (await pool.query(
      `INSERT INTO ochr_organizations (name, slug) VALUES ($1, $2) RETURNING id`,
      [name, `${name.toLowerCase().replace(/\W+/g, '-')}-${Date.now()}`])).rows[0].id
    const held = await org('M120 Held Parish')
    const active = await org('M120 Active Parish')
    const add = (o, status, title = null) => pool.query(
      `INSERT INTO ochr_mass_intentions (organization_id, intention, status, fulfilled_mass_title)
       VALUES ($1, 'Synthetic', $2, $3) RETURNING id`, [o, status, title])
    const heldLegacy = (await add(held, 'fulfilled')).rows[0].id          // NULL stamps
    const heldStamped = (await add(held, 'open', 'Sunday Mass')).rows[0].id // reopened, stamped
    const heldPlain = (await add(held, 'open')).rows[0].id
    const activeFulfilled = (await add(active, 'fulfilled')).rows[0].id
    const activePlain = (await add(active, 'scheduled')).rows[0].id
    await pool.query('UPDATE ochr_organizations SET held_at = NOW() WHERE id = $1', [held])

    const before = (await pool.query(SNAP, [[held, active]])).rows
    await up()
    await up()
    const after = (await pool.query(SNAP, [[held, active]])).rows
    expect(after).toEqual(before)

    const latch = Object.fromEntries((await pool.query(
      'SELECT id, entered_history FROM ochr_mass_intentions WHERE organization_id = ANY($1)', [[held, active]])).rows
      .map(r => [r.id, r.entered_history]))
    expect(latch).toEqual({
      [heldLegacy]: true, [heldStamped]: true, [heldPlain]: false,
      [activeFulfilled]: true, [activePlain]: false,
    })
    const legacy = after.find(r => r.id === heldLegacy)
    expect([legacy.fulfilled_mass_date, legacy.fulfilled_mass_title, legacy.fulfilled_mass_time]).toEqual([null, null, null])

    const led = await pool.query(`SELECT 1 FROM pg_class WHERE relname = 'ochr_mass_intention_corrections'`)
    expect(led.rows).toHaveLength(1)

    // HOLD is intact: ordinary writes to the held parish are still refused.
    await expect(pool.query(`UPDATE ochr_mass_intentions SET note = 'x' WHERE id = $1`, [heldPlain]))
      .rejects.toMatchObject({ code: '23514' })
    await expect(pool.query(`UPDATE ochr_mass_intentions SET entered_history = true WHERE id = $1`, [heldPlain]))
      .rejects.toMatchObject({ code: '23514' })
    await expect(add(held, 'open')).rejects.toMatchObject({ code: '23514' })
    // The guard trigger is enabled again.
    const t = await pool.query(`SELECT tgenabled FROM pg_trigger WHERE tgname = 'ochr_organization_hold_guard'
                                  AND tgrelid = 'ochr_mass_intentions'::regclass`)
    expect(t.rows[0].tgenabled).toBe('O')
    // The active control still accepts writes.
    await pool.query(`UPDATE ochr_mass_intentions SET note = 'ok' WHERE id = $1`, [activePlain])
  }, 60_000)
})
