// Signing / encryption / pepper secrets — one fail-closed rule.
//
// On a production-like runtime (productionLike(): NODE_ENV=production OR
// a platform-set VERCEL_ENV of production/preview) a secret that is
// missing, blank, or one of the repo's known dev fallbacks is a
// deployment fault and must throw. A preview deployment with NODE_ENV
// left at anything else used to sign sessions with a public constant.
//
// Outside production-like runtimes the dev fallback still applies so
// local dev and the test suite keep working. Error messages name the
// variable only — never its value.

import { productionLike } from './sessionCookie.js'

export const DEV_SIGNING_FALLBACKS = Object.freeze([
  'dev-only-change-me-please',
  'dev-only-checkin-pepper-change-me',
  'dev-only-ai-key-secret',
])

export function usableSecret(value) {
  if (typeof value !== 'string') return null
  const v = value.trim()
  if (!v) return null
  if (DEV_SIGNING_FALLBACKS.includes(v)) return null
  return value
}

// names: env var names tried in order (first usable wins).
// Returns the secret, or devFallback outside production-like runtimes.
export function requireSigningSecret(names, devFallback, {
  env = process.env,
} = {}) {
  const list = Array.isArray(names) ? names : [names]
  for (const n of list) {
    const v = usableSecret(env[n])
    if (v) return v
  }
  if (productionLike({ env: env.NODE_ENV, vercelEnv: env.VERCEL_ENV })) {
    throw new Error(`${list.join(' or ')} must be set to a non-dev value in production and preview`)
  }
  return devFallback
}
