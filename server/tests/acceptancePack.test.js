// iOS acceptance-pack seed: disposable local Postgres only, dry-run default,
// bilingual, least-privilege viewer login, bulletin. No remote override. No
// production override. Ordinary local DBs (openchurch_local) refused. Fake
// data only.

import { spawnSync } from 'node:child_process'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import 'dotenv/config'
import pool from '../src/db.js'
import { RUN_ID, migrateOnce } from './support/harness.js'
import { classifyDatabaseUrl } from '../../scripts/lib/db-target-guard.mjs'
import {
  assertAcceptancePackTarget,
  assertAcceptancePackMarker,
  resolveAcceptancePack,
  acceptancePackPlan,
  acceptancePackDatabaseName,
  isDisposableAcceptancePackDatabaseName,
  acceptancePackMarkerDdl,
  ACCEPTANCE_PACK_MARKER_TOKEN,
} from '../src/seed/acceptancePackGuard.js'
import { seedAcceptancePack } from '../src/seed/acceptancePack.js'

const ORDINARY_LOCAL = 'postgresql://postgres@127.0.0.1:5433/openchurch_local'
const DISPOSABLE = 'postgresql://postgres@127.0.0.1:5433/openchurch_acceptance_pack'
const SCRIPT = new URL('../scripts/seed-acceptance-pack.js', import.meta.url)
const PREPARE = new URL('../scripts/prepare-acceptance-pack-db.js', import.meta.url)
const MIGRATE = new URL('../src/migrate-cli.js', import.meta.url)

/** Pre-fix loopback-only gate (the bug TARS found on #475 @ 0d8657e5). */
function legacyAssertAcceptancePackTargetLoopbackOnly(env = process.env) {
  if (env.NODE_ENV === 'production' || env.VERCEL_ENV === 'production') {
    return { ok: false, reason: 'production' }
  }
  for (const key of ['PGHOST', 'PGHOSTADDR']) {
    const value = env[key]
    if (value == null || String(value).trim() === '') continue
    const host = String(value).trim()
    if (!(host === 'localhost' || host === '127.0.0.1' || host === '::1')) {
      return { ok: false, reason: 'remote_refused' }
    }
  }
  const cls = classifyDatabaseUrl(env.DATABASE_URL)
  if (cls.kind !== 'local') {
    return { ok: false, reason: 'remote_refused' }
  }
  return { ok: true, reason: 'local' }
}

function creds(suffix, url = DISPOSABLE, extra = {}) {
  const id = `${suffix}-${RUN_ID}`.replace(/_/g, '-').slice(0, 40)
  return {
    NODE_ENV: 'test',
    VERCEL_ENV: '',
    DATABASE_URL: url,
    PGHOST: '',
    PGHOSTADDR: '',
    ACCEPTANCE_PACK_EMAIL: `reviewer-ap-${id}@example.com`,
    ACCEPTANCE_PACK_PASSWORD: `acceptance-pass-${id}-long`,
    ACCEPTANCE_PACK_ORG_NAME: `Synthetic Acceptance Parish ${id}`,
    ACCEPTANCE_PACK_ORG_SLUG: `acceptance-pack-${id}`.slice(0, 60),
    ACCEPTANCE_PACK_USER_NAME: 'Synthetic Reviewer',
    ACCEPTANCE_PACK_APPLY: '',
    APP_REVIEW_ALLOW_REMOTE: '1',
    DEMO_EMAIL: '',
    DEMO_PASSWORD: '',
    ...extra,
  }
}

beforeAll(async () => {
  await migrateOnce()
}, 60_000)

afterAll(async () => {
  await pool.end()
})

describe('acceptance pack disposable identity (TARS #475)', () => {
  it('old loopback-only guard would accept openchurch_local; new guard refuses it', () => {
    const env = creds('ordinary', ORDINARY_LOCAL)
    // RED on the pre-fix guard (loopback was enough — TARS finding).
    expect(legacyAssertAcceptancePackTargetLoopbackOnly(env)).toEqual({ ok: true, reason: 'local' })
    // GREEN on the disposable-identity guard.
    expect(assertAcceptancePackTarget(env)).toEqual({
      ok: false,
      reason: 'ordinary_local_refused',
    })
  })

  it('refuses applying to openchurch_local before any query', async () => {
    const db = { query() { throw new Error('query was called') }, release() {} }
    await expect(seedAcceptancePack(db, creds('apply-local', ORDINARY_LOCAL, {
      ACCEPTANCE_PACK_APPLY: '1',
    }))).rejects.toMatchObject({ reason: 'ordinary_local_refused' })
  })

  it('accepts a disposable openchurch_acceptance_* name at the target gate', () => {
    const gate = assertAcceptancePackTarget(creds('disp', DISPOSABLE))
    expect(gate).toEqual({
      ok: true,
      reason: 'local_disposable',
      databaseName: 'openchurch_acceptance_pack',
    })
    expect(isDisposableAcceptancePackDatabaseName('openchurch_acceptance_pack')).toBe(true)
    expect(isDisposableAcceptancePackDatabaseName('openchurch_acceptance_ci_abc')).toBe(true)
    expect(isDisposableAcceptancePackDatabaseName('openchurch_local')).toBe(false)
    expect(isDisposableAcceptancePackDatabaseName('Openchurch_acceptance_pack')).toBe(false)
    expect(acceptancePackDatabaseName(ORDINARY_LOCAL)).toBe('openchurch_local')
  })

  it('apply refuses an unmarked disposable DB before BEGIN', async () => {
    const seen = []
    const db = {
      async query(sql) {
        seen.push(String(sql))
        const err = new Error('relation "ochr_acceptance_pack_marker" does not exist')
        err.code = '42P01'
        throw err
      },
      release() {},
    }
    await expect(seedAcceptancePack(db, creds('unmarked', DISPOSABLE, {
      ACCEPTANCE_PACK_APPLY: '1',
    }))).rejects.toMatchObject({ reason: 'marker_missing' })
    expect(seen.some((s) => /\bBEGIN\b/i.test(s))).toBe(false)
  })

  it('apply on a marked disposable DB is allowed past the marker into the write path', async () => {
    const seen = []
    const db = {
      async query(sql) {
        seen.push(String(sql))
        if (/ochr_acceptance_pack_marker/.test(sql)) {
          return { rows: [{ token: ACCEPTANCE_PACK_MARKER_TOKEN }] }
        }
        if (/^\s*BEGIN\s*$/i.test(sql)) {
          throw new Error('STOP_AFTER_MARKER')
        }
        throw new Error(`unexpected query: ${sql}`)
      },
      release() {},
    }
    await expect(seedAcceptancePack(db, creds('marked', DISPOSABLE, {
      ACCEPTANCE_PACK_APPLY: '1',
    }))).rejects.toThrow('STOP_AFTER_MARKER')
    expect(seen.some((s) => /ochr_acceptance_pack_marker/.test(s))).toBe(true)
    expect(seen.some((s) => /^\s*BEGIN\s*$/i.test(s))).toBe(true)
  })
})

describe('acceptance pack target gate', () => {
  it('refuses a remote URL before any query', async () => {
    const db = { query() { throw new Error('query was called') }, release() {} }
    await expect(seedAcceptancePack(db, creds('remote', 'postgresql://postgres@db.example.com:5432/openchurch', {
      ACCEPTANCE_PACK_APPLY: '1',
    }))).rejects.toMatchObject({ reason: 'remote_refused' })
  })

  it('refuses a loopback URL whose host override is remote', () => {
    expect(assertAcceptancePackTarget(creds('override', `${DISPOSABLE}?host=db.example.com`)))
      .toEqual({ ok: false, reason: 'remote_refused' })
  })

  it('refuses a non-loopback PGHOST even when the URL is loopback', () => {
    expect(assertAcceptancePackTarget({ ...creds('pghost'), PGHOST: 'db.example.com' }))
      .toEqual({ ok: false, reason: 'remote_refused' })
  })

  it('refuses production even on a disposable loopback URL (no production override)', () => {
    expect(assertAcceptancePackTarget({ ...creds('prod'), NODE_ENV: 'production' }))
      .toEqual({ ok: false, reason: 'production' })
    expect(assertAcceptancePackTarget({ ...creds('vercel'), VERCEL_ENV: 'production' }))
      .toEqual({ ok: false, reason: 'production' })
  })

  it('does not honor APP_REVIEW_ALLOW_REMOTE', () => {
    expect(assertAcceptancePackTarget(creds('allow', 'postgresql://postgres@db.example.com/openchurch')).reason)
      .toBe('remote_refused')
  })

  it('refuses the public demo pair and has no credential defaults', () => {
    expect(resolveAcceptancePack({ ...creds('nodemo'), ACCEPTANCE_PACK_EMAIL: 'demo@openchurch.app' }).reason)
      .toBe('demo_email_forbidden')
    expect(resolveAcceptancePack({ ...creds('nopw'), ACCEPTANCE_PACK_PASSWORD: 'demo1234' }).reason)
      .toBe('demo_password_forbidden')
    expect(resolveAcceptancePack({ ...creds('noslug'), ACCEPTANCE_PACK_ORG_SLUG: 'demo-church' }).reason)
      .toBe('demo_slug_forbidden')
    const bare = resolveAcceptancePack({
      ...creds('bare'),
      ACCEPTANCE_PACK_EMAIL: '',
      ACCEPTANCE_PACK_PASSWORD: '',
      ACCEPTANCE_PACK_ORG_NAME: '',
    })
    expect(bare).toEqual({ ok: false, reason: 'missing_env' })
  })

  it('defaults to dry-run unless ACCEPTANCE_PACK_APPLY is set', () => {
    const dry = resolveAcceptancePack(creds('dry'))
    expect(dry.ok).toBe(true)
    expect(dry.dryRun).toBe(true)
    expect(dry.reason).toBe('dry_run')
    expect(dry.config.role).toBe('viewer')
    const apply = resolveAcceptancePack(creds('apply', DISPOSABLE, { ACCEPTANCE_PACK_APPLY: '1' }))
    expect(apply.ok).toBe(true)
    expect(apply.dryRun).toBe(false)
    expect(apply.reason).toBe('ready')
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
        ACCEPTANCE_PACK_EMAIL: 'reviewer@example.com',
        ACCEPTANCE_PACK_PASSWORD: 'reviewer-pass-long',
        ACCEPTANCE_PACK_ORG_NAME: 'Synthetic Acceptance Parish',
      },
    })
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('remote_refused')
    expect(r.stdout).not.toContain('Created synthetic parish')
  })

  it('the CLI refuses ordinary local openchurch_local', () => {
    const r = spawnSync(process.execPath, [SCRIPT.pathname], {
      encoding: 'utf8',
      timeout: 8000,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_ENV: 'test',
        DATABASE_URL: ORDINARY_LOCAL,
        ACCEPTANCE_PACK_EMAIL: 'reviewer@example.com',
        ACCEPTANCE_PACK_PASSWORD: 'reviewer-pass-long',
        ACCEPTANCE_PACK_ORG_NAME: 'Synthetic Acceptance Parish',
      },
    })
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('ordinary_local_refused')
  })

  it('the CLI dry-runs on a disposable name without opening a database connection', () => {
    const r = spawnSync(process.execPath, [SCRIPT.pathname], {
      encoding: 'utf8',
      timeout: 8000,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_ENV: 'test',
        DATABASE_URL: DISPOSABLE,
        ACCEPTANCE_PACK_EMAIL: 'reviewer-dry@example.com',
        ACCEPTANCE_PACK_PASSWORD: 'reviewer-pass-long',
        ACCEPTANCE_PACK_ORG_NAME: 'Synthetic Acceptance Parish Dry',
        ACCEPTANCE_PACK_ORG_SLUG: `acceptance-dry-${RUN_ID}`.replace(/_/g, '-').slice(0, 60),
      },
    })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('DRY-RUN')
    expect(r.stdout).toContain('viewer login')
    expect(r.stdout).not.toContain('Created synthetic parish')
  })
})

const disposableName = `openchurch_acceptance_t${RUN_ID.replace(/[^a-z0-9]/g, '').slice(0, 12)}`
const disposableUrl = `postgresql://postgres@127.0.0.1:5433/${disposableName}`

function sh(cmd, args, env = {}) {
  return spawnSync(cmd, args, {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 120_000,
  })
}

const createdb = sh('createdb', ['-h', '127.0.0.1', '-p', '5433', '-U', 'postgres', disposableName])
const canDisposable = createdb.status === 0

describe.skipIf(!canDisposable)('acceptance pack rows on marked disposable DB', () => {
  beforeAll(async () => {
    const mig = sh(process.execPath, [MIGRATE.pathname], {
      DATABASE_URL: disposableUrl,
      DOTENV_CONFIG_PATH: '/dev/null',
      NODE_ENV: 'test',
      CHECKIN_CODE_PEPPER: process.env.CHECKIN_CODE_PEPPER || 'test-pepper-acceptance-pack',
    })
    if (mig.status !== 0) {
      throw new Error(`migrate disposable failed: ${mig.stderr || mig.stdout}`)
    }
    const prep = sh(process.execPath, [PREPARE.pathname], {
      DATABASE_URL: disposableUrl,
      DOTENV_CONFIG_PATH: '/dev/null',
      NODE_ENV: 'test',
    })
    if (prep.status !== 0) {
      throw new Error(`prepare disposable failed: ${prep.stderr || prep.stdout}`)
    }
  }, 120_000)

  afterAll(() => {
    sh('dropdb', ['--if-exists', '-h', '127.0.0.1', '-p', '5433', '-U', 'postgres', disposableName])
  })

  it('marker assert passes only after prepare', async () => {
    const { default: pg } = await import('pg')
    const p = new pg.Pool({ connectionString: disposableUrl })
    try {
      const client = await p.connect()
      try {
        const marker = await assertAcceptancePackMarker(client)
        expect(marker).toEqual({ ok: true, reason: 'marker_present' })
      } finally {
        client.release()
      }
    } finally {
      await p.end()
    }
  })

  it('inserts bilingual members, a bulletin, and a viewer login', async () => {
    const { default: pg } = await import('pg')
    const p = new pg.Pool({ connectionString: disposableUrl })
    const env = {
      ...creds('rows', disposableUrl, { ACCEPTANCE_PACK_APPLY: '1' }),
    }
    let orgId = null
    const client = await p.connect()
    try {
      const result = await seedAcceptancePack(client, env)
      orgId = result.organizationId
      expect(result.seeded).toBe(true)
      expect(result.dryRun).toBe(false)
      expect(result.role).toBe('viewer')
      expect(result.counts.members).toBe(3)
      expect(result.counts.register).toBe(1)
      expect(result.counts.intentions).toBe(1)
      expect(result.counts.sacristy).toBeGreaterThanOrEqual(1)
      expect(result.counts.checkins).toBe(1)
      expect(result.counts.events).toBe(1)
      expect(result.counts.bulletins).toBe(1)
      expect(result.counts.preferredLanguages).toEqual({ both: 1, en: 1, es: 1 })

      const user = await p.query(
        `SELECT role, email FROM ochr_users WHERE organization_id = $1`,
        [orgId],
      )
      expect(user.rows).toHaveLength(1)
      expect(user.rows[0].role).toBe('viewer')
      expect(user.rows[0].email).toBe(env.ACCEPTANCE_PACK_EMAIL)

      const bulletin = await p.query(
        `SELECT title, published, date FROM ochr_bulletins WHERE organization_id = $1`,
        [orgId],
      )
      expect(bulletin.rows).toHaveLength(1)
      expect(bulletin.rows[0].published).toBe(false)
      expect(bulletin.rows[0].title).toBe('Synthetic Sunday Bulletin')

      const checkin = await p.query(
        `SELECT security_code, security_code_hash, kind
           FROM ochr_checkins WHERE organization_id = $1`,
        [orgId],
      )
      expect(checkin.rows).toHaveLength(1)
      expect(checkin.rows[0].kind).toBe('child')
      expect(checkin.rows[0].security_code).toBeNull()
      expect(checkin.rows[0].security_code_hash).toEqual(expect.any(String))
    } finally {
      client.release()
      if (orgId) await p.query('DELETE FROM ochr_organizations WHERE id = $1', [orgId]).catch(() => {})
      await p.end()
    }
  })
})

describe('acceptance pack dry-run / client shape', () => {
  it('dry-run returns a plan and never queries', async () => {
    const env = creds('plan')
    const db = { query() { throw new Error('query was called') }, release() {} }
    const result = await seedAcceptancePack(db, env)
    expect(result.dryRun).toBe(true)
    expect(result.seeded).toBe(false)
    expect(result.plan).toEqual({
      organization: 1,
      users: 1,
      role: 'viewer',
      members: 3,
      preferredLanguages: ['en', 'es', 'both'],
      register: 1,
      intentions: 1,
      events: 1,
      calendarEvents: 1,
      checkins: 1,
      bulletins: 1,
    })
    expect(result.role).toBe('viewer')
    expect(acceptancePackPlan({ role: 'viewer' })).toEqual(result.plan)
  })

  it('refuses a bare pool before any query', async () => {
    const env = creds('pool', DISPOSABLE, { ACCEPTANCE_PACK_APPLY: '1' })
    const fakePool = { query() { throw new Error('pool.query was called') }, connect() {} }
    await expect(seedAcceptancePack(fakePool, env)).rejects.toMatchObject({ reason: 'needs_reserved_client' })
  })

  it('acceptancePackMarkerDdl mentions the v1 token', () => {
    expect(acceptancePackMarkerDdl()).toContain(ACCEPTANCE_PACK_MARKER_TOKEN)
    expect(acceptancePackMarkerDdl()).toContain('ochr_acceptance_pack_marker')
  })
})
