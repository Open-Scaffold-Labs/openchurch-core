// Argus N7 / Saint SP-244 — the hall agreement guards are not dropped and
// re-created on every boot, and a repair is one transaction.
//
// Red at 4bd41010:
//   - ensureHallAgreementGuards on a DB that already has every guard drops
//     and re-creates all three triggers (new pg_trigger oids every boot)
//   - a repair commits trigger by trigger, so another session sees the
//     guards change while the repair is still waiting on a lock
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import 'dotenv/config'
import { createScratchDatabase, dropScratchDatabase } from './support/scratchDb.js'

const ORIGINAL_URL = process.env.DATABASE_URL
const TRIGGERS = ['ochr_cat_agreement_events_no_update', 'ochr_cat_agreement_text_frozen', 'ochr_cat_milestones_frozen_after_send']
let scratch, pool, ensure

async function triggerOids() {
  const { rows } = await pool.query(
    `SELECT tgname, oid::int AS oid FROM pg_trigger WHERE tgname = ANY($1) AND NOT tgisinternal ORDER BY tgname`,
    [TRIGGERS])
  return rows
}

beforeAll(async () => {
  scratch = await createScratchDatabase(ORIGINAL_URL, 'hallguards')
  process.env.DATABASE_URL = scratch.url
  pool = (await import('../src/db.js')).default
  const { runAllMigrations } = await import('../src/migrations/index.js')
  await runAllMigrations()
  ensure = (await import('../src/migrations/133-parish-catering.js')).ensureHallAgreementGuards
}, 180_000)

afterAll(async () => {
  await pool?.end()
  process.env.DATABASE_URL = ORIGINAL_URL
  if (scratch) await dropScratchDatabase(scratch.admin, scratch.name)
})

describe('N7: a current DB is left alone', () => {
  it('re-running the guards on a DB that has them changes nothing', async () => {
    const before = await triggerOids()
    expect(before.map(r => r.tgname)).toEqual([...TRIGGERS].sort())
    expect(await ensure()).toBe('current')
    expect(await triggerOids()).toEqual(before)
  })

  it('a stale guard body is noticed and repaired', async () => {
    await pool.query(`CREATE OR REPLACE FUNCTION ochr_cat_agreement_text_frozen()
      RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RETURN NEW; END $fn$`)
    expect(await ensure()).toBe('repaired')
    expect(await ensure()).toBe('current')
    const { rows: [{ src }] } = await pool.query(
      `SELECT prosrc AS src FROM pg_proc WHERE proname = 'ochr_cat_agreement_text_frozen'`)
    expect(src).toMatch(/a sent hall agreement is not rewritten/)
  })

  it('a missing trigger is noticed and put back', async () => {
    await pool.query('DROP TRIGGER ochr_cat_milestones_frozen_after_send ON ochr_cat_milestones')
    expect(await ensure()).toBe('repaired')
    expect((await triggerOids()).map(r => r.tgname)).toEqual([...TRIGGERS].sort())
  })
})

describe('N7: a repair is all or nothing', () => {
  it('no other session sees a guard change until the whole repair commits', async () => {
    await pool.query('DROP INDEX ochr_cat_agreements_token_hash_key')
    const before = await triggerOids()
    const holder = await pool.connect()
    let pending
    try {
      await holder.query('BEGIN')
      const { rows: [{ pid }] } = await holder.query('SELECT pg_backend_pid() AS pid')
      // The repair reaches the milestones trigger last and waits here.
      await holder.query('LOCK TABLE ochr_cat_milestones IN ACCESS SHARE MODE')
      pending = ensure()
      let blocked = false
      for (let i = 0; i < 100 && !blocked; i++) {
        const { rows } = await pool.query(
          `SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`, [pid])
        blocked = rows[0].n > 0
        if (!blocked) await new Promise(r => setTimeout(r, 50))
      }
      expect(blocked).toBe(true)
      // Mid-repair, from outside: the index is still absent and every
      // trigger is the one that was there before.
      expect(await triggerOids()).toEqual(before)
      const { rows: [{ idx }] } = await pool.query(`SELECT to_regclass('ochr_cat_agreements_token_hash_key') AS idx`)
      expect(idx).toBeNull()
    } finally {
      await holder.query('COMMIT')
      holder.release()
    }
    expect(await pending).toBe('repaired')
    const { rows: [{ idx }] } = await pool.query(`SELECT to_regclass('ochr_cat_agreements_token_hash_key') AS idx`)
    expect(idx).not.toBeNull()
    expect((await triggerOids()).map(r => r.tgname)).toEqual([...TRIGGERS].sort())
  })
})
