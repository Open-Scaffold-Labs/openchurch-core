// F-02: the public demo1234 admin. Seeding the default password is local-
// only, and migration 117's neutralizer makes an existing demo admin
// unusable without deleting it. The neutralizer is exercised inside a
// transaction that is ROLLED BACK so the shared local demo login survives.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import 'dotenv/config'

import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { resolveDemoPassword, PUBLIC_DEMO_PASSWORD } from '../src/migrate.js'
import { neutralizeDemoAdmin, shouldNeutralizeDemo } from '../src/migrations/117-neutralize-demo-admin.js'

let server, orgId
beforeAll(async () => { await migrateOnce(); server = await bindServer() }, 60_000)
afterAll(async () => {
  if (orgId) await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [orgId]).catch(() => {})
  await closeServer(server); await pool.end()
})

describe('F-02 demo password resolution', () => {
  it('development/test on a local host keeps the documented default', () => {
    expect(resolveDemoPassword({ NODE_ENV: 'development' }, true)).toBe(PUBLIC_DEMO_PASSWORD)
    expect(resolveDemoPassword({ NODE_ENV: 'test' }, true)).toBe(PUBLIC_DEMO_PASSWORD)
    expect(resolveDemoPassword({ NODE_ENV: 'test', DEMO_PASSWORD: 'x-local' }, true)).toBe('x-local')
  })
  it('NODE_ENV unset, staging, or mis-cased production on a LOCAL host refuses demo1234 (ARG-PATCH-3-1)', () => {
    for (const NODE_ENV of [undefined, '', 'staging', 'Production', 'PRODUCTION', 'Development']) {
      expect(resolveDemoPassword({ NODE_ENV }, true), String(NODE_ENV)).toBeNull()
      expect(resolveDemoPassword({ NODE_ENV, DEMO_PASSWORD: 'demo1234' }, true), String(NODE_ENV)).toBeNull()
    }
  })
  it('migration 117 neutralizes everywhere except dev/test on a local host, even with SEED_DEMO=true', () => {
    expect(shouldNeutralizeDemo({ NODE_ENV: 'test' }, true)).toBe(false)
    expect(shouldNeutralizeDemo({ NODE_ENV: 'development' }, true)).toBe(false)
    expect(shouldNeutralizeDemo({ NODE_ENV: 'test', SEED_DEMO: 'true' }, false)).toBe(true)
    expect(shouldNeutralizeDemo({ NODE_ENV: 'development', SEED_DEMO: 'true' }, false)).toBe(true)
    expect(shouldNeutralizeDemo({ SEED_DEMO: 'true' }, true)).toBe(true)
    expect(shouldNeutralizeDemo({ NODE_ENV: 'Production' }, true)).toBe(true)
    expect(shouldNeutralizeDemo({ NODE_ENV: 'staging' }, true)).toBe(true)
  })
  it('remote targets or production refuse the public default', () => {
    expect(resolveDemoPassword({ NODE_ENV: 'test' }, false)).toBeNull()
    expect(resolveDemoPassword({}, false)).toBeNull()
    expect(resolveDemoPassword({ DEMO_PASSWORD: 'demo1234' }, false)).toBeNull()
    expect(resolveDemoPassword({ NODE_ENV: 'production' }, true)).toBeNull()
    expect(resolveDemoPassword({ DEMO_PASSWORD: 'Long-Unique-Secret-9' }, false)).toBe('Long-Unique-Secret-9')
  })
})

describe('F-02 neutralizeDemoAdmin (migration 117)', () => {
  it('deactivates, rotates the hash, bumps token_version, and keeps the row', async () => {
    const email = `f02_demo_${RUN_ID}@example.com`
    const res = await request(server).post('/api/auth/signup').set('X-Forwarded-For', '10.93.1.1')
      .send({ organizationName: `F02 ${RUN_ID}`, name: 'Demo Admin', email, password: 'demo1234' })
    expect(res.status).toBe(201)
    orgId = res.body.user.organization.id
    const id = res.body.user.id
    const { rows: [before] } = await pool.query('SELECT token_version FROM ochr_users WHERE id = $1', [id])

    // Run against a synthetic stand-in address (not the shared local demo row).
    const out = await neutralizeDemoAdmin(pool, email.toUpperCase())
    expect(out.neutralized).toEqual([id])
    const { rows: [after] } = await pool.query(
      'SELECT email, role, deactivated_at, password_hash, token_version, closed_at FROM ochr_users WHERE id = $1', [id])
    expect(after.email).toBe(email)
    expect(after.role).toBe('admin')
    expect(after.closed_at).toBeNull()
    expect(after.deactivated_at).not.toBeNull()
    expect(after.token_version).toBe((before.token_version ?? 1) + 1)
    expect(await bcrypt.compare('demo1234', after.password_hash)).toBe(false)

    // Old token dies, and the old password no longer signs in.
    expect((await request(server).get('/api/auth/me').set('Authorization', `Bearer ${res.body.token}`)).status).toBe(401)
    const login = await request(server).post('/api/auth/login').send({ email, password: 'demo1234' })
    expect(login.status).not.toBe(200)

    // Idempotent: a second run still finds it and leaves it unusable.
    expect((await neutralizeDemoAdmin(pool, email)).neutralized).toEqual([id])
  })

  it('on the real demo address it would hit the seeded row (verified then rolled back)', async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query(`SELECT id FROM ochr_users WHERE email = 'demo@openchurch.app'`)
      const out = await neutralizeDemoAdmin(client)
      expect(out.neutralized).toEqual(rows.map(r => r.id))
    } finally {
      await client.query('ROLLBACK'); client.release()
    }
  })
})

// R286-1: seed eligibility and the 117 neutralizer decide on the EFFECTIVE
// driver target (shared db-target-guard), not the URL authority.
import { targetIsLocal, isDevLocalTarget } from '../src/migrate.js'
import { shouldNeutralizeDemo as shouldNeutralize } from '../src/migrations/117-neutralize-demo-admin.js'

describe('R286-1 effective target resolution (real URLs, no injected booleans)', () => {
  const L = 'postgres://synthetic@127.0.0.1:5432/local'
  const remote = [
    `${L}?host=127.0.0.1&host=db.example.invalid`,
    `${L}?host=db.example.invalid&host=127.0.0.1`,
    `${L}?hostaddr=127.0.0.1&hostaddr=10.0.0.5`,
    `${L}?hostaddr=10.0.0.5&hostaddr=127.0.0.1`,
    `${L}?hostaddr=10.0.0.5`,
    `${L}?host=`,
    'postgres://synthetic@db.example.invalid:5432/x',
    'postgres://synthetic@db.example.invalid/x?host=127.0.0.1',
    'postgres:///x?host=127.0.0.1',           // empty authority
    'postgres://synthetic@/x',                // empty host → driver default
    'socket:/var/run/postgresql?db=x',
    'not a url',
  ]
  it('remote, ambiguous, empty-host and malformed targets are NOT local', () => {
    for (const DATABASE_URL of remote) {
      expect(targetIsLocal({ DATABASE_URL }), DATABASE_URL).toBe(false)
      const env = { NODE_ENV: 'development', DATABASE_URL }
      expect(isDevLocalTarget(env), DATABASE_URL).toBe(false)
      expect(resolveDemoPassword(env), DATABASE_URL).toBeNull()
      expect(resolveDemoPassword({ ...env, SEED_DEMO: 'true', DEMO_PASSWORD: 'demo1234' }), DATABASE_URL).toBeNull()
      expect(shouldNeutralize(env), DATABASE_URL).toBe(true)
    }
  })
  it('a missing DATABASE_URL (driver falls back to PGHOST/default) is NOT local', () => {
    expect(targetIsLocal({})).toBe(false)
    expect(shouldNeutralize({ NODE_ENV: 'test' })).toBe(true)
  })
  it('a remote PGHOST / PGHOSTADDR in the environment makes the target ambiguous → not local', () => {
    expect(targetIsLocal({ DATABASE_URL: L, PGHOST: 'db.example.invalid' })).toBe(false)
    expect(targetIsLocal({ DATABASE_URL: L, PGHOSTADDR: '10.0.0.5' })).toBe(false)
    expect(targetIsLocal({ DATABASE_URL: L, PGHOST: 'localhost' })).toBe(true)
  })
  it('a genuinely loopback target (all overrides loopback) is local only for development/test', () => {
    for (const DATABASE_URL of [L, `${L}?host=127.0.0.1`, `${L}?host=localhost&hostaddr=127.0.0.1`, 'postgres://u@localhost/x', 'postgresql://u@[::1]:5432/x']) {
      expect(targetIsLocal({ DATABASE_URL }), DATABASE_URL).toBe(true)
      expect(shouldNeutralize({ NODE_ENV: 'test', DATABASE_URL }), DATABASE_URL).toBe(false)
      expect(shouldNeutralize({ NODE_ENV: 'production', DATABASE_URL }), DATABASE_URL).toBe(true)
      expect(resolveDemoPassword({ NODE_ENV: 'development', DATABASE_URL })).toBe(PUBLIC_DEMO_PASSWORD)
    }
  })
})
