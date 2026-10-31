// Per-org AI credentials (AIP.1) — encryption + lookup.
//
// A parish that plugs in its own key pays its own AI bill and gets its
// own rate limits. D-01: there is no platform key; a parish without its own
// key has AI off (409 ai_key_required). The key is
// AES-256-GCM encrypted at rest with a key derived from AI_KEY_SECRET
// (or JWT_SECRET as the fallback — already required-at-boot in prod).
// The plaintext key exists only in memory during a request; no API ever
// returns it after write — only the last four characters.
//
// Storage format: base64(iv).base64(authTag).base64(ciphertext)

import crypto from 'node:crypto'
import pool from '../db.js'
import { requireSigningSecret, usableSecret } from '../auth/signingSecrets.js'
import { productionLike } from '../auth/sessionCookie.js'

// R381-1: the encryption root must never silently change. An absent or
// empty AI_KEY_SECRET keeps the documented JWT_SECRET fallback; a
// non-empty AI_KEY_SECRET is the root, used byte-for-byte (never trimmed).
// If it is configured but rejected (whitespace-only or a known dev value)
// on a production-like runtime, refuse — do not fall through to
// JWT_SECRET, which would orphan existing ciphertext and mix keys.
function resolveAiKeySecret(env = process.env) {
  const configured = env.AI_KEY_SECRET
  if (typeof configured === 'string' && configured !== '') {
    if (usableSecret(configured)) return configured
    if (productionLike({ env: env.NODE_ENV, vercelEnv: env.VERCEL_ENV })) {
      throw new Error('AI_KEY_SECRET is set but invalid (blank or a known dev value); refusing to fall back to JWT_SECRET')
    }
    return configured // local/test: same bytes the legacy derivation used
  }
  return requireSigningSecret(['JWT_SECRET'], 'dev-only-ai-key-secret', { env })
}

function derivedKey() {
  const secret = resolveAiKeySecret()
  return crypto.createHash('sha256').update(`${secret}:ochr-org-ai-key`).digest()
}

export function encryptApiKey(plain) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', derivedKey(), iv)
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${ct.toString('base64')}`
}

export function decryptApiKey(enc) {
  const [iv, tag, ct] = enc.split('.').map(part => Buffer.from(part, 'base64'))
  const decipher = crypto.createDecipheriv('aes-256-gcm', derivedKey(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}

// R5-2: a stored provider the gate can never use (no key, or a key that no
// longer decrypts). Carries provider/model only, never key material.
export const AI_PROVIDER_BROKEN = 'ai_provider_broken'
function brokenProvider(row, message) {
  const err = new Error(message)
  err.code = AI_PROVIDER_BROKEN
  err.provider = row.ai_provider
  err.model = row.ai_model || null
  return err
}

// → { provider, apiKey, model, last4 } | null (null = ride the platform)
export async function getOrgProvider(orgId) {
  const { rows } = await pool.query(
    'SELECT ai_provider, ai_api_key_enc, ai_model FROM ochr_organizations WHERE id = $1',
    [orgId]
  )
  const row = rows[0]
  if (!row?.ai_provider) return null
  // R3-2: a provider chosen with no stored key is a broken configuration,
  // not "use the platform". Throw so the gate refuses (ai_unavailable).
  // R5-2: these two failures (and only these) mark the config as broken.
  if (!row.ai_api_key_enc) throw brokenProvider(row, 'org AI provider set without a key')
  let apiKey
  try {
    apiKey = decryptApiKey(row.ai_api_key_enc)
  } catch {
    throw brokenProvider(row, 'org AI provider key does not decrypt')
  }
  return {
    provider: row.ai_provider,
    apiKey,
    model: row.ai_model || null,
    last4: apiKey.slice(-4),
  }
}
