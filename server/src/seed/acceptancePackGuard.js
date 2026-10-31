// Pure target and config gate for the iOS acceptance-pack seed.
//
// No database import, no dotenv, no network. The CLI calls this before it
// loads the driver, so a remote DATABASE_URL is refused before a connection
// exists. There is no remote override and no production override:
// NODE_ENV=production or VERCEL_ENV=production is refused even on loopback.
//
// Loopback alone is not enough. Writes (and dry-run planning) require a
// dedicated disposable database identity:
//   1. Database name matches openchurch_acceptance_* (strict pattern)
//   2. Name is not an ordinary local DB (openchurch_local, postgres, …)
//   3. Before any write: sentinel table ochr_acceptance_pack_marker with
//      token openchurch-acceptance-pack-v1 (created by prepare script)
//
// Writes are off by default (dry-run). ACCEPTANCE_PACK_APPLY=1 is required
// to leave dry-run. That flag never authorizes production, a remote host,
// or an unmarked / ordinary local database.

import { classifyDatabaseUrl } from '../../../scripts/lib/db-target-guard.mjs'

const PUBLIC_DEMO_EMAIL = 'demo@openchurch.app'
const PUBLIC_DEMO_PASSWORD = 'demo1234'
const DEMO_ORG_SLUG = 'demo-church'
const MIN_PASSWORD = 8

/** Strict disposable name: openchurch_acceptance_ + lowercase tokens. */
export const ACCEPTANCE_PACK_DB_NAME_RE = /^openchurch_acceptance_[a-z0-9]+(?:_[a-z0-9]+)*$/

/** Sentinel token written by prepare-acceptance-pack-db.js. */
export const ACCEPTANCE_PACK_MARKER_TOKEN = 'openchurch-acceptance-pack-v1'

export const ACCEPTANCE_PACK_MARKER_TABLE = 'ochr_acceptance_pack_marker'

/** Ordinary local / system DBs that must never receive the pack. */
export const ORDINARY_LOCAL_DB_NAMES = new Set([
  'openchurch_local',
  'openchurch',
  'postgres',
  'template0',
  'template1',
])

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

function truthyApply(value) {
  if (value == null) return false
  const s = String(value).trim().toLowerCase()
  return s === '1' || s === 'true' || s === 'yes' || s === 'apply'
}

/**
 * Database name node-pg opens from a postgres URL path.
 * Empty path / unparseable → null (fail closed at the disposable check).
 */
export function acceptancePackDatabaseName(raw) {
  if (raw == null || String(raw).trim() === '') return null
  let u
  try {
    u = new URL(String(raw))
  } catch {
    return null
  }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') return null
  let pathName = u.pathname || ''
  if (pathName.startsWith('/')) pathName = pathName.slice(1)
  if (pathName === '') return null
  try {
    pathName = decodeURI(pathName)
  } catch {
    return null
  }
  if (pathName.includes('/')) return null
  return pathName
}

export function isDisposableAcceptancePackDatabaseName(name) {
  if (typeof name !== 'string' || name === '') return false
  const folded = name.toLowerCase()
  if (ORDINARY_LOCAL_DB_NAMES.has(folded)) return false
  return ACCEPTANCE_PACK_DB_NAME_RE.test(folded) && folded === name
}

/**
 * Loopback + production + disposable DB name. Call before connect.
 * Does not check the marker (that needs a live connection on apply).
 */
export function assertAcceptancePackTarget(env = process.env) {
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
  const dbName = acceptancePackDatabaseName(env.DATABASE_URL)
  if (dbName == null) {
    return { ok: false, reason: 'not_disposable' }
  }
  const folded = dbName.toLowerCase()
  if (ORDINARY_LOCAL_DB_NAMES.has(folded) || folded === 'openchurch_local') {
    return { ok: false, reason: 'ordinary_local_refused' }
  }
  if (!isDisposableAcceptancePackDatabaseName(dbName)) {
    return { ok: false, reason: 'not_disposable' }
  }
  return { ok: true, reason: 'local_disposable', databaseName: dbName }
}

/**
 * Live check: disposable DB must carry the prepare-script sentinel.
 * Call only after assertAcceptancePackTarget passed and a client is open.
 */
export async function assertAcceptancePackMarker(db) {
  if (!db || typeof db.query !== 'function') {
    return { ok: false, reason: 'no_database' }
  }
  let rows
  try {
    const result = await db.query(
      `SELECT token FROM ${ACCEPTANCE_PACK_MARKER_TABLE} WHERE token = $1 LIMIT 1`,
      [ACCEPTANCE_PACK_MARKER_TOKEN],
    )
    rows = result.rows
  } catch (err) {
    // undefined_table / undefined_column → unmarked disposable
    if (err?.code === '42P01' || err?.code === '42703') {
      return { ok: false, reason: 'marker_missing' }
    }
    throw err
  }
  if (!rows?.length) {
    return { ok: false, reason: 'marker_missing' }
  }
  return { ok: true, reason: 'marker_present' }
}

/** SQL used by prepare-acceptance-pack-db.js (and tests). */
export function acceptancePackMarkerDdl() {
  return `
CREATE TABLE IF NOT EXISTS ${ACCEPTANCE_PACK_MARKER_TABLE} (
  token text PRIMARY KEY
    CHECK (token = '${ACCEPTANCE_PACK_MARKER_TOKEN}')
);
INSERT INTO ${ACCEPTANCE_PACK_MARKER_TABLE} (token)
VALUES ('${ACCEPTANCE_PACK_MARKER_TOKEN}')
ON CONFLICT (token) DO NOTHING;
COMMENT ON TABLE ${ACCEPTANCE_PACK_MARKER_TABLE} IS
  'Disposable acceptance-pack target marker (${ACCEPTANCE_PACK_MARKER_TOKEN}). Not application data.';
`
}

export function resolveAcceptancePack(env = process.env) {
  const target = assertAcceptancePackTarget(env)
  if (!target.ok) return target

  const email = (env.ACCEPTANCE_PACK_EMAIL || '').trim().toLowerCase()
  const password = env.ACCEPTANCE_PACK_PASSWORD || ''
  const orgName = (env.ACCEPTANCE_PACK_ORG_NAME || '').trim()
  const slugFromEnv = (env.ACCEPTANCE_PACK_ORG_SLUG || '').trim()
  const orgSlug = slugFromEnv || slugify(orgName)
  const userName = (env.ACCEPTANCE_PACK_USER_NAME || '').trim() || 'Synthetic Reviewer'
  const dryRun = !truthyApply(env.ACCEPTANCE_PACK_APPLY)

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

  return {
    ok: true,
    reason: dryRun ? 'dry_run' : 'ready',
    dryRun,
    databaseName: target.databaseName,
    config: {
      email,
      password,
      orgName,
      orgSlug,
      userName,
      // Least-privilege App Review login. Viewer may read Dashboard,
      // Schedule, Members, and Mass Intentions (including the sacristy
      // sheet). Bulletins stay admin-only at the API and are seeded for
      // inventory completeness, not for this login.
      role: 'viewer',
    },
  }
}

/** Planned row counts the seed would write. Pure; no I/O. */
export function acceptancePackPlan(config) {
  return {
    organization: 1,
    users: 1,
    role: config?.role || 'viewer',
    members: 3,
    preferredLanguages: ['en', 'es', 'both'],
    register: 1,
    intentions: 1,
    events: 1,
    calendarEvents: 1,
    checkins: 1,
    bulletins: 1,
  }
}
