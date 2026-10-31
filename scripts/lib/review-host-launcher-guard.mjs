// Shipped safety checks for local rehearsal launchers. No import of docs/.
//
// Pure env guard (R284-5). No I/O, no pg.
//
// The launcher is strictly local, so this is stricter than the shared
// recovery guard it reuses (scripts/lib/db-target-guard.mjs
// classifyDatabaseUrl, which already checks EVERY ?host= / ?hostaddr= value):
//   - the scheme must be postgres: or postgresql:
//   - the URL authority must be ONE loopback host (no empty host, no
//     comma multi-host list)
//   - ANY host/hostaddr query key (any case, any count, even loopback) is
//     refused. node-postgres picks the LAST duplicate and libpq accepts
//     comma lists there, so "which one wins" is never decided here.
//   - PGHOST / PGHOSTADDR must be unset (they are a driver host source when
//     the URL host is empty, and an ambiguity otherwise)
// No remote acknowledgement escape exists.
//
// Provider names are refused here when non-empty. This function stays pure:
// it does not read .env files and it does not load dotenv. The launcher
// calls enforceNoProvider (review-host-no-provider.mjs) after this check
// and before importing the app, which is what stops dotenv/config from
// restoring a name that was only deleted.
import { classifyDatabaseUrl, isLoopbackHost } from './db-target-guard.mjs'

// Names that select a live provider, a provider credential, or backup
// storage that can leave the machine. Empty is the same as unset: the
// server uses truthiness. The five names a direct checkLaunchEnv call must
// refuse are RESEND_API_KEY, ANTHROPIC_API_KEY, SENTRY_DSN,
// VAPID_PRIVATE_KEY, and BACKUP_STORAGE.
export const PROVIDER_KEYS = Object.freeze([
  'RESEND_API_KEY',
  'ANTHROPIC_API_KEY',
  'SENTRY_DSN',
  'VAPID_PRIVATE_KEY',
  'BACKUP_STORAGE',
  'RESEND_WEBHOOK_SECRET',
  'OPENAI_API_KEY',
  'AI_KEY_SECRET',
  'VAPID_PUBLIC_KEY',
  'PAYMENTS_PROVIDER',
  'PAYMENTS_PROVIDER_SECRET',
  'BILLING_PROVIDER_SECRET',
  'BILLING_WEBHOOK_SECRET',
  'BACKUP_S3_BUCKET',
  'BACKUP_S3_REGION',
  'BACKUP_S3_KEY_ID',
  'BACKUP_S3_SECRET',
  'BACKUP_S3_ENDPOINT',
  'BACKUP_S3_FORCE_PATH_STYLE',
])

export function providerEnvRefusal(env) {
  for (const name of PROVIDER_KEYS) {
    if (env[name]) return `${name} must be unset (no-provider rehearsal)`
  }
  return null
}

const LOOP_BIND = new Set(['127.0.0.1', '::1'])
const FORBIDDEN_SET = ['VERCEL_ENV', 'LOGIN_MAX_PER_ACCOUNT', 'LOGIN_MAX_PER_IP', 'CORS_ORIGINS', 'CLIENT_URL',
  'DIOCESE_CLIENT_URL', 'SEED_DEMO', 'SEED_APP_REVIEW_TENANT', 'APP_REVIEW_ALLOW_REMOTE', 'PGHOST', 'PGHOSTADDR']

export function checkDatabaseUrl(raw) {
  const cls = classifyDatabaseUrl(raw)
  if (cls.kind !== 'local') return `DATABASE_URL is ${cls.kind}`
  let u
  try { u = new URL(String(raw)) } catch { return 'DATABASE_URL unparsable' }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') return 'DATABASE_URL scheme must be postgres(ql)'
  // Raw authority, before WHATWG normalisation: exactly one host token.
  const authority = String(raw).replace(/^[a-z]+:\/\//i, '').split(/[/?#]/)[0]
  const hostPart = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority
  if (!hostPart || hostPart.includes(',')) return 'DATABASE_URL must name exactly one host'
  if (!isLoopbackHost(u.hostname)) return 'DATABASE_URL host is not loopback'
  for (const k of u.searchParams.keys()) {
    const f = k.toLowerCase()
    if (f === 'host' || f === 'hostaddr') return `DATABASE_URL ?${k}= override refused (local launcher accepts none)`
  }
  return null
}

// Documented dev server (review-host-run.mjs server). index.js migrates on
// startup, so this is the same strict URL rule as the cookie launcher,
// plus the PGHOST / PGHOSTADDR refusal, and it requires the documented
// development mode. Production stays on launcher mode. Pure: no I/O.
export function checkDevServerEnv(env) {
  if (env.NODE_ENV !== 'development') return 'NODE_ENV must be development (documented dev server)'
  for (const k of ['PGHOST', 'PGHOSTADDR']) if (env[k]) return `${k} must be unset`
  return checkDatabaseUrl(env.DATABASE_URL)
}

export function checkLaunchEnv(env) {
  if (env.NODE_ENV !== 'production') return 'NODE_ENV must be production (hosted settings)'
  const provider = providerEnvRefusal(env)
  if (provider) return provider
  for (const k of FORBIDDEN_SET) if (env[k]) return `${k} must be unset`
  const db = checkDatabaseUrl(env.DATABASE_URL)
  if (db) return db
  const host = env.BIND_HOST || '127.0.0.1'
  if (!LOOP_BIND.has(host)) return 'BIND_HOST must be a loopback IP'
  if (!env.TLS_CERT || !env.TLS_KEY) return 'TLS_CERT and TLS_KEY required'
  return null
}
