// Pure target gate for the reviewer fixture seed.
//
// No database import, no dotenv, no network. The CLI calls this before it
// loads the driver, so a remote DATABASE_URL is refused before a connection
// exists. There is no remote override: APP_REVIEW_ALLOW_REMOTE does not
// apply here. NODE_ENV is not a pass. Production (NODE_ENV or VERCEL_ENV)
// is refused even when the URL is loopback.

import { classifyDatabaseUrl } from '../../../scripts/lib/db-target-guard.mjs'

const PUBLIC_DEMO_EMAIL = 'demo@openchurch.app'
const PUBLIC_DEMO_PASSWORD = 'demo1234'
const DEMO_ORG_SLUG = 'demo-church'
const MIN_PASSWORD = 8

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

function isExactLoopbackHost(name) {
  return name === 'localhost' || name === '127.0.0.1' || name === '::1'
}

export function assertReviewerFixtureTarget(env = process.env) {
  if (env.NODE_ENV === 'production' || env.VERCEL_ENV === 'production') {
    return { ok: false, reason: 'production' }
  }
  for (const key of ['PGHOST', 'PGHOSTADDR']) {
    const value = env[key]
    if (value == null || String(value).trim() === '') continue
    if (!isExactLoopbackHost(String(value).trim())) {
      return { ok: false, reason: 'remote_refused' }
    }
  }
  const cls = classifyDatabaseUrl(env.DATABASE_URL)
  if (cls.kind !== 'local') {
    return { ok: false, reason: 'remote_refused' }
  }
  return { ok: true, reason: 'local' }
}

export function resolveReviewerFixture(env = process.env) {
  const target = assertReviewerFixtureTarget(env)
  if (!target.ok) return target

  const email = (env.REVIEWER_FIXTURE_EMAIL || '').trim().toLowerCase()
  const password = env.REVIEWER_FIXTURE_PASSWORD || ''
  const orgName = (env.REVIEWER_FIXTURE_ORG_NAME || '').trim()
  const slugFromEnv = (env.REVIEWER_FIXTURE_ORG_SLUG || '').trim()
  const orgSlug = slugFromEnv || slugify(orgName)
  const userName = (env.REVIEWER_FIXTURE_USER_NAME || '').trim() || 'Synthetic Reviewer'

  if (!email || !password || !orgName) {
    return { ok: false, reason: 'missing_env' }
  }
  if (!isEmail(email)) return { ok: false, reason: 'invalid_email' }
  if (password.length < MIN_PASSWORD) return { ok: false, reason: 'password_too_short' }
  if (!orgSlug) return { ok: false, reason: 'invalid_org_slug' }

  const demoEmail = (env.DEMO_EMAIL || PUBLIC_DEMO_EMAIL).trim().toLowerCase()
  if (email === PUBLIC_DEMO_EMAIL || email === demoEmail) {
    return { ok: false, reason: 'demo_email_forbidden' }
  }
  if (password === PUBLIC_DEMO_PASSWORD || (env.DEMO_PASSWORD && password === env.DEMO_PASSWORD)) {
    return { ok: false, reason: 'demo_password_forbidden' }
  }
  if (orgSlug === DEMO_ORG_SLUG) return { ok: false, reason: 'demo_slug_forbidden' }

  return { ok: true, reason: 'ready', config: { email, password, orgName, orgSlug, userName } }
}
