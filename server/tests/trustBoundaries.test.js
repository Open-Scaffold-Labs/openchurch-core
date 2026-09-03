// The boundaries this pass closed, attacked rather than described.
//
// Each group states the control first — the legitimate thing that must keep
// working — then the attack. A test that only asserts the refusal would keep
// passing if the feature were deleted entirely.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'
import { normalizeDonorEmail } from '../src/finance/donorIdentity.js'

let server
const cleanupOrgIds = []

beforeAll(async () => {
  // Awaited, like every other suite: migrateOnce() returns the migration
  // promise, and without the await the first request can reach a database
  // whose tables do not exist yet. Invisible on a warm DB, a 500 on a cold one.
  await migrateOnce()
  server = await bindServer()
})

afterAll(async () => {
  for (const id of cleanupOrgIds) {
    await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
  }
  await closeServer(server)
})

// ── DIOCESE CREATION IS A TRUSTED OPERATION ─────────────────────────────
describe('diocese creation is not self-service', () => {
  const ip = '10.211.0.'
  let n = 0
  const nextIp = () => ip + (++n)

  it('CONTROL: a parish still signs up through the public door', async () => {
    const res = await request(server).post('/api/auth/signup')
      .set('X-Forwarded-For', nextIp())
      .send({
        organizationName: `TB Parish ${RUN_ID}`, name: 'Parish Admin',
        email: `tb_par_${RUN_ID}@example.com`, password: 'tb-pw-parish-1',
      })
    expect(res.status).toBe(201)
    expect(res.body.user.organization.org_type ?? 'parish').toBe('parish')
    cleanupOrgIds.push(res.body.user.organization.id)
  })

  it('ATTACK: a direct POST asking for a diocese is refused by the server', async () => {
    const res = await request(server).post('/api/auth/signup')
      .set('X-Forwarded-For', nextIp())
      .send({
        organizationName: `TB Squat Diocese ${RUN_ID}`, name: 'Squatter',
        email: `tb_squat_${RUN_ID}@example.com`, password: 'tb-pw-squat-1',
        organizationType: 'diocese',
      })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('org_type_not_self_service')

    // And nothing was created — the refusal is before the transaction, not
    // a cosmetic response over a committed row.
    const { rows } = await pool.query(
      'SELECT id FROM ochr_users WHERE email = $1',
      [`tb_squat_${RUN_ID}@example.com`]
    )
    expect(rows).toHaveLength(0)
  })

  it('ATTACK: an unrecognised organizationType is refused too, not silently downgraded', async () => {
    // The old code coerced anything that was not 'diocese' to 'parish'. A
    // caller asking for something this server does not offer should be told,
    // not quietly given a parish it did not request.
    const res = await request(server).post('/api/auth/signup')
      .set('X-Forwarded-For', nextIp())
      .send({
        organizationName: `TB Odd ${RUN_ID}`, name: 'Odd',
        email: `tb_odd_${RUN_ID}@example.com`, password: 'tb-pw-odd-1',
        organizationType: 'archdiocese',
      })
    expect(res.status).toBe(403)
  })

  it('the provisioning route is invisible without SUPER_ADMIN_EMAIL', async () => {
    const parish = await request(server).post('/api/auth/signup')
      .set('X-Forwarded-For', nextIp())
      .send({
        organizationName: `TB Nobody ${RUN_ID}`, name: 'Nobody',
        email: `tb_nobody_${RUN_ID}@example.com`, password: 'tb-pw-nobody-1',
      })
    expect(parish.status).toBe(201)
    cleanupOrgIds.push(parish.body.user.organization.id)

    const previous = process.env.SUPER_ADMIN_EMAIL
    delete process.env.SUPER_ADMIN_EMAIL
    try {
      const res = await request(server).post('/api/admin/maintenance/organizations')
        .set('Authorization', `Bearer ${parish.body.token}`)
        .send({
          organizationName: `TB Ghost ${RUN_ID}`, name: 'Ghost',
          email: `tb_ghost_${RUN_ID}@example.com`, password: 'tb-pw-ghost-1',
          organizationType: 'diocese',
        })
      expect(res.status).toBe(404)
    } finally {
      if (previous === undefined) delete process.env.SUPER_ADMIN_EMAIL
      else process.env.SUPER_ADMIN_EMAIL = previous
    }
  })

  it('ATTACK: an ordinary parish admin cannot provision, even with a valid token', async () => {
    const parish = await request(server).post('/api/auth/signup')
      .set('X-Forwarded-For', nextIp())
      .send({
        organizationName: `TB Ordinary ${RUN_ID}`, name: 'Ordinary',
        email: `tb_ord_${RUN_ID}@example.com`, password: 'tb-pw-ord-1',
      })
    expect(parish.status).toBe(201)
    cleanupOrgIds.push(parish.body.user.organization.id)

    const previous = process.env.SUPER_ADMIN_EMAIL
    process.env.SUPER_ADMIN_EMAIL = `someone-else-${RUN_ID}@openchurch.test`
    try {
      const res = await request(server).post('/api/admin/maintenance/organizations')
        .set('Authorization', `Bearer ${parish.body.token}`)
        .send({
          organizationName: `TB Sneak ${RUN_ID}`, name: 'Sneak',
          email: `tb_sneak_${RUN_ID}@example.com`, password: 'tb-pw-sneak-1',
          organizationType: 'diocese',
        })
      expect(res.status).toBe(404)
    } finally {
      if (previous === undefined) delete process.env.SUPER_ADMIN_EMAIL
      else process.env.SUPER_ADMIN_EMAIL = previous
    }
  })

  it('the trusted path does create a diocese, and its first user leads pastorally', async () => {
    const res = await createOrg(server, {
      organizationName: `TB Real Chancery ${RUN_ID}`, name: 'Canon',
      email: `tb_chan_${RUN_ID}@example.com`, password: 'tb-pw-chan-1',
      organizationType: 'diocese',
    }, nextIp())
    expect(res.status).toBe(201)
    const orgId = res.body.user.organization.id
    cleanupOrgIds.push(orgId)

    const { rows } = await pool.query(
      'SELECT org_type FROM ochr_organizations WHERE id = $1', [orgId])
    expect(rows[0].org_type).toBe('diocese')

    const { rows: u } = await pool.query(
      'SELECT pastoral_lead, role FROM ochr_users WHERE email = $1',
      [`tb_chan_${RUN_ID}@example.com`])
    expect(u[0].role).toBe('admin')
    expect(u[0].pastoral_lead).toBe(true)
  })
})

// ── STUB IS NOT MONEY ────────────────────────────────────────────────────
describe('a stub charge cannot be recorded as a received gift on a real deployment', () => {
  // The predicates are unit-tested directly because the condition they guard
  // is an ENVIRONMENT, and a route test can only reach it by lying about the
  // environment anyway. Both are exercised: the predicate here, the route
  // refusal below.
  const saved = {}
  beforeAll(() => {
    for (const k of ['VERCEL_ENV', 'PAYMENTS_PROVIDER', 'PAYMENTS_PROVIDER_SECRET', 'DATABASE_URL']) {
      saved[k] = process.env[k]
    }
  })
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v
    }
  })

  const load = async () => {
    // Re-import per case: the predicates read process.env at call time, so a
    // plain import is enough — but this keeps each case self-contained.
    return await import('../src/payments/index.js')
  }

  it('CONTROL: locally, the stub is allowed — this must not block demos or CI', async () => {
    const m = await load()
    delete process.env.VERCEL_ENV
    process.env.DATABASE_URL = 'postgresql://postgres@localhost:5433/openchurch_local'
    process.env.PAYMENTS_PROVIDER = 'stub'
    expect(m.deploymentIsProductionLike()).toBe(false)
    expect(m.stubWouldFakeMoney()).toBe(false)
  })

  it('a Vercel PREVIEW deployment is not production, so the stub is still allowed there', async () => {
    const m = await load()
    process.env.VERCEL_ENV = 'preview'
    process.env.PAYMENTS_PROVIDER = 'stub'
    expect(m.stubWouldFakeMoney()).toBe(false)
  })

  it('ATTACK: PAYMENTS_PROVIDER=stub on production is refused', async () => {
    const m = await load()
    process.env.VERCEL_ENV = 'production'
    process.env.PAYMENTS_PROVIDER = 'stub'
    expect(m.deploymentIsProductionLike()).toBe(true)
    expect(m.stubWouldFakeMoney()).toBe(true)
    expect(m.paymentsCanMoveMoney()).toBe(false)
  })

  it('a non-loopback database counts as production when the platform says nothing', async () => {
    const m = await load()
    delete process.env.VERCEL_ENV
    process.env.DATABASE_URL = 'postgresql://u:p@db.example.supabase.com:6543/postgres'
    process.env.PAYMENTS_PROVIDER = 'stub'
    expect(m.deploymentIsProductionLike()).toBe(true)
    expect(m.stubWouldFakeMoney()).toBe(true)
  })

  it('an absent DATABASE_URL is treated as production — an unknown target is not a safe one', async () => {
    const m = await load()
    delete process.env.VERCEL_ENV
    delete process.env.DATABASE_URL
    expect(m.deploymentIsProductionLike()).toBe(true)
  })

  it('SELECTED is not CONFIGURED is not CAPABLE: stripe with no secret cannot charge', async () => {
    const m = await load()
    process.env.PAYMENTS_PROVIDER = 'stripe'
    delete process.env.PAYMENTS_PROVIDER_SECRET
    expect(m.paymentsProvider()).toBe('stripe')
    expect(m.paymentsConfigured()).toBe(true)
    expect(m.paymentsCanMoveMoney()).toBe(false)
  })
})

// ── EMAIL NORMALIZATION IS NOT PERSON RESOLUTION ────────────────────────
describe('donor email normalisation', () => {
  it('folds case and surrounding whitespace onto one identity', () => {
    const forms = ['Jose@example.com', ' jose@example.com ', 'JOSE@EXAMPLE.COM', '\tJose@Example.Com\n']
    const normalized = new Set(forms.map(normalizeDonorEmail))
    expect([...normalized]).toEqual(['jose@example.com'])
  })

  it('keeps genuinely different donors apart', () => {
    expect(normalizeDonorEmail('jose@example.com'))
      .not.toBe(normalizeDonorEmail('jose.rivera@example.com'))
    expect(normalizeDonorEmail('jose@example.com'))
      .not.toBe(normalizeDonorEmail('jose@example.org'))
  })

  it('does NOT fold plus-addressing or dots — that would merge two people at most providers', () => {
    expect(normalizeDonorEmail('jose+parish@example.com')).toBe('jose+parish@example.com')
    expect(normalizeDonorEmail('j.ose@example.com')).toBe('j.ose@example.com')
  })

  it('empty and whitespace-only become null, so the no-email grouping stays reachable', () => {
    expect(normalizeDonorEmail('')).toBeNull()
    expect(normalizeDonorEmail('   ')).toBeNull()
    expect(normalizeDonorEmail(null)).toBeNull()
    expect(normalizeDonorEmail(undefined)).toBeNull()
  })
})
