// Migration 119 (reset PR6) on an isolated real Postgres: the table exists
// with its shape and RLS, a re-run is a no-op (idempotent), and the
// ledger records it as the newest migration after 118.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import 'dotenv/config'
import pool from '../src/db.js'
import { migrateOnce } from './support/harness.js'
import { up } from '../src/migrations/119-closed-address-suppression.js'
import { MIGRATION_NAMES, EXPECTED_MIGRATION } from '../src/migrations/names.js'

beforeAll(async () => { await migrateOnce() }, 60_000)
afterAll(async () => { await pool.end() })

const shape = async () => (await pool.query(
  `SELECT column_name, data_type, is_nullable FROM information_schema.columns
    WHERE table_name = 'ochr_closed_address_suppressions' ORDER BY ordinal_position`)).rows

describe('119-closed-address-suppression', () => {
  it('is the expected migration, directly after 118; 116-118 unchanged', () => {
    expect(EXPECTED_MIGRATION).toBe('119-closed-address-suppression')
    const i = MIGRATION_NAMES.indexOf('119-closed-address-suppression')
    expect(MIGRATION_NAMES.slice(i - 3, i)).toEqual([
      '116-stage7-ai-stop-and-plaintext-guard', '117-neutralize-demo-admin', '118-views-security-invoker'])
  })
  it('applied by the chain: ledger row, columns, PK, RLS, hash check', async () => {
    const led = await pool.query(`SELECT 1 FROM ochr_schema_migrations WHERE name = '119-closed-address-suppression'`)
    expect(led.rows).toHaveLength(1)
    expect((await shape()).map(c => c.column_name)).toEqual(['organization_id', 'email_sha256', 'closed_at'])
    const rls = await pool.query(`SELECT relrowsecurity FROM pg_class WHERE relname = 'ochr_closed_address_suppressions'`)
    expect(rls.rows[0].relrowsecurity).toBe(true)
    const org = await pool.query(`INSERT INTO ochr_organizations (name, slug) VALUES ('m119 probe', 'm119-probe-' || floor(random()*1e9)::text) RETURNING id`)
    await expect(pool.query(`INSERT INTO ochr_closed_address_suppressions (organization_id, email_sha256) VALUES ($1, 'plain@address')`, [org.rows[0].id])).rejects.toThrow()
    await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [org.rows[0].id])
  })
  it('carries the Stage 6 HOLD write guard: a held parish cannot gain a suppression row', async () => {
    const t = await pool.query(`SELECT 1 FROM pg_trigger WHERE tgrelid = 'ochr_closed_address_suppressions'::regclass AND tgname = 'ochr_organization_hold_guard'`)
    expect(t.rows).toHaveLength(1)
    const org = await pool.query(`INSERT INTO ochr_organizations (name, slug) VALUES ('m119 held', 'm119-held-' || floor(random()*1e9)::text) RETURNING id`)
    await pool.query('UPDATE ochr_organizations SET held_at = NOW() WHERE id = $1', [org.rows[0].id])
    await expect(pool.query(`INSERT INTO ochr_closed_address_suppressions (organization_id, email_sha256) VALUES ($1, $2)`, [org.rows[0].id, 'b'.repeat(64)]))
      .rejects.toThrow(/on hold/)
  })
  it('re-running up() is idempotent and keeps existing rows', async () => {
    const org = await pool.query(`INSERT INTO ochr_organizations (name, slug) VALUES ('m119 idem', 'm119-idem-' || floor(random()*1e9)::text) RETURNING id`)
    const h = 'a'.repeat(64)
    await pool.query(`INSERT INTO ochr_closed_address_suppressions (organization_id, email_sha256) VALUES ($1, $2)`, [org.rows[0].id, h])
    const before = await shape()
    await up(); await up()
    expect(await shape()).toEqual(before)
    const kept = await pool.query('SELECT 1 FROM ochr_closed_address_suppressions WHERE organization_id = $1 AND email_sha256 = $2', [org.rows[0].id, h])
    expect(kept.rows).toHaveLength(1)
    await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [org.rows[0].id])
  })
})
