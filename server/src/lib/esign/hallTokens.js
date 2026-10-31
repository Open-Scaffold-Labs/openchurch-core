// Signing-link secrets for a parish hall agreement.
//
// Reused from the closed draft PR #347 (server/src/lib/esign/tokens.js),
// which ported open-hoa src/lib/esign/tokens.ts @ 8abfd78. This PR
// supersedes that draft. The certificate PDF sealer from #347 is not
// used here. The hall agreement stores a hash of the text, not a PDF.
//
// Upstream pin: @openscaffold/esign main ea02cb3. On 2026-10-27 the
// workspace token received 404 for Open-Scaffold-Labs/openscaffold-esign.
// Only the hash is stored for comparison. The raw token is sealed so the
// office can show the same link again. The raw token is never written to
// the event log.

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto'

function authSecret() {
  const set = process.env.JWT_SECRET
  if (set) return set
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET is required to seal a signing link')
  }
  return 'dev-only-change-me-please'
}

function key(purpose) {
  return Buffer.from(hkdfSync('sha256', Buffer.from(authSecret()), Buffer.from('esign-v2'), Buffer.from(purpose), 32))
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function parishTokenPrefix(organizationId) {
  const n = Number(organizationId)
  if (!Number.isInteger(n) || n <= 0) throw new Error('parish id required')
  return `org${String(n).padStart(6, '0')}`
}

// A sent link opens for 30 days from sent_at (hallSign.js). Replacing a
// link restarts that clock (SP-241), so a new link is never born expired.
export const SIGN_LINK_TTL_MS = 30 * 24 * 60 * 60 * 1000

export function sentLinkExpired(sentAt, now = Date.now()) {
  const t = new Date(sentAt).getTime()
  return !Number.isFinite(t) || sentAt == null || now - t > SIGN_LINK_TTL_MS
}

// A link to a signed agreement opens the signed copy for 30 days.
// The clock is the later of signed_at (signature record, never moved)
// and sent_at (restarted when the office replaces the link). Without
// that, rotate on a signed agreement older than 30 days minted a token
// that was born expired (SP-247).
export function signLinkExpired(row, now = Date.now()) {
  if (row.status === 'sent') return sentLinkExpired(row.sent_at, now)
  if (row.status === 'signed') {
    const times = [row.signed_at, row.sent_at]
      .map((v) => new Date(v).getTime())
      .filter(Number.isFinite)
    if (!times.length) return true
    return now - Math.max(...times) > SIGN_LINK_TTL_MS
  }
  return false
}

export function newSigningToken(organizationId) {
  return `${parishTokenPrefix(organizationId)}.${randomBytes(32).toString('base64url')}`
}

export function hashSigningToken(token) {
  return sha256(`esign-link:${token}`)
}

export function tokenFingerprint(token) {
  return hashSigningToken(token).slice(0, 12)
}

export function sealToken(token) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key('link'), iv)
  const body = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])
  return `v1.${iv.toString('base64url')}.${body.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`
}

export function unsealToken(sealed) {
  const [v, iv, body, tag] = (sealed ?? '').split('.')
  if (v !== 'v1' || !iv || !body || !tag) return null
  try {
    const decipher = createDecipheriv('aes-256-gcm', key('link'), Buffer.from(iv, 'base64url'))
    decipher.setAuthTag(Buffer.from(tag, 'base64url'))
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

export const ESIGN_UPSTREAM = Object.freeze({
  name: '@openscaffold/esign',
  commit: 'ea02cb3',
  readable: false,
  reused_from: 'OpenChurch PR #347 token hash, seal, and copy-link loop',
})
