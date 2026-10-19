// OC-READY-01-010 — App Review tenant seed is flag-gated, env-credentialed,
// and isolated from the demo org. Flag off writes nothing. Production
// refuses. The public demo pair is rejected.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import bcrypt from 'bcryptjs'
import 'dotenv/config'

import pool from '../src/db.js'
import { RUN_ID, migrateOnce } from './support/harness.js'
import {
  resolveAppReviewSeed,
  seedAppReviewTenant,
} from '../src/seed/appReviewTenant.js'

const DEMO_EMAIL = 'demo@openchurch.app'
const DEMO_SLUG = 'demo-church'

function envWith(overrides) {
  return { ...process.env, ...overrides }
}

function reviewCreds(suffix) {
  return {
    SEED_APP_REVIEW_TENANT: '1',
    APP_REVIEW_EMAIL: `review_${suffix}_${RUN_ID}@example.com`,
    APP_REVIEW_PASSWORD: `review-pw-${suffix}-${RUN_ID}`,
    APP_REVIEW_ORG_NAME: `App Review Parish ${suffix} ${RUN_ID}`,
    APP_REVIEW_ORG_SLUG: `app-review-${suffix}-${RUN_ID}`.replace(/_/g, '-').slice(0, 60),
    APP_REVIEW_USER_NAME: 'App Reviewer',
    NODE_ENV: 'test',
    APP_REVIEW_ALLOW_REMOTE: undefined,
  }
}

beforeAll(async () => {
  await migrateOnce()
}, 60_000)

afterAll(async () => {
  await pool.end()
})

describe('resolveAppReviewSeed guards', () => {
  it('flag off is a no-op even when credentials are present', () => {
    const creds = reviewCreds('off')
    const resolved = resolveAppReviewSeed(envWith({
      ...creds,
      SEED_APP_REVIEW_TENANT: undefined,
    }))
    expect(resolved).toEqual({ ok: false, reason: 'flag_off' })
  })

  it('empty / unknown flag values do not seed', () => {
    for (const value of ['', '0', 'false', 'yes', 'TRUE']) {
      const resolved = resolveAppReviewSeed(envWith({
        ...reviewCreds('empty'),
        SEED_APP_REVIEW_TENANT: value,
      }))
      expect(resolved, `flag=${JSON.stringify(value)}`).toEqual({ ok: false, reason: 'flag_off' })
    }
  })

  it('production is refused even with the flag and credentials', () => {
    const resolved = resolveAppReviewSeed(envWith({
      ...reviewCreds('prod'),
      NODE_ENV: 'production',
    }))
    expect(resolved).toEqual({ ok: false, reason: 'production' })
  })

  it('remote DATABASE_URL is refused without APP_REVIEW_ALLOW_REMOTE=1', () => {
    const resolved = resolveAppReviewSeed(envWith({
      ...reviewCreds('remote'),
      DATABASE_URL: 'postgresql://postgres:x@db.example.com:5432/openchurch',
    }))
    expect(resolved).toEqual({ ok: false, reason: 'remote_refused' })
  })

  it('missing env credentials have no defaults', () => {
    const base = reviewCreds('missing')
    expect(resolveAppReviewSeed(envWith({ ...base, APP_REVIEW_EMAIL: '' })).reason).toBe('missing_env')
    expect(resolveAppReviewSeed(envWith({ ...base, APP_REVIEW_PASSWORD: '' })).reason).toBe('missing_env')
    expect(resolveAppReviewSeed(envWith({ ...base, APP_REVIEW_ORG_NAME: '' })).reason).toBe('missing_env')
  })

  it('a remote DATABASE_URL is allowed only with the explicit APP_REVIEW_ALLOW_REMOTE=1', () => {
    const remote = 'postgresql://postgres:x@db.example.com:5432/openchurch'
    const base = { ...reviewCreds('remote-ok'), DATABASE_URL: remote }
    expect(resolveAppReviewSeed(envWith({ ...base, APP_REVIEW_ALLOW_REMOTE: 'true' })).reason).toBe('remote_refused')
    expect(resolveAppReviewSeed(envWith({ ...base, APP_REVIEW_ALLOW_REMOTE: '1' })).ok).toBe(true)
  })

  it('VERCEL_ENV=production refuses even with NODE_ENV absent (TARS probe 2)', () => {
    const resolved = resolveAppReviewSeed(envWith({
      ...reviewCreds('vercelprod'),
      NODE_ENV: undefined,
      VERCEL_ENV: 'production',
    }))
    expect(resolved).toEqual({ ok: false, reason: 'production' })
  })

  it('VERCEL_ENV=preview stays eligible under the non-production + local/opt-in rules', () => {
    const base = { ...reviewCreds('vercelpreview'), NODE_ENV: undefined, VERCEL_ENV: 'preview' }
    expect(resolveAppReviewSeed(envWith({ ...base, DATABASE_URL: 'postgresql://postgres@127.0.0.1:5432/x' })).ok).toBe(true)
    expect(resolveAppReviewSeed(envWith({ ...base, DATABASE_URL: 'postgresql://postgres:x@db.example.com:5432/x' })).reason).toBe('remote_refused')
  })

  it('a loopback authority with a remote ?host= / ?hostaddr= override is remote (TARS probe 3)', () => {
    const base = reviewCreds('hostoverride')
    for (const url of [
      'postgresql://postgres@localhost:5432/openchurch?host=remote.example.com',
      'postgresql://postgres@127.0.0.1:5432/openchurch?hostaddr=203.0.113.9',
      'postgresql://postgres@localhost:5432/openchurch?host=localhost&host=remote.example.com',
    ]) {
      expect(resolveAppReviewSeed(envWith({ ...base, DATABASE_URL: url })).reason, url).toBe('remote_refused')
      // explicit remote opt-in is still honoured
      expect(resolveAppReviewSeed(envWith({ ...base, DATABASE_URL: url, APP_REVIEW_ALLOW_REMOTE: '1' })).ok, url).toBe(true)
    }
    // a loopback override stays local
    expect(resolveAppReviewSeed(envWith({ ...base,
      DATABASE_URL: 'postgresql://postgres@localhost:5432/openchurch?host=127.0.0.1' })).ok).toBe(true)
  })

  it('rejects the public demo email, password, and slug', () => {
    const base = reviewCreds('demo')
    expect(resolveAppReviewSeed(envWith({ ...base, APP_REVIEW_EMAIL: DEMO_EMAIL })).reason).toBe('demo_email_forbidden')
    expect(resolveAppReviewSeed(envWith({ ...base, APP_REVIEW_PASSWORD: 'demo1234' })).reason).toBe('demo_password_forbidden')
    expect(resolveAppReviewSeed(envWith({ ...base, APP_REVIEW_ORG_SLUG: DEMO_SLUG })).reason).toBe('demo_slug_forbidden')
  })
})

describe('seedAppReviewTenant writes', () => {
  it('flag off writes no organization even when credentials are supplied', async () => {
    const creds = reviewCreds('nowrite')
    const result = await seedAppReviewTenant(pool, envWith({
      ...creds,
      SEED_APP_REVIEW_TENANT: '',
    }))
    expect(result).toEqual({ seeded: false, reason: 'flag_off' })

    const { rows } = await pool.query(
      'SELECT id FROM ochr_organizations WHERE slug = $1',
      [creds.APP_REVIEW_ORG_SLUG],
    )
    expect(rows).toEqual([])

    const { rows: users } = await pool.query(
      'SELECT id FROM ochr_users WHERE email = $1',
      [creds.APP_REVIEW_EMAIL],
    )
    expect(users).toEqual([])
  })

  it('production + flag throws and writes nothing', async () => {
    const creds = reviewCreds('prodwrite')
    await expect(seedAppReviewTenant(pool, envWith({
      ...creds,
      NODE_ENV: 'production',
    }))).rejects.toMatchObject({ reason: 'production' })

    const { rows } = await pool.query(
      'SELECT id FROM ochr_organizations WHERE slug = $1',
      [creds.APP_REVIEW_ORG_SLUG],
    )
    expect(rows).toEqual([])
  })

  it('flag on in test creates an isolated org and user from env, not demo@', async () => {
    const creds = reviewCreds('create')
    const result = await seedAppReviewTenant(pool, envWith(creds))
    expect(result.seeded).toBe(true)
    expect(result.reason).toBe('created')
    expect(result.email).toBe(creds.APP_REVIEW_EMAIL)
    expect(result.organizationSlug).toBe(creds.APP_REVIEW_ORG_SLUG)
    expect(result.organizationId).toEqual(expect.any(Number))

    const { rows: orgs } = await pool.query(
      'SELECT id, name, slug FROM ochr_organizations WHERE id = $1',
      [result.organizationId],
    )
    expect(orgs).toHaveLength(1)
    expect(orgs[0].slug).toBe(creds.APP_REVIEW_ORG_SLUG)
    expect(orgs[0].slug).not.toBe(DEMO_SLUG)
    expect(orgs[0].name).toBe(creds.APP_REVIEW_ORG_NAME)

    const { rows: users } = await pool.query(
      'SELECT id, email, name, role, organization_id, password_hash FROM ochr_users WHERE email = $1',
      [creds.APP_REVIEW_EMAIL],
    )
    expect(users).toHaveLength(1)
    expect(users[0].organization_id).toBe(orgs[0].id)
    expect(users[0].role).toBe('admin')
    expect(users[0].email).not.toBe(DEMO_EMAIL)
    expect(await bcrypt.compare(creds.APP_REVIEW_PASSWORD, users[0].password_hash)).toBe(true)

    const { rows: demo } = await pool.query(
      'SELECT email, organization_id FROM ochr_users WHERE email = $1',
      [DEMO_EMAIL],
    )
    if (demo.length) {
      expect(demo[0].organization_id).not.toBe(orgs[0].id)
    }
  })

  it('a second seed with the same env is refused and does not rotate the password', async () => {
    // No durable ownership marker exists, so an existing slug is never
    // treated as "ours" — not even the sandbox this seed created a moment
    // ago. Refuse, write nothing.
    const creds = reviewCreds('again')
    const first = await seedAppReviewTenant(pool, envWith(creds))
    expect(first.seeded).toBe(true)

    await expect(seedAppReviewTenant(pool, envWith({
      ...creds,
      APP_REVIEW_PASSWORD: `rotated-${RUN_ID}-must-not-apply`,
    }))).rejects.toMatchObject({ reason: 'org_slug_taken' })

    const { rows } = await pool.query(
      'SELECT password_hash FROM ochr_users WHERE id = $1',
      [first.userId],
    )
    expect(await bcrypt.compare(creds.APP_REVIEW_PASSWORD, rows[0].password_hash)).toBe(true)
  })
})


// ---------------------------------------------------------------------------
// THE APP REVIEW SEED NEVER ADOPTS AN EXISTING ORGANIZATION (2026-09-24).
//
// Before: INSERT ... ON CONFLICT (slug) DO NOTHING, then SELECT id by slug —
// a colliding slug silently reused a real parish, inserted role='admin'
// into it, and ran the sample seed against it.
// ---------------------------------------------------------------------------

async function makeRealParish(slug, staffEmails) {
  const { rows } = await pool.query(
    `INSERT INTO ochr_organizations (name, slug) VALUES ($1, $2) RETURNING id`,
    [`Real Parish ${slug}`, slug],
  )
  const orgId = rows[0].id
  for (const email of staffEmails) {
    await pool.query(
      `INSERT INTO ochr_users (organization_id, email, password_hash, name, role)
       VALUES ($1, $2, 'x', 'Real Staff', 'admin')`,
      [orgId, email],
    )
  }
  return orgId
}

async function orgFootprint(orgId) {
  const { rows: users } = await pool.query(
    'SELECT id, email, role FROM ochr_users WHERE organization_id = $1 ORDER BY id', [orgId])
  const { rows: org } = await pool.query(
    'SELECT name, slug, samples_seeded_at FROM ochr_organizations WHERE id = $1', [orgId])
  const { rows: tasks } = await pool.query(
    'SELECT count(*)::int AS n FROM ochr_tasks WHERE organization_id = $1', [orgId])
  const { rows: members } = await pool.query(
    'SELECT count(*)::int AS n FROM ochr_clients WHERE organization_id = $1', [orgId])
  return { users, org: org[0], tasks: tasks[0].n, members: members[0].n }
}

async function usersWithEmail(email) {
  const { rows } = await pool.query(
    'SELECT id, organization_id FROM ochr_users WHERE lower(email) = lower($1)', [email])
  return rows
}

describe('collisions — the seed never adopts an existing organization', () => {
  const cleanup = []
  afterAll(async () => {
    for (const id of cleanup) {
      await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
    }
  })

  it('an existing real parish on the review slug is refused and left untouched', async () => {
    const creds = reviewCreds('slugtaken')
    const realId = await makeRealParish(creds.APP_REVIEW_ORG_SLUG, [`staff_st_${RUN_ID}@example.com`])
    cleanup.push(realId)
    const before = await orgFootprint(realId)

    await expect(seedAppReviewTenant(pool, envWith(creds)))
      .rejects.toMatchObject({ reason: 'org_slug_taken' })

    expect(await orgFootprint(realId)).toEqual(before)
    expect(await usersWithEmail(creds.APP_REVIEW_EMAIL)).toEqual([])
  })

  it('a slug derived from APP_REVIEW_ORG_NAME that collides is refused too', async () => {
    const creds = { ...reviewCreds('derived'), APP_REVIEW_ORG_SLUG: undefined,
      APP_REVIEW_ORG_NAME: `St Mary ${RUN_ID}` }
    const derived = `st-mary-${RUN_ID}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60)
    const realId = await makeRealParish(derived, [`staff_sm_${RUN_ID}@example.com`])
    cleanup.push(realId)
    const before = await orgFootprint(realId)

    await expect(seedAppReviewTenant(pool, envWith(creds)))
      .rejects.toMatchObject({ reason: 'org_slug_taken' })
    expect(await orgFootprint(realId)).toEqual(before)
  })

  it('an existing organization with no users on the slug is still not adopted', async () => {
    const creds = reviewCreds('emptyorg')
    const realId = await makeRealParish(creds.APP_REVIEW_ORG_SLUG, [])
    cleanup.push(realId)
    const before = await orgFootprint(realId)

    await expect(seedAppReviewTenant(pool, envWith(creds)))
      .rejects.toMatchObject({ reason: 'org_slug_taken' })
    expect(await orgFootprint(realId)).toEqual(before)
    expect(before.org.samples_seeded_at).toBeNull()
  })

  it('a REAL parish whose sole user is the review email is refused, untouched (TARS probe 1)', async () => {
    // The email is not proof of seed ownership. Before: already_exists.
    const creds = reviewCreds('soleemail')
    const realId = await makeRealParish(creds.APP_REVIEW_ORG_SLUG, [creds.APP_REVIEW_EMAIL])
    cleanup.push(realId)
    const before = await orgFootprint(realId)

    await expect(seedAppReviewTenant(pool, envWith(creds)))
      .rejects.toMatchObject({ reason: 'org_slug_taken' })
    expect(await orgFootprint(realId)).toEqual(before)
  })

  it('the review email in the intended org alongside other staff — refused, nothing written', async () => {
    const creds = reviewCreds('ambiguous')
    const realId = await makeRealParish(creds.APP_REVIEW_ORG_SLUG, [
      creds.APP_REVIEW_EMAIL,
      `staff_amb_${RUN_ID}@example.com`,
    ])
    cleanup.push(realId)
    const before = await orgFootprint(realId)

    await expect(seedAppReviewTenant(pool, envWith(creds)))
      .rejects.toMatchObject({ reason: 'org_slug_taken' })
    expect(await orgFootprint(realId)).toEqual(before)
  })

  it('the review email already in ANOTHER org is refused cleanly and creates no org', async () => {
    const creds = reviewCreds('otherorg')
    const otherId = await makeRealParish(`other-${RUN_ID}`.replace(/_/g, '-'), [creds.APP_REVIEW_EMAIL])
    cleanup.push(otherId)
    const before = await orgFootprint(otherId)

    await expect(seedAppReviewTenant(pool, envWith(creds)))
      .rejects.toMatchObject({ reason: 'email_in_other_org' })

    const { rows } = await pool.query(
      'SELECT id FROM ochr_organizations WHERE slug = $1', [creds.APP_REVIEW_ORG_SLUG])
    expect(rows).toEqual([])
    expect(await orgFootprint(otherId)).toEqual(before)
  })

  it('a case-variant of the review email in another org is refused — not a raw unique violation', async () => {
    const creds = reviewCreds('casevariant')
    const mixed = creds.APP_REVIEW_EMAIL.replace(/^review/, 'Review').toUpperCase()
    const otherId = await makeRealParish(`case-${RUN_ID}`.replace(/_/g, '-'), [mixed])
    cleanup.push(otherId)

    const err = await seedAppReviewTenant(pool, envWith(creds)).catch(e => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.reason).toBe('email_in_other_org')
    expect(err.code).toBeUndefined() // not the pg 23505 leaking through
    const { rows } = await pool.query(
      'SELECT id FROM ochr_organizations WHERE slug = $1', [creds.APP_REVIEW_ORG_SLUG])
    expect(rows).toEqual([])
  })

  it('a re-run on the seed\'s own earlier sandbox is refused and writes nothing (case-variant email too)', async () => {
    const creds = reviewCreds('ownrerun')
    const first = await seedAppReviewTenant(pool, envWith(creds))
    expect(first.seeded).toBe(true)
    cleanup.push(first.organizationId)
    const before = await orgFootprint(first.organizationId)

    await expect(seedAppReviewTenant(pool, envWith({
      ...creds,
      APP_REVIEW_EMAIL: creds.APP_REVIEW_EMAIL.toUpperCase(),
    }))).rejects.toMatchObject({ reason: 'org_slug_taken' })
    expect(await orgFootprint(first.organizationId)).toEqual(before)
  })

  it('two concurrent seeds with the same env create exactly one org and one user', async () => {
    const creds = reviewCreds('race')
    const results = await Promise.allSettled([
      seedAppReviewTenant(pool, envWith(creds)),
      seedAppReviewTenant(pool, envWith(creds)),
    ])
    const outcomes = results.map(r => r.status === 'fulfilled' ? r.value.reason : r.reason?.reason).sort()
    expect(outcomes).toEqual(['created', 'org_slug_taken'])

    const { rows } = await pool.query(
      'SELECT id FROM ochr_organizations WHERE slug = $1', [creds.APP_REVIEW_ORG_SLUG])
    expect(rows).toHaveLength(1)
    cleanup.push(rows[0].id)
    expect(await usersWithEmail(creds.APP_REVIEW_EMAIL)).toHaveLength(1)
  })
})
