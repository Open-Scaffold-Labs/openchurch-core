// Isolated App Review tenant — throwaway non-prod reviewer sandbox.
//
// WHY THIS EXISTS. Auth-01 removed client-bundled demo credentials.
// Logout-all closed the session-revoke UI. App Store / matrix D review
// still needs a sandbox that is not production `demo@` and is never
// compiled into the parish client.
//
// WHAT THIS IS NOT. It is not SEED_DEMO. It does not create, rotate,
// promote, or delete `demo@openchurch.app`. Production migrate and the
// existing local demo seed are unchanged. Do not point this at
// production to "fix" App Review.
//
// GATES — every one is required before a write:
//   1. SEED_APP_REVIEW_TENANT is exactly "1" or "true"
//   2. Neither NODE_ENV nor VERCEL_ENV is "production" (the platform
//      signal counts on its own; a deploy with NODE_ENV unset is still
//      production). Preview stays eligible under gates 3-4.
//   3. APP_REVIEW_EMAIL, APP_REVIEW_PASSWORD, APP_REVIEW_ORG_NAME are
//      set in the environment (no hardcoded defaults, no client Vite vars)
//   4. DATABASE_URL's EFFECTIVE target is loopback (libpq ?host= /
//      ?hostaddr= overrides included), or APP_REVIEW_ALLOW_REMOTE=1
//   5. The email / password / org slug are not the public demo pair
//   6. The org slug does not already belong to another organization, and
//      the email does not already belong to a user in another org
//      (compared case-insensitively). The seed never adopts an existing
//      organization: it writes only into an org it inserted in this call.
//      There is no durable ownership marker, so EVERY existing slug is
//      refused — including a sandbox an earlier run created. Re-seeding
//      means choosing a new slug (or dropping the old sandbox by hand).
//
// Flag off → silent no-op. Any other failed gate throws so an operator
// who asked to seed notices, and nothing is written.

import bcrypt from 'bcryptjs'
import { seedSampleData } from '../onboarding/sampleSeed.js'
// The repository's shared fail-closed target classifier (RECOVERY-L3-05):
// a loopback authority with a remote libpq ?host= / ?hostaddr= override is
// remote, and malformed / socket URLs are not local.
import { classifyDatabaseUrl } from '../../../scripts/lib/db-target-guard.mjs'

function isEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim())
}

function slugify(name) {
  return (name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

const MIN_PASSWORD = 8
const PUBLIC_DEMO_EMAIL = 'demo@openchurch.app'
const PUBLIC_DEMO_PASSWORD = 'demo1234'
const DEMO_ORG_SLUG = 'demo-church'

function defaultEnv() {
  return {
    NODE_ENV: process.env.NODE_ENV,
    VERCEL_ENV: process.env.VERCEL_ENV,
    DATABASE_URL: process.env.DATABASE_URL,
    SEED_APP_REVIEW_TENANT: process.env.SEED_APP_REVIEW_TENANT,
    APP_REVIEW_EMAIL: process.env.APP_REVIEW_EMAIL,
    APP_REVIEW_PASSWORD: process.env.APP_REVIEW_PASSWORD,
    APP_REVIEW_ORG_NAME: process.env.APP_REVIEW_ORG_NAME,
    APP_REVIEW_ORG_SLUG: process.env.APP_REVIEW_ORG_SLUG,
    APP_REVIEW_USER_NAME: process.env.APP_REVIEW_USER_NAME,
    APP_REVIEW_ALLOW_REMOTE: process.env.APP_REVIEW_ALLOW_REMOTE,
    DEMO_EMAIL: process.env.DEMO_EMAIL,
    DEMO_PASSWORD: process.env.DEMO_PASSWORD,
  }
}

export function appReviewSeedRequested(env = defaultEnv()) {
  const v = env.SEED_APP_REVIEW_TENANT
  return v === '1' || v === 'true'
}

function targetIsLocal(databaseUrl) {
  return classifyDatabaseUrl(databaseUrl).kind === 'local'
}

export function resolveAppReviewSeed(env = defaultEnv()) {
  if (!appReviewSeedRequested(env)) {
    return { ok: false, reason: 'flag_off' }
  }
  if (env.NODE_ENV === 'production' || env.VERCEL_ENV === 'production') {
    return { ok: false, reason: 'production' }
  }
  if (!targetIsLocal(env.DATABASE_URL) && env.APP_REVIEW_ALLOW_REMOTE !== '1') {
    return { ok: false, reason: 'remote_refused' }
  }

  const email = (env.APP_REVIEW_EMAIL || '').trim().toLowerCase()
  const password = env.APP_REVIEW_PASSWORD || ''
  const orgName = (env.APP_REVIEW_ORG_NAME || '').trim()
  const slugFromEnv = (env.APP_REVIEW_ORG_SLUG || '').trim()
  const orgSlug = slugFromEnv || slugify(orgName)
  const userName = (env.APP_REVIEW_USER_NAME || '').trim() || 'App Reviewer'

  if (!email || !password || !orgName) {
    return { ok: false, reason: 'missing_env' }
  }
  if (!isEmail(email)) {
    return { ok: false, reason: 'invalid_email' }
  }
  if (password.length < MIN_PASSWORD) {
    return { ok: false, reason: 'password_too_short' }
  }
  if (!orgSlug) {
    return { ok: false, reason: 'invalid_org_slug' }
  }

  const demoEmail = (env.DEMO_EMAIL || PUBLIC_DEMO_EMAIL).trim().toLowerCase()
  if (email === PUBLIC_DEMO_EMAIL || email === demoEmail) {
    return { ok: false, reason: 'demo_email_forbidden' }
  }
  if (password === PUBLIC_DEMO_PASSWORD || (env.DEMO_PASSWORD && password === env.DEMO_PASSWORD)) {
    return { ok: false, reason: 'demo_password_forbidden' }
  }
  if (orgSlug === DEMO_ORG_SLUG) {
    return { ok: false, reason: 'demo_slug_forbidden' }
  }

  return { ok: true, config: { email, password, orgName, orgSlug, userName } }
}

function refusal(reason, message) {
  const err = new Error(message)
  err.reason = reason
  return err
}

// A unique violation here is a race with a writer outside this seed (the
// advisory lock serializes seeders). Report it as the refusal it is, never
// as a raw Postgres error.
async function insertOrRefuse(client, sql, params, reason, message) {
  try {
    const { rows } = await client.query(sql, params)
    return rows[0]
  } catch (err) {
    if (err?.code === '23505') throw refusal(reason, message)
    throw err
  }
}

export async function seedAppReviewTenant(db, env = defaultEnv()) {
  const resolved = resolveAppReviewSeed(env)
  if (resolved.reason === 'flag_off') {
    return { seeded: false, reason: 'flag_off' }
  }
  if (!resolved.ok) {
    const err = new Error(`App Review tenant seed refused: ${resolved.reason}`)
    err.reason = resolved.reason
    throw err
  }

  const { email, password, orgName, orgSlug, userName } = resolved.config

  // THE SEED NEVER ADOPTS AN EXISTING ORGANIZATION.
  //
  // Everything below runs in one transaction on one connection, serialized
  // by a transaction-scoped advisory lock so two seeders cannot interleave.
  // An organization is written to only when THIS call inserted it. Any slug
  // that already exists is refused: who is in it (even the review email as
  // its only user) is not proof the seed made it. Email identity is
  // compared case-insensitively; ochr_users.email is only TEXT UNIQUE, so a
  // case-variant row must be found by lower(email), not by a unique
  // violation.
  const client = await db.connect()
  let orgId
  let userId
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['openchurch:app-review-seed'])

    const { rows: orgRows } = await client.query(
      'SELECT id FROM ochr_organizations WHERE slug = $1',
      [orgSlug],
    )
    const existingOrgId = orgRows[0]?.id ?? null

    const { rows: emailRows } = await client.query(
      'SELECT id, organization_id FROM ochr_users WHERE lower(email) = $1',
      [email],
    )
    if (emailRows.some(r => r.organization_id !== existingOrgId)) {
      throw refusal('email_in_other_org',
        'App Review tenant seed refused: email_in_other_org — that email already belongs to a user in another organization. Nothing was written.')
    }

    if (existingOrgId !== null) {
      throw refusal('org_slug_taken',
        `App Review tenant seed refused: org_slug_taken — organization slug '${orgSlug}' already exists. The seed never adopts an existing organization (no durable ownership marker); choose a new slug. Nothing was written.`)
    }

    const inserted = await insertOrRefuse(client,
      `INSERT INTO ochr_organizations (name, slug, org_type, tradition)
       VALUES ($1, $2, 'parish', 'general')
       RETURNING id`,
      [orgName, orgSlug],
      'org_slug_taken',
      `App Review tenant seed refused: org_slug_taken — organization slug '${orgSlug}' was created concurrently by something other than this seed. Nothing was written.`,
    )
    orgId = inserted.id

    const hash = await bcrypt.hash(password, 10)
    const user = await insertOrRefuse(client,
      `INSERT INTO ochr_users (organization_id, email, password_hash, name, role, pastoral_lead)
       VALUES ($1, $2, $3, $4, 'admin', false)
       RETURNING id`,
      [orgId, email, hash, userName],
      'email_in_other_org',
      'App Review tenant seed refused: email_in_other_org — that email was taken concurrently. Nothing was written.',
    )
    userId = user.id
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }

  // Sample data goes only into the organization this call just created.
  try {
    await seedSampleData(db, orgId, 'general')
  } catch (seedErr) {
    console.error('app-review sample seed failed (tenant created):', seedErr)
  }

  console.log(`Seeded App Review tenant '${orgSlug}' for ${email}`)
  return {
    seeded: true,
    reason: 'created',
    organizationId: orgId,
    organizationSlug: orgSlug,
    userId,
    email,
  }
}
