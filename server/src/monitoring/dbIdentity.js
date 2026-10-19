// db_identity — a versioned, non-secret fingerprint of WHICH database the
// health probe actually reached. Diagnostic only: it measures runtime
// configuration plus connection metadata. It is not a cryptographic
// attestation of the provider. Algorithm: docs/HEALTH-DB-IDENTITY.md.
//
// Inputs, and nothing else:
//   - the Supabase project ref, parsed from the runtime DATABASE_URL
//     (direct host db.<ref>.supabase.co, or pooler user postgres.<ref> at
//     <x>.pooler.supabase.com);
//   - current_database() and current_schema() from the SAME successful
//     health probe.
// Any query parameter outside a benign allowlist → unknown (DBID-F1).
// Never read, returned or logged: password, raw username, query string,
// full URL, error text. Any doubt → an explicit unknown with no fingerprint.

import { createHash } from 'node:crypto'

export const DB_IDENTITY_VERSION = 'v1'
const DOMAIN = 'openchurch-db-identity'
const REF = /^[a-z0-9]{20}$/
const DIRECT_HOST = /^db\.([a-z0-9]{20})\.supabase\.co$/
const POOLER_HOST = /^[a-z0-9-]+\.pooler\.supabase\.com$/
const POOLER_USER = /^postgres\.([a-z0-9]{20})$/
// DBID-F1: pg-connection-string copies EVERY query parameter into the pg
// config, so host=, hostaddr=, user=, port=, dbname=, service=, options=,
// password= and unknown keys can change where (or as whom) pg connects.
// Strict allowlist: only these keys, which never change the target, may be
// present. Anything else, or a fragment → unknown.
const BENIGN_PARAMS = new Set(['sslmode', 'application_name', 'connect_timeout'])

// → { ref, form } or null. Never throws, never echoes input.
export function supabaseRefFromUrl(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return null
  let u
  try { u = new URL(raw) } catch { return null }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') return null
  if (u.hash !== '' || raw.includes('#')) return null
  for (const key of u.searchParams.keys()) if (!BENIGN_PARAMS.has(key)) return null
  const host = u.hostname.toLowerCase()
  let user
  try { user = decodeURIComponent(u.username) } catch { return null }
  const userRef = POOLER_USER.exec(user)?.[1] ?? null
  const direct = DIRECT_HOST.exec(host)
  if (direct) {
    const ref = direct[1]
    // A pooler-style user naming a DIFFERENT project is ambiguous.
    if (user !== 'postgres' && userRef !== ref) return null
    return { ref, form: 'direct' }
  }
  if (POOLER_HOST.test(host)) {
    if (!userRef) return null
    return { ref: userRef, form: 'pooler' }
  }
  return null
}

const ok = s => typeof s === 'string' && s.length > 0 && s.length <= 128

// The canonical tuple, exactly as hashed.
export function canonicalTuple(ref, database, schema) {
  return JSON.stringify([DOMAIN, DB_IDENTITY_VERSION, ref, database, schema])
}

export function fingerprint(ref, database, schema) {
  return createHash('sha256').update(canonicalTuple(ref, database, schema), 'utf8').digest('hex')
}

export const UNKNOWN_IDENTITY = Object.freeze({
  version: DB_IDENTITY_VERSION, status: 'unknown', form: null, fingerprint: null,
})

// probe: { database, schema } from a SUCCESSFUL probe, or null when it failed.
export function dbIdentity(rawUrl, probe) {
  try {
    if (!probe || !ok(probe.database) || !ok(probe.schema)) return UNKNOWN_IDENTITY
    const parsed = supabaseRefFromUrl(rawUrl)
    if (!parsed || !REF.test(parsed.ref)) return UNKNOWN_IDENTITY
    return {
      version: DB_IDENTITY_VERSION,
      status: 'measured',
      form: parsed.form,
      fingerprint: fingerprint(parsed.ref, probe.database, probe.schema),
    }
  } catch {
    return UNKNOWN_IDENTITY
  }
}
