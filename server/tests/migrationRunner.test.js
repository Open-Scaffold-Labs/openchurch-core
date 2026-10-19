// The migration runner's two promises, pinned against a real database:
//
//   1. Runs serialise. Two boots, two CI jobs, or a `node --watch` restart
//      must not interleave the chain, and must not leave anyone holding the
//      advisory lock once they are done.
//   2. Progress persists. A failure in migration N leaves the ledger rows
//      for 1..N-1 in place, so the re-run after the cause is fixed resumes
//      at N rather than replaying the chain (and its one-shot backfills).
//
// WHAT THIS FILE CANNOT SEE. The lock used to be a SESSION lock taken on a
// pinned client and released on the same client. Through a transaction-mode
// pooler (Supabase's 6543) a pinned client's backend changes between
// statements whenever other traffic exists, so the unlock landed on the
// wrong backend, returned false, and the lock stayed with an idle pooled
// backend — the NEXT runner then hung indefinitely (reproduced through
// PgBouncer 1.22, 8 Sep). The runner now holds the lock inside one open
// transaction, which a transaction pooler pins to one backend by
// construction. These tests run on a direct connection, where the old code
// also passed; the PgBouncer probe in the 8 Sep release notes is the
// evidence for the pooler. What is pinned here is that the fix costs
// nothing on a direct connection: serialisation, no leak, and resumability
// behave exactly as before.
//
// THE DATABASE. Every test here needs a FRESH schema, and the suite runs
// its files in parallel against one DATABASE_URL, so this file works in a
// scratch database of its own, created beside the configured one and
// dropped at the end. db.js binds its pool to DATABASE_URL at import time,
// which is why the runner is imported dynamically after the URL is swapped.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import pg from 'pg'
import 'dotenv/config'

import { MIGRATION_NAMES } from '../src/migrations/names.js'

// Same constant as migrations/index.js. Duplicated on purpose: the test
// should notice if the key ever changes underneath the deploy scripts.
const MIGRATION_LOCK_KEY = 727274

const baseUrl = process.env.DATABASE_URL
const scratchName = `${new URL(baseUrl).pathname.slice(1)}_mr_${Date.now().toString(36)}`
const scratchUrl = (() => { const u = new URL(baseUrl); u.pathname = `/${scratchName}`; return u.toString() })()

let admin, pool, runAllMigrations

beforeAll(async () => {
  admin = new pg.Client({ connectionString: baseUrl })
  await admin.connect()
  await admin.query(`CREATE DATABASE "${scratchName}"`)
  process.env.DATABASE_URL = scratchUrl
  ;({ default: pool } = await import('../src/db.js'))
  ;({ runAllMigrations } = await import('../src/migrations/index.js'))
}, 60_000)

afterAll(async () => {
  await pool?.end()
  if (admin) {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [scratchName]).catch(() => {})
    await admin.query(`DROP DATABASE IF EXISTS "${scratchName}"`).catch(() => {})
    await admin.end()
  }
})

// Back to "never migrated": no tables, no ledger, no lock, no state.
async function freshSchema() {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
}

const ledgerNames = async () =>
  (await pool.query('SELECT name FROM ochr_schema_migrations ORDER BY name')).rows.map(r => r.name)

// Advisory locks in PostgreSQL are PER DATABASE: pg_locks.database is the oid
// of the database a lock lives in, and two databases hold key 727274
// independently without seeing each other.
//
// pg_locks is nonetheless a cluster-wide view, so an unscoped count answers a
// question nobody asked — "is anything, anywhere on this server, holding this
// key" — and this file runs in a scratch database of its own while the other
// 26 files in the parallel suite migrate the configured one. Measured while
// the suite ran (10 Sep): key 727274 held in TWO databases at once, up to 2
// holders in this file's scratch database and up to 8 in the suite's, and the
// assertion failed with exactly `expected 8 to be +0`. Those eight were real
// migrations doing their job in a database this test does not own.
//
// So the count is scoped the way the idle-in-transaction probe below always
// was — to current_database(), via the oid rather than a name comparison, so
// it stays right if a database is ever renamed underneath a run.
//
// This does NOT weaken the invariant. A lock leaked by the runner would be
// held in this database and is still counted; 'a real leak is still caught'
// below takes one deliberately and proves this probe sees it.
const advisoryHolders = async () =>
  (await pool.query(
    `SELECT count(*)::int AS n
       FROM pg_locks
      WHERE locktype = 'advisory'
        AND objid = $1
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
    [MIGRATION_LOCK_KEY])).rows[0].n

const idleInTransaction = async () =>
  (await pool.query(
    `SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND state = 'idle in transaction'`)).rows[0].n

describe('the migration runner', () => {
  it('serialises two concurrent runs on a fresh database and records each migration once', async () => {
    await freshSchema()
    const both = await Promise.allSettled([runAllMigrations(), runAllMigrations()])
    expect(both.map(r => r.status)).toEqual(['fulfilled', 'fulfilled'])

    const names = await ledgerNames()
    expect(names).toEqual([...MIGRATION_NAMES].sort())
    const { rows: dupes } = await pool.query(
      `SELECT name FROM ochr_schema_migrations GROUP BY name HAVING count(*) > 1`)
    expect(dupes).toEqual([])
  }, 120_000)

  it('leaves no advisory lock and no open transaction behind', async () => {
    await runAllMigrations()
    expect(await advisoryHolders()).toBe(0)
    expect(await idleInTransaction()).toBe(0)
  }, 60_000)

  it('a real leak is still caught: the probe sees a lock held in THIS database', async () => {
    // Scoping the count to current_database() is only correct if it still
    // fails on the thing it exists to catch. So take the migration key
    // deliberately, in this database, on a connection of our own — a SESSION
    // lock, which is exactly the shape the runner used to leak before it moved
    // to pg_advisory_xact_lock — and require the probe to report it.
    //
    // Without this, "scoped correctly" and "blind" look identical from the
    // green tick above.
    expect(await advisoryHolders()).toBe(0)

    const leaker = new pg.Client({ connectionString: scratchUrl })
    await leaker.connect()
    try {
      await leaker.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY])
      expect(await advisoryHolders()).toBe(1)
    } finally {
      await leaker.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {})
      await leaker.end().catch(() => {})
    }

    // and released again, so this test leaves the database as it found it
    expect(await advisoryHolders()).toBe(0)
  }, 60_000)

  it('keeps the ledger rows for the migrations before a failing one, and resumes after the cause is removed', async () => {
    await freshSchema()
    // Make 099 fail on its own DDL and nothing else: an event trigger that
    // refuses exactly the CREATE TABLE of ochr_period_adjustments. Anything
    // earlier in the chain is untouched.
    await pool.query(`
      CREATE FUNCTION zz_mr_refuse_099() RETURNS event_trigger LANGUAGE plpgsql AS $$
      DECLARE r record;
      BEGIN
        FOR r IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
          IF r.object_identity = 'public.ochr_period_adjustments' THEN
            RAISE EXCEPTION 'zz_mr: refusing % on %', r.command_tag, r.object_identity;
          END IF;
        END LOOP;
      END $$;
      CREATE EVENT TRIGGER zz_mr_refuse_099 ON ddl_command_end
        WHEN TAG IN ('CREATE TABLE') EXECUTE FUNCTION zz_mr_refuse_099();
    `)

    await expect(runAllMigrations()).rejects.toThrow(/zz_mr: refusing/)

    // Every migration before 099 is recorded; 099 is not. That is what lets
    // the next run resume instead of replaying the chain.
    const after = await ledgerNames()
    // Everything BEFORE the failing migration — not "everything except it".
    // The chain halts at 099, so nothing after it runs either. Filtering only
    // 099 out silently assumed 099 was last, and broke the day 100 arrived.
    const failed = MIGRATION_NAMES.indexOf('099-period-adjustments')
    const expected = MIGRATION_NAMES.slice(0, failed)
    expect(after).toEqual([...expected].sort())
    expect(after).not.toContain('099-period-adjustments')
    // ...and the failure released the lock rather than leaking it.
    expect(await advisoryHolders()).toBe(0)
    expect(await idleInTransaction()).toBe(0)

    await pool.query('DROP EVENT TRIGGER zz_mr_refuse_099; DROP FUNCTION zz_mr_refuse_099()')
    await runAllMigrations()
    expect(await ledgerNames()).toEqual([...MIGRATION_NAMES].sort())
    expect(await advisoryHolders()).toBe(0)
  }, 120_000)
})


// ---------------------------------------------------------------------------
// The optional App Review seed is not schema (2026-09-24).
//
// Before: `await seedAppReviewTenant(pool)` sat inside the lock transaction
// after the ledger check, unguarded. Every refusal except flag_off threw
// AFTER every migration had applied and been ledgered, so the CLI printed
// "Migration failed" / boot printed "FATAL: migrations failed" and exited 1
// on a schema that was fine. Now the seed runs after COMMIT, its outcome is
// returned and reported on its own, and migration success means exactly
// that the migrations succeeded.
// ---------------------------------------------------------------------------

describe('the App Review seed after migrations', () => {
  const tag = Date.now().toString(36)
  const seedEnv = (over = {}) => ({
    NODE_ENV: 'test',
    DATABASE_URL: scratchUrl,
    SEED_APP_REVIEW_TENANT: '1',
    APP_REVIEW_EMAIL: `mr_review_${tag}@example.com`,
    APP_REVIEW_PASSWORD: `mr-review-pw-${tag}`,
    APP_REVIEW_ORG_NAME: `MR Review ${tag}`,
    APP_REVIEW_ORG_SLUG: `mr-review-${tag}`,
    ...over,
  })
  const orgBySlug = async slug =>
    (await pool.query('SELECT id FROM ochr_organizations WHERE slug = $1', [slug])).rows

  async function expectCleanSchemaRun() {
    expect(await ledgerNames()).toEqual([...MIGRATION_NAMES].sort())
    expect(await advisoryHolders()).toBe(0)
    expect(await idleInTransaction()).toBe(0)
  }

  it('flag off: migrations succeed, the seed is skipped silently, nothing is written', async () => {
    await freshSchema()
    const errSpy = vi.spyOn(console, 'error')
    try {
      const out = await runAllMigrations({ appReviewEnv: seedEnv({ SEED_APP_REVIEW_TENANT: undefined }) })
      expect(out.appReviewSeed).toEqual({ status: 'skipped', reason: 'flag_off' })
      expect(errSpy.mock.calls.flat().join('\n')).not.toMatch(/APP REVIEW SEED/)
    } finally {
      errSpy.mockRestore()
    }
    await expectCleanSchemaRun()
    expect(await orgBySlug(seedEnv().APP_REVIEW_ORG_SLUG)).toEqual([])
  }, 120_000)

  it('requested valid seed: migrations succeed and the sandbox is created', async () => {
    const out = await runAllMigrations({ appReviewEnv: seedEnv() })
    expect(out.appReviewSeed).toMatchObject({ status: 'created', organizationSlug: seedEnv().APP_REVIEW_ORG_SLUG })
    await expectCleanSchemaRun()
    expect(await orgBySlug(seedEnv().APP_REVIEW_ORG_SLUG)).toHaveLength(1)

    // A second run with the same env: whatever the seed decides about an
    // existing slug is the seed's contract (tests/appReviewTenant.test.js).
    // The runner's contract is only that the schema run still resolves
    // cleanly and the outcome comes back as data, not as a throw.
    const again = await runAllMigrations({ appReviewEnv: seedEnv() })
    expect(again.appReviewSeed.status).not.toBe('created')
    await expectCleanSchemaRun()
    expect(await orgBySlug(seedEnv().APP_REVIEW_ORG_SLUG)).toHaveLength(1)
  }, 120_000)

  it('requested but refused seed: migrations still RESOLVE, the refusal is loud and returned', async () => {
    const errSpy = vi.spyOn(console, 'error')
    let out
    try {
      out = await runAllMigrations({
        appReviewEnv: seedEnv({
          APP_REVIEW_ORG_SLUG: `mr-refused-${tag}`,
          DATABASE_URL: 'postgresql://postgres:x@db.example.com:5432/openchurch',
        }),
      })
      const printed = errSpy.mock.calls.flat().join('\n')
      expect(printed).toMatch(/APP REVIEW SEED REFUSED: remote_refused/)
      expect(printed).toMatch(/schema migrations above completed and are ledgered/)
    } finally {
      errSpy.mockRestore()
    }
    expect(out.appReviewSeed).toMatchObject({ status: 'refused', reason: 'remote_refused' })
    await expectCleanSchemaRun()
    expect(await orgBySlug(`mr-refused-${tag}`)).toEqual([])
  }, 120_000)

  it('seed collision: the email belongs to another org — refused, schema run unaffected', async () => {
    const out = await runAllMigrations({
      appReviewEnv: seedEnv({ APP_REVIEW_ORG_SLUG: `mr-collide-${tag}` }),
    })
    expect(out.appReviewSeed).toMatchObject({ status: 'refused', reason: 'email_in_other_org' })
    await expectCleanSchemaRun()
    // Whether the seed leaves anything behind on refusal is the seed's own
    // contract (tests/appReviewTenant.test.js), not the runner's. This file
    // pins only that a seed refusal is not a migration failure.
  }, 120_000)

  it('seed hard failure (the database refuses the write): migrations still resolve, reported as failed', async () => {
    const failEmail = `mr_fail_${tag}@example.com`
    await pool.query(`
      CREATE FUNCTION zz_mr_refuse_review() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.email = '${failEmail}' THEN RAISE EXCEPTION 'zz_mr: refusing review user'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER zz_mr_refuse_review BEFORE INSERT ON ochr_users
        FOR EACH ROW EXECUTE FUNCTION zz_mr_refuse_review();
    `)
    const errSpy = vi.spyOn(console, 'error')
    let out
    try {
      out = await runAllMigrations({
        appReviewEnv: seedEnv({ APP_REVIEW_EMAIL: failEmail, APP_REVIEW_ORG_SLUG: `mr-fail-${tag}` }),
      })
      expect(errSpy.mock.calls.flat().join('\n')).toMatch(/APP REVIEW SEED FAILED/)
    } finally {
      errSpy.mockRestore()
      await pool.query('DROP TRIGGER zz_mr_refuse_review ON ochr_users; DROP FUNCTION zz_mr_refuse_review()')
    }
    expect(out.appReviewSeed).toMatchObject({ status: 'failed' })
    expect(out.appReviewSeed.message).toMatch(/zz_mr: refusing review user/)
    await expectCleanSchemaRun()
  }, 120_000)

  it('a real migration failure still rejects — the seed separation does not swallow schema errors', async () => {
    await freshSchema()
    await pool.query(`
      CREATE FUNCTION zz_mr_refuse_099b() RETURNS event_trigger LANGUAGE plpgsql AS $$
      DECLARE r record;
      BEGIN
        FOR r IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
          IF r.object_identity = 'public.ochr_period_adjustments' THEN
            RAISE EXCEPTION 'zz_mr_b: refusing %', r.object_identity;
          END IF;
        END LOOP;
      END $$;
      CREATE EVENT TRIGGER zz_mr_refuse_099b ON ddl_command_end
        WHEN TAG IN ('CREATE TABLE') EXECUTE FUNCTION zz_mr_refuse_099b();
    `)
    try {
      await expect(runAllMigrations({ appReviewEnv: seedEnv({ APP_REVIEW_ORG_SLUG: `mr-never-${tag}` }) }))
        .rejects.toThrow(/zz_mr_b: refusing/)
      expect(await advisoryHolders()).toBe(0)
    } finally {
      await pool.query('DROP EVENT TRIGGER zz_mr_refuse_099b; DROP FUNCTION zz_mr_refuse_099b()')
    }
    // the seed never ran on a failed schema run
    const exists = (await pool.query(`SELECT to_regclass('public.ochr_organizations') AS t`)).rows[0].t
    if (exists) expect(await orgBySlug(`mr-never-${tag}`)).toEqual([])
    await runAllMigrations()
    await expectCleanSchemaRun()
  }, 120_000)
})
