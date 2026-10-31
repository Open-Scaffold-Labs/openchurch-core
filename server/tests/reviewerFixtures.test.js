// Reviewer fixture seed: local Postgres only, synthetic parish, no remote override.

import { spawnSync } from 'node:child_process'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import 'dotenv/config'
import pool from '../src/db.js'
import { RUN_ID, migrateOnce } from './support/harness.js'
import { assertReviewerFixtureTarget, resolveReviewerFixture } from '../src/seed/reviewerFixtureGuard.js'
import { seedReviewerFixtures } from '../src/seed/reviewerFixtures.js'

const LOCAL = 'postgresql://postgres@127.0.0.1:5433/openchurch_local'
const SCRIPT = new URL('../scripts/seed-reviewer-fixtures.js', import.meta.url)

function creds(suffix, url = LOCAL) {
  const id = `${suffix}-${RUN_ID}`.replace(/_/g, '-').slice(0, 40)
  return {
    NODE_ENV: 'test',
    VERCEL_ENV: '',
    DATABASE_URL: url,
    PGHOST: '',
    PGHOSTADDR: '',
    REVIEWER_FIXTURE_EMAIL: `reviewer-${id}@example.com`,
    REVIEWER_FIXTURE_PASSWORD: `reviewer-pass-${id}-long`,
    REVIEWER_FIXTURE_ORG_NAME: `Synthetic Reviewer Parish ${id}`,
    REVIEWER_FIXTURE_ORG_SLUG: `reviewer-fixture-${id}`.slice(0, 60),
    REVIEWER_FIXTURE_USER_NAME: 'Synthetic Reviewer',
    APP_REVIEW_ALLOW_REMOTE: '1',
    DEMO_EMAIL: '',
    DEMO_PASSWORD: '',
  }
}

beforeAll(async () => {
  await migrateOnce()
}, 60_000)

afterAll(async () => {
  await pool.end()
})

describe('reviewer fixture target gate', () => {
  it('refuses a remote URL before any query', async () => {
    const db = { query() { throw new Error('query was called') } }
    await expect(seedReviewerFixtures(db, creds('remote', 'postgresql://postgres@db.example.com:5432/openchurch')))
      .rejects.toMatchObject({ reason: 'remote_refused' })
  })

  it('refuses a loopback URL whose host override is remote', () => {
    const resolved = assertReviewerFixtureTarget(creds('override', `${LOCAL}?host=db.example.com`))
    expect(resolved).toEqual({ ok: false, reason: 'remote_refused' })
  })

  it('refuses a non-loopback PGHOST even when the URL is loopback', () => {
    const resolved = assertReviewerFixtureTarget({ ...creds('pghost'), PGHOST: 'db.example.com' })
    expect(resolved).toEqual({ ok: false, reason: 'remote_refused' })
  })

  it('refuses production even on a loopback URL', () => {
    expect(assertReviewerFixtureTarget({ ...creds('prod'), NODE_ENV: 'production' }))
      .toEqual({ ok: false, reason: 'production' })
    expect(assertReviewerFixtureTarget({ ...creds('vercel'), VERCEL_ENV: 'production' }))
      .toEqual({ ok: false, reason: 'production' })
  })

  it('does not honor APP_REVIEW_ALLOW_REMOTE', () => {
    const resolved = assertReviewerFixtureTarget(creds('allow', 'postgresql://postgres@db.example.com/openchurch'))
    expect(resolved.reason).toBe('remote_refused')
  })

  it('refuses a missing URL', () => {
    expect(assertReviewerFixtureTarget({ ...creds('missing'), DATABASE_URL: '' }).reason).toBe('remote_refused')
  })

  it('refuses the public demo pair and has no credential defaults', () => {
    expect(resolveReviewerFixture({ ...creds('nodemo'), REVIEWER_FIXTURE_EMAIL: 'demo@openchurch.app' }).reason)
      .toBe('demo_email_forbidden')
    expect(resolveReviewerFixture({ ...creds('nopw'), REVIEWER_FIXTURE_PASSWORD: 'demo1234' }).reason)
      .toBe('demo_password_forbidden')
    expect(resolveReviewerFixture({ ...creds('noslug'), REVIEWER_FIXTURE_ORG_SLUG: 'demo-church' }).reason)
      .toBe('demo_slug_forbidden')
    const bare = resolveReviewerFixture({ ...creds('bare'), REVIEWER_FIXTURE_EMAIL: '', REVIEWER_FIXTURE_PASSWORD: '', REVIEWER_FIXTURE_ORG_NAME: '' })
    expect(bare).toEqual({ ok: false, reason: 'missing_env' })
  })

  it('the CLI exits 2 on a remote URL without waiting on the network', () => {
    const r = spawnSync(process.execPath, [SCRIPT.pathname], {
      encoding: 'utf8',
      timeout: 8000,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://postgres@db.example.com:5432/openchurch',
        REVIEWER_FIXTURE_EMAIL: 'reviewer@example.com',
        REVIEWER_FIXTURE_PASSWORD: 'reviewer-pass-long',
        REVIEWER_FIXTURE_ORG_NAME: 'Synthetic Reviewer Parish',
      },
    })
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('remote_refused')
    expect(r.stdout).not.toContain('Created synthetic parish')
  })
})

const canWrite = assertReviewerFixtureTarget(process.env).ok

describe('reviewer fixture rows', () => {
  it.skipIf(!canWrite)('inserts a synthetic parish and rolls it back by deleting that org only', async () => {
    const env = { ...process.env, ...creds('rows', process.env.DATABASE_URL) }
    let orgId = null
    const client = await pool.connect()
    try {
      const result = await seedReviewerFixtures(client, env)
      orgId = result.organizationId
      expect(result.seeded).toBe(true)
      expect(result.counts.members).toBe(3)
      expect(result.counts.register).toBe(1)
      expect(result.counts.intentions).toBe(1)
      expect(result.counts.sacristy).toBeGreaterThanOrEqual(1)
      expect(result.counts.checkins).toBe(1)
      expect(result.counts.events).toBe(1)

      const checkin = await pool.query(
        `SELECT security_code, security_code_hash, kind
           FROM ochr_checkins WHERE organization_id = $1`,
        [orgId],
      )
      expect(checkin.rows).toHaveLength(1)
      expect(checkin.rows[0].kind).toBe('child')
      expect(checkin.rows[0].security_code).toBeNull()
      expect(checkin.rows[0].security_code_hash).toEqual(expect.any(String))

      const register = await pool.query(
        `SELECT member_name, certificate_no FROM ochr_sacramental_records WHERE organization_id = $1`,
        [orgId],
      )
      expect(register.rows[0].member_name).toBe('Synthetic Luis Example')
      expect(register.rows[0].certificate_no).toBe('SYN-B-0001')

      const other = await pool.query(
        `SELECT COUNT(*)::int AS n FROM ochr_sacramental_records
          WHERE certificate_no = 'SYN-B-0001' AND organization_id <> $1`,
        [orgId],
      )
      expect(other.rows[0].n).toBe(0)
    } finally {
      client.release()
      if (orgId) await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [orgId])
    }
  })

  it('refuses a bare pool before any query (R378-1)', async () => {
    const env = { ...process.env, ...creds('pool', LOCAL) }
    const fakePool = { query() { throw new Error('pool.query was called') }, connect() {} }
    await expect(seedReviewerFixtures(fakePool, env)).rejects.toMatchObject({ reason: 'needs_reserved_client' })
  })

  it.skipIf(!canWrite)('runs every statement on the reserved client and rolls back a mid-seed failure (R378-1)', async () => {
    const env = { ...process.env, ...creds('rollback', process.env.DATABASE_URL) }
    const client = await pool.connect()
    const poolQuery = pool.query
    let poolCalls = 0
    pool.query = (...a) => { poolCalls += 1; return poolQuery.apply(pool, a) }
    const seen = []
    let inserts = 0
    const spy = {
      release: () => {},
      query(sql, params) {
        const text = String(sql).trim()
        seen.push(text.split(/\s+/)[0].toUpperCase())
        if (/^INSERT/i.test(text)) {
          inserts += 1
          if (inserts === 3) return Promise.reject(new Error('injected mid-seed failure'))
        }
        return client.query(sql, params)
      },
    }
    try {
      await expect(seedReviewerFixtures(spy, env)).rejects.toThrow('injected mid-seed failure')
    } finally {
      pool.query = poolQuery
      client.release()
    }
    expect(poolCalls).toBe(0)
    expect(seen[0]).toBe('BEGIN')
    expect(seen).toContain('ROLLBACK')
    expect(seen).not.toContain('COMMIT')
    expect(inserts).toBeGreaterThanOrEqual(3)
    const org = await pool.query('SELECT id FROM ochr_organizations WHERE slug = $1', [env.REVIEWER_FIXTURE_ORG_SLUG])
    expect(org.rows).toHaveLength(0)
    const user = await pool.query('SELECT id FROM ochr_users WHERE lower(email) = $1', [env.REVIEWER_FIXTURE_EMAIL.toLowerCase()])
    expect(user.rows).toHaveLength(0)
    const child = await pool.query(`SELECT COUNT(*)::int AS n FROM ochr_sacramental_records WHERE member_name = 'Synthetic Luis Example' AND certificate_no = 'SYN-B-0001'`)
    expect(child.rows[0].n).toBe(0)
  })
})
