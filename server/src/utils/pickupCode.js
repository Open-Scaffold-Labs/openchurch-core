// Child pickup codes (CHK.3) — generation, hashing, verification.
//
// A child check-in mints a short, human-readable one-time code. The
// guardian is shown the code ONCE (on the kiosk/check-in screen); to
// release the child, staff enter it and we compare keyed hashes. We store
// only the HMAC at rest — never the plaintext.
//
// Why an HMAC with a server-side pepper, NOT a bare SHA-256: the code is a
// 4-char code over a 30-char alphabet, i.e. ~810k combinations (~20 bits).
// A plain unsalted hash of that is reversible in well under a second, so a
// database dump would still expose every pickup code (and identical codes
// would share a hash). Keying the hash with CHECKIN_CODE_PEPPER — held
// OUTSIDE the database — means a dump alone can't reverse the codes. That is
// what actually makes the "a dump never reveals a pickup code" property true.
//
// The code is 4 chars over a non-ambiguous alphabet (no 0/O, 1/I/L) so it's
// easy to read off a tag. Codes are normalized (trim + upper-case) before
// hashing so comparison is case-insensitive on the way back in.

import crypto from 'crypto'

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

// Server-side pepper (HMAC key), kept out of the DB. Required in production —
// we fail closed rather than silently fall back to a public constant that
// would defeat the whole point of hashing a low-entropy code. Dev/test may
// run without it (fixed fallback + a loud warning), mirroring auth.js's
// JWT_SECRET handling.
const PEPPER = process.env.CHECKIN_CODE_PEPPER
if (process.env.NODE_ENV === 'production' && !PEPPER) {
  throw new Error('CHECKIN_CODE_PEPPER must be set in production')
}
const CODE_KEY = PEPPER || 'dev-only-checkin-pepper-change-me'
if (!PEPPER) {
  console.warn('[pickupCode] CHECKIN_CODE_PEPPER not set — using insecure dev pepper')
}

export function genSecurityCode() {
  let s = ''
  for (let i = 0; i < 4; i++) {
    s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]
  }
  return s
}

// Keyed HMAC-SHA256 of the normalized (trimmed, upper-cased) code, hex.
// Returns null for a falsy code so callers can pass through the
// members/guests case (no code) unchanged.
export function hashSecurityCode(code) {
  if (!code) return null
  const normalized = String(code).trim().toUpperCase()
  if (!normalized) return null
  return crypto.createHmac('sha256', CODE_KEY).update(normalized).digest('hex')
}

// Constant-time verification of a provided plaintext code against a stored
// hash. Both operands are fixed-length hex digests; timingSafeEqual avoids
// leaking the stored hash byte-by-byte — which, given the tiny keyspace,
// would otherwise be directly exploitable via an offline preimage search.
// Returns false for any missing/blank input or length mismatch.
export function verifySecurityCode(provided, storedHash) {
  const computed = hashSecurityCode(provided)
  if (!computed || !storedHash) return false
  const a = Buffer.from(computed, 'hex')
  const b = Buffer.from(String(storedHash), 'hex')
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}
