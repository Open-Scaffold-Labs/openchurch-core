// db_identity on /health and /api/health. Synthetic fixtures only: every
// ref, password and host here is invented. pool.query is replaced before
// the app loads; nothing opens a database connection.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const { query } = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('dotenv/config', () => ({}))
vi.mock('../src/db.js', () => ({
  default: { query: (...a) => query(...a), on() { return this }, end: () => Promise.resolve() },
}))

import request from 'supertest'
import app, { HEALTH_PING_SQL } from '../src/app.js'
import { EXPECTED_MIGRATION } from '../src/migrations/names.js'
import { _resetForTests } from '../src/release/log.js'
import {
  dbIdentity, supabaseRefFromUrl, fingerprint, canonicalTuple, UNKNOWN_IDENTITY,
} from '../src/monitoring/dbIdentity.js'

const REF = 'abcdefghijklmnopqrst'
const OTHER = 'zyxwvutsrqponmlkjihg'
const PW = 'Fixture-Pw-7731'
const PW2 = 'Rotated-Pw-0042'
const direct = (ref = REF, pw = PW, q = '') => `postgresql://postgres:${pw}@db.${ref}.supabase.co:5432/postgres${q}`
const pooler = (ref = REF, pw = PW, q = '') => `postgresql://postgres.${ref}:${pw}@aws-0-us-west-1.pooler.supabase.com:6543/postgres${q}`
const P = { database: 'postgres', schema: 'public' }

describe('dbIdentity helper', () => {
  it('direct and pooler forms of the same ref/db/schema agree', () => {
    const a = dbIdentity(direct(), P), b = dbIdentity(pooler(), P)
    expect(a.status).toBe('measured')
    expect(a.form).toBe('direct'); expect(b.form).toBe('pooler')
    expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(a.fingerprint).toBe(b.fingerprint)
  })
  it('a different ref, database or schema differs', () => {
    const base = dbIdentity(pooler(), P).fingerprint
    expect(dbIdentity(pooler(OTHER), P).fingerprint).not.toBe(base)
    expect(dbIdentity(pooler(), { ...P, database: 'other' }).fingerprint).not.toBe(base)
    expect(dbIdentity(pooler(), { ...P, schema: 'other' }).fingerprint).not.toBe(base)
  })
  it('password rotation and benign query params have no effect and never leak', () => {
    const base = dbIdentity(pooler(), P)
    for (const u of [pooler(REF, PW2), direct(REF, PW2), pooler(REF, PW, '?sslmode=require'),
      direct(REF, PW, '?sslmode=verify-full&application_name=oc&connect_timeout=10')]) {
      const r = dbIdentity(u, P)
      expect(r.fingerprint).toBe(base.fingerprint)
      const text = JSON.stringify(r)
      for (const s of [PW, PW2, 'postgres.', 'pooler.supabase', REF]) expect(text).not.toContain(s)
    }
  })
  it('the hash input is exactly the documented tuple', () => {
    expect(canonicalTuple(REF, 'postgres', 'public'))
      .toBe(`["openchurch-db-identity","v1","${REF}","postgres","public"]`)
  })
  it('unknown, non-Supabase, ambiguous, encoded or malformed input fails safe', () => {
    const bad = [
      undefined, '', 'not a url', '%%%', 'mysql://u:p@db.abcdefghijklmnopqrst.supabase.co/x',
      'postgresql://u:p@localhost:5432/openchurch',
      'postgresql://postgres:p@db.short.supabase.co/postgres',
      'postgresql://postgres:p@aws-0-x.pooler.supabase.com:6543/postgres',          // pooler w/o ref
      `postgresql://postgres.${OTHER}:p@db.${REF}.supabase.co/postgres`,             // ambiguous
      `postgresql://someone:p@db.${REF}.supabase.co/postgres`,                       // ambiguous
      `postgresql://postgres.${REF}:p@pooler.supabase.com.evil.example/postgres`,
      `postgresql://postgres.%E0%A4%A:p@aws-0-x.pooler.supabase.com/postgres`,       // bad encoding
      `postgresql://postgres%2E${REF.toUpperCase()}:p@aws-0-x.pooler.supabase.com/postgres`,
      `postgresql://postgres.${REF}x:p@aws-0-x.pooler.supabase.com/postgres`,
      'x'.repeat(5000),
    ]
    for (const u of bad) {
      expect(supabaseRefFromUrl(u)).toBeNull()
      expect(dbIdentity(u, P)).toEqual(UNKNOWN_IDENTITY)
    }
  })
  it('a missing or partial probe gives null', () => {
    expect(dbIdentity(pooler(), null)).toEqual(UNKNOWN_IDENTITY)
    expect(dbIdentity(pooler(), { database: 'postgres' })).toEqual(UNKNOWN_IDENTITY)
    expect(dbIdentity(pooler(), { database: '', schema: 'public' })).toEqual(UNKNOWN_IDENTITY)
  })
})

describe('DBID-F1: query params that can change the target are never measured', () => {
  // Synthetic. Each URL names ref A in host/userinfo, while pg would
  // actually connect to something else (or with other credentials).
  const wrongTarget = [
    direct(REF, PW, `?host=db.${OTHER}.supabase.co`),                    // direct A, host= B
    direct(REF, PW, `?hostaddr=10.0.0.9`),
    pooler(REF, PW, `?user=postgres.${OTHER}`),                          // pooler user overridden
    direct(REF, PW, `?user=postgres.${OTHER}&host=aws-0-x.pooler.supabase.com`),
    direct(REF, PW, '?port=6543'),
    direct(REF, PW, '?dbname=other'),
    direct(REF, PW, '?service=b'),
    pooler(REF, PW, '?options=-c%20search_path%3Dother'),
    pooler(REF, PW, `?password=${PW2}`),
    pooler(REF, PW, '?HOST=x'),                                          // unknown key → unknown
    pooler(REF, PW, '?sslmode=require&host=x'),                          // benign + override
    pooler(REF, PW, '#frag'),
  ]
  for (const u of wrongTarget) {
    it(`unknown: ${u.replace(/^.*?@/, '…@')}`, () => {
      expect(supabaseRefFromUrl(u)).toBeNull()
      expect(dbIdentity(u, P)).toEqual(UNKNOWN_IDENTITY)
    })
  }
  it('benign sslmode alone stays measured with the same fingerprint', () => {
    expect(dbIdentity(direct(REF, PW, '?sslmode=require'), P)).toEqual(dbIdentity(direct(), P))
    expect(dbIdentity(pooler(REF, PW, '?sslmode=require'), P).status).toBe('measured')
  })
})

describe('health response uses the helper and the probe outputs', () => {
  let saved, errSpy
  beforeEach(() => {
    saved = process.env.DATABASE_URL
    query.mockReset(); _resetForTests()
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved
    errSpy.mockRestore()
  })
  const healthy = (row) => async (sql) => {
    if (sql === HEALTH_PING_SQL) return { rows: [row] }
    return { rows: [{ name: EXPECTED_MIGRATION }] }
  }

  for (const path of ['/health', '/api/health']) {
    it(`${path}: fingerprint comes from the runtime URL and the probe row`, async () => {
      process.env.DATABASE_URL = pooler(REF, PW, '?sslmode=require')
      query.mockImplementation(healthy({ database: 'parishdb', schema: 'tenant' }))
      const res = await request(app).get(path)
      expect(res.status).toBe(200)
      expect(res.body.status).toBe('ok')
      expect(res.body.db_identity).toEqual({
        version: 'v1', status: 'measured', form: 'pooler',
        fingerprint: fingerprint(REF, 'parishdb', 'tenant'),
      })
      for (const s of [PW, PW2, `postgres.${REF}`, REF]) expect(res.text).not.toContain(s)
    })
  }

  it('the ping is the identity probe (one ping query)', async () => {
    process.env.DATABASE_URL = direct()
    const seen = []
    query.mockImplementation(async (sql) => { seen.push(sql); return healthy(P)(sql) })
    await request(app).get('/api/health')
    expect(seen.filter(s => s === HEALTH_PING_SQL)).toHaveLength(1)
  })

  it('a failed ping claims no fingerprint and stays 503', async () => {
    process.env.DATABASE_URL = pooler()
    query.mockImplementation(async (sql) => {
      if (sql === HEALTH_PING_SQL) { const e = new Error(`boom ${PW}`); e.code = '08006'; throw e }
      return { rows: [] }
    })
    const res = await request(app).get('/api/health')
    expect(res.status).toBe(503)
    expect(res.body.db).toBe('error')
    expect(res.body.db_identity).toEqual(UNKNOWN_IDENTITY)
    expect(res.text).not.toContain(PW)
  })

  it('a failed ledger after a good ping claims no fingerprint and stays 503', async () => {
    process.env.DATABASE_URL = pooler()
    query.mockImplementation(async (sql) => {
      if (sql === HEALTH_PING_SQL) return { rows: [P] }
      const e = new Error('ledger'); e.code = '42P01'; throw e
    })
    const res = await request(app).get('/api/health')
    expect(res.status).toBe(503)
    expect(res.body.db_identity).toEqual(UNKNOWN_IDENTITY)
  })

  it('non-Supabase URL: health unchanged (200), identity explicit unknown', async () => {
    process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/openchurch'
    query.mockImplementation(healthy(P))
    const res = await request(app).get('/api/health')
    expect(res.status).toBe(200)
    expect(res.body.db_identity).toEqual(UNKNOWN_IDENTITY)
  })
})
