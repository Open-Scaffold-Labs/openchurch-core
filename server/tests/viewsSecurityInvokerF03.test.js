// F-03: every public view runs as security_invoker, and API roles (when
// present) hold no grant on them. Local database only.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import 'dotenv/config'
import pool from '../src/db.js'
import { migrateOnce } from './support/harness.js'
import { INVOKER_VIEWS } from '../src/migrations/118-views-security-invoker.js'

beforeAll(async () => { await migrateOnce() }, 60_000)
afterAll(async () => { await pool.end() })

describe('F-03 views run with caller privileges', () => {
  it('every view in public has security_invoker=true (catches a later CREATE OR REPLACE that drops it)', async () => {
    const { rows } = await pool.query(`
      SELECT c.relname, coalesce(c.reloptions, '{}') AS opts
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'v'`)
    const names = rows.map(r => r.relname)
    for (const v of INVOKER_VIEWS) expect(names).toContain(v)
    for (const r of rows) {
      expect(r.opts, r.relname).toContain('security_invoker=true')
    }
  })

  it('anon/authenticated (if present) cannot select the views', async () => {
    const { rows: roles } = await pool.query(
      `SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated')`)
    for (const { rolname } of roles) {
      for (const v of INVOKER_VIEWS) {
        const { rows: [p] } = await pool.query(
          `SELECT has_table_privilege($1, $2, 'SELECT') AS ok`, [rolname, `public.${v}`])
        expect(p.ok, `${rolname} on ${v}`).toBe(false)
      }
    }
  })

  // R286 evidence note: the test above is vacuous where anon/authenticated
  // do not exist (this local cluster). This one exercises invoker semantics
  // with a DISPOSABLE non-owner role inside a rolled-back transaction: the
  // role may read the view itself but not its base tables, so a
  // security_invoker view must refuse it. Local-only; says nothing about
  // production grants or RLS.
  it('a disposable non-owner role granted only the view is refused (invoker, not owner, privileges)', async () => {
    const client = await pool.connect()
    try {
      for (const v of INVOKER_VIEWS) {
        await client.query('BEGIN')
        try {
          const role = `f03_probe_${process.pid}`
          await client.query(`CREATE ROLE ${role} NOLOGIN`)
          await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`)
          await client.query(`GRANT SELECT ON public.${v} TO ${role}`)
          await client.query(`SET LOCAL ROLE ${role}`)
          await expect(client.query(`SELECT 1 FROM public.${v} LIMIT 1`), v).rejects.toMatchObject({ code: '42501' })
        } finally {
          await client.query('ROLLBACK')
        }
      }
    } finally { client.release() }
  })
})
