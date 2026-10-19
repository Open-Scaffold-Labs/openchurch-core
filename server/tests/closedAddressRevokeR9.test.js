// Jarvis R9: migration 119 enables RLS on ochr_closed_address_suppressions
// but, unlike 113, never revoked the Supabase data-API roles. It now does.
// Local throwaway cluster: creates the 'anon' role if missing.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import 'dotenv/config'
import pool from '../src/db.js'
import { migrateOnce } from './support/harness.js'
import { up } from '../src/migrations/119-closed-address-suppression.js'

beforeAll(async () => {
  await migrateOnce()
  await pool.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF; END $$`)
  await pool.query('GRANT SELECT, INSERT ON ochr_closed_address_suppressions TO anon')
}, 60_000)
afterAll(async () => { await pool.end() })

describe('119 revokes data-API grants', () => {
  it('anon has no privilege on the suppression table after the migration', async () => {
    const before = await pool.query(`SELECT has_table_privilege('anon', 'ochr_closed_address_suppressions', 'SELECT') AS p`)
    expect(before.rows[0].p).toBe(true)
    await up()
    const after = await pool.query(
      `SELECT has_table_privilege('anon', 'ochr_closed_address_suppressions', 'SELECT') AS s,
              has_table_privilege('anon', 'ochr_closed_address_suppressions', 'INSERT') AS i`)
    expect(after.rows[0]).toEqual({ s: false, i: false })
  })
})
