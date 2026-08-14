// Per-org AI credentials (AIP.1) — encryption + lookup.
//
// A parish that plugs in its own key pays its own AI bill and gets its
// own rate limits; everyone else rides the platform's keys. The key is
// AES-256-GCM encrypted at rest with a key derived from AI_KEY_SECRET
// (or JWT_SECRET as the fallback — already required-at-boot in prod).
// The plaintext key exists only in memory during a request; no API ever
// returns it after write — only the last four characters.
//
// Storage format: base64(iv).base64(authTag).base64(ciphertext)

import crypto from 'node:crypto'
import pool from '../db.js'

function derivedKey() {
  const secret = process.env.AI_KEY_SECRET || process.env.JWT_SECRET || 'dev-only-ai-key-secret'
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

// → { provider, apiKey, model, last4 } | null (null = ride the platform)
export async function getOrgProvider(orgId) {
  const { rows } = await pool.query(
    'SELECT ai_provider, ai_api_key_enc, ai_model FROM ochr_organizations WHERE id = $1',
    [orgId]
  )
  const row = rows[0]
  if (!row?.ai_provider || !row.ai_api_key_enc) return null
  const apiKey = decryptApiKey(row.ai_api_key_enc)
  return {
    provider: row.ai_provider,
    apiKey,
    model: row.ai_model || null,
    last4: apiKey.slice(-4),
  }
}
