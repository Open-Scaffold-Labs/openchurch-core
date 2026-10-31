// X-6 / FD-3 / A9: pure helpers for the scheduled encrypted export to a
// private Vercel Blob store and its isolated restore rehearsal.
//
// Everything here is side-effect free so the guards can be unit tested
// without a database, a token or a network (lib.test.mjs).

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { classifyDatabaseUrl, requireLocalRehearsal } from '../lib/db-target-guard.mjs'

export const PREFIX_DEFAULT = 'db-backups/openchurch-prod/'
// OPERATIONAL DEFAULT, NOT A LEGAL RETENTION PERIOD. José/Dale (and counsel
// for records retention) must confirm. Override with OC_BACKUP_KEEP_DAILY.
export const KEEP_DAILY_DEFAULT = 14
export const KEEP_DAILY_MIN = 3
export const KEEP_DAILY_MAX = 400

// Ports that belong to other people's databases on the shared box. The
// restore rehearsal never targets them, even on loopback.
export const FORBIDDEN_RESTORE_PORTS = new Set([5433])

const STAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})Z$/
const OBJECT_RE = /^(.*\/)?openchurch-(\d{4}-\d{2}-\d{2}T\d{6}Z)\.(dump\.age|manifest\.json)$/

export function stampFor(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new Error('stampFor: invalid date')
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '')
}

export function normalizePrefix(raw) {
  const p = raw == null || raw === '' ? PREFIX_DEFAULT : String(raw)
  if (!/^[a-z0-9][a-z0-9._/-]*\/$/.test(p) || p.includes('..') || p.includes('//')) {
    throw new Error(`OC_BACKUP_BLOB_PREFIX must be lowercase path segments ending in "/" (got ${JSON.stringify(p)})`)
  }
  return p
}

export function objectNames(prefix, date) {
  const stamp = stampFor(date)
  return {
    stamp,
    dump: `${prefix}openchurch-${stamp}.dump.age`,
    manifest: `${prefix}openchurch-${stamp}.manifest.json`,
  }
}

export function parseObjectName(pathname) {
  const m = OBJECT_RE.exec(pathname || '')
  if (!m) return null
  const s = STAMP.exec(m[2])
  const at = new Date(Date.UTC(+s[1], +s[2] - 1, +s[3], +s[4], +s[5], +s[6]))
  return { stamp: m[2], kind: m[3] === 'dump.age' ? 'dump' : 'manifest', at }
}

export function parseKeepDaily(raw) {
  if (raw == null || raw === '') return KEEP_DAILY_DEFAULT
  if (!/^\d+$/.test(String(raw))) throw new Error(`OC_BACKUP_KEEP_DAILY must be a whole number (got ${JSON.stringify(raw)})`)
  const n = Number(raw)
  if (n < KEEP_DAILY_MIN || n > KEEP_DAILY_MAX) {
    throw new Error(`OC_BACKUP_KEEP_DAILY must be between ${KEEP_DAILY_MIN} and ${KEEP_DAILY_MAX} (got ${n})`)
  }
  return n
}

// Group listed blobs into backup sets keyed by stamp. Anything under the
// prefix that is not one of our names is reported, never deleted.
export function groupSets(blobs, prefix) {
  const sets = new Map()
  const foreign = []
  for (const b of blobs) {
    if (!b.pathname.startsWith(prefix)) continue
    const p = parseObjectName(b.pathname)
    if (!p || b.pathname.slice(prefix.length).includes('/')) { foreign.push(b.pathname); continue }
    const s = sets.get(p.stamp) || { stamp: p.stamp, at: p.at, dump: null, manifest: null }
    s[p.kind] = b
    sets.set(p.stamp, s)
  }
  return { sets: [...sets.values()].sort((a, b) => b.at - a.at), foreign }
}

// R370-2: a set QUALIFIES for retention only when both objects exist, its
// manifest was read and validates, the manifest stamp matches the object
// name, and the listed dump size equals manifest.dump.encrypted_bytes (> 0).
// `manifests` maps stamp -> parsed manifest JSON (or undefined/null/an
// Error when it could not be read or parsed). No decryption is needed.
export function qualifySet(s, manifests) {
  if (!s.dump) return 'missing dump'
  if (!s.manifest) return 'missing manifest'
  if (!(s.dump.size > 0)) return 'zero-byte dump'
  const m = manifests?.get?.(s.stamp)
  if (m == null || m instanceof Error) return 'manifest unreadable'
  try { validateManifest(m) } catch (e) { return e.message }
  if (m.stamp !== s.stamp) return 'manifest stamp does not match object name'
  if (m.dump.encrypted_bytes !== s.dump.size) return `dump size ${s.dump.size} != manifest ${m.dump.encrypted_bytes}`
  return null
}

// Keep the newest `keep` QUALIFYING sets; delete only OLDER qualifying sets.
// Unqualified sets (incomplete, orphan, malformed, truncated) and foreign
// objects are never deleted; they are reported for separate cleanup. Never
// deletes when `keep` or fewer qualifying sets exist.
export function planPrune(blobs, { prefix, keep, manifests }) {
  if (!Number.isInteger(keep) || keep < KEEP_DAILY_MIN) throw new Error('planPrune: keep below minimum')
  const { sets, foreign } = groupSets(blobs, prefix)
  const good = []; const unverified = []
  for (const s of sets) { const why = qualifySet(s, manifests); if (why) unverified.push({ stamp: s.stamp, why }); else good.push(s) }
  if (good.length <= keep) return { keep: good.map(s => s.stamp), delete: [], foreign, unverified }
  const kept = good.slice(0, keep)
  const del = good.slice(keep).flatMap(s => [s.dump.pathname, s.manifest.pathname])
  return { keep: kept.map(s => s.stamp), delete: del, foreign, unverified }
}

// Restore picks the newest set with both objects; it then validates the
// manifest, stamp and both sha256s before restoring anything.
export function latestComplete(blobs, prefix) {
  return groupSets(blobs, prefix).sets.find(s => s.dump && s.manifest) || null
}

const HEX64 = /^[0-9a-f]{64}$/

// The manifest carries no row data, no names, no connection details.
export function buildManifest({ stamp, createdAt, encrypted, plain, migration, tableCount, tocEntries, pgDumpVersion, serverVersion, gitSha, encryption }) {
  const m = {
    format: 'openchurch-backup-manifest/v1',
    stamp,
    created_at: createdAt,
    dump: { format: 'pg_dump custom (-Fc)', encrypted_bytes: encrypted.bytes, encrypted_sha256: encrypted.sha256,
      plain_bytes: plain.bytes, plain_sha256: plain.sha256, toc_entries: tocEntries },
    encryption,
    schema: { migration_head: migration.head, migration_count: migration.count, public_table_count: tableCount },
    tools: { pg_dump: pgDumpVersion, server: serverVersion },
    source_commit: gitSha || null,
  }
  validateManifest(m)
  return m
}

export function validateManifest(m) {
  const fail = why => { throw new Error(`manifest invalid: ${why}`) }
  if (!m || m.format !== 'openchurch-backup-manifest/v1') fail('format')
  if (!STAMP.test(m.stamp || '')) fail('stamp')
  for (const k of ['encrypted_sha256', 'plain_sha256']) if (!HEX64.test(m.dump?.[k] || '')) fail(k)
  for (const k of ['encrypted_bytes', 'plain_bytes', 'toc_entries']) if (!(Number.isInteger(m.dump?.[k]) && m.dump[k] > 0)) fail(k)
  if (!(Number.isInteger(m.schema?.public_table_count) && m.schema.public_table_count > 0)) fail('public_table_count')
  if (!(Number.isInteger(m.schema?.migration_count) && m.schema.migration_count > 0)) fail('migration_count')
  if (typeof m.schema?.migration_head !== 'string' || !m.schema.migration_head) fail('migration_head')
  if (m.encryption?.tool !== 'age') fail('encryption.tool')
  const text = JSON.stringify(m)
  if (/postgres(ql)?:\/\//i.test(text) || /BLOB_READ_WRITE|AGE-SECRET-KEY/i.test(text)) fail('contains a connection string or key material')
  return m
}

// Export side: the source must be set, must be postgres, and must NOT be
// loopback by accident in CI (a loopback source in the scheduled workflow
// means a misconfigured secret, not a backup). Local e2e passes allowLocal.
export function checkExportEnv(env, { allowLocal = false } = {}) {
  const errs = []
  const cls = classifyDatabaseUrl(env.OC_BACKUP_DATABASE_URL)
  if (cls.kind === 'missing') errs.push('OC_BACKUP_DATABASE_URL is not set')
  else if (cls.kind === 'invalid') errs.push('OC_BACKUP_DATABASE_URL is not a valid postgres URL')
  else if (cls.kind === 'local' && !allowLocal) errs.push('OC_BACKUP_DATABASE_URL is loopback; the scheduled export must point at the production read-only role')
  if (cls.kind !== 'missing' && cls.kind !== 'invalid' && !resolvePgTarget(env.OC_BACKUP_DATABASE_URL).ok) {
    errs.push('OC_BACKUP_DATABASE_URL has connection overrides (query host/port/etc., multiple hosts or a socket); only ?sslmode= is allowed')
  }
  const r = (env.OC_BACKUP_AGE_RECIPIENT || '').trim()
  if (!r) errs.push('OC_BACKUP_AGE_RECIPIENT is not set')
  else if (!/^age1[0-9a-z]{58}$/.test(r)) errs.push('OC_BACKUP_AGE_RECIPIENT is not an age X25519 public key (age1...)')
  if (/AGE-SECRET-KEY/i.test(env.OC_BACKUP_AGE_RECIPIENT || '')) errs.push('OC_BACKUP_AGE_RECIPIENT holds a SECRET key; only the public recipient belongs in CI')
  if (!env.OC_BACKUP_BLOB_STUB_DIR && !env.BLOB_READ_WRITE_TOKEN) errs.push('BLOB_READ_WRITE_TOKEN is not set')
  if (env.OC_BACKUP_BLOB_STUB_DIR && env.GITHUB_ACTIONS === 'true') errs.push('OC_BACKUP_BLOB_STUB_DIR is a local test stub and is refused in GitHub Actions')
  return errs
}

// Restore side: loopback only, explicit OCHR_REHEARSAL=local, never port
// 5433 (Saint's openchurch_local) or any extra port in
// OC_BACKUP_FORBIDDEN_PORTS, and never a URL equal to the export source.
export function checkRestoreTarget(env) {
  const url = env.OC_RESTORE_DATABASE_URL
  const g = requireLocalRehearsal({ rehearsal: env.OCHR_REHEARSAL, urls: [{ label: 'OC_RESTORE_DATABASE_URL', url }] })
  if (!g.ok) return g
  const t = resolvePgTarget(url, 'OC_RESTORE_DATABASE_URL')
  if (!t.ok) return t
  if (!t.loopback) return { ok: false, code: 2, reason: 'OC_RESTORE_DATABASE_URL is not loopback. Refusing.' }
  const extra = String(env.OC_BACKUP_FORBIDDEN_PORTS || '').split(',').map(s => Number(s.trim())).filter(Boolean)
  if (FORBIDDEN_RESTORE_PORTS.has(t.port) || extra.includes(t.port)) {
    return { ok: false, code: 2, reason: `OC_RESTORE_DATABASE_URL port ${t.port} is reserved (not a throwaway). Refusing.` }
  }
  if (env.OC_BACKUP_DATABASE_URL) {
    const src = resolvePgTarget(env.OC_BACKUP_DATABASE_URL, 'OC_BACKUP_DATABASE_URL')
    if (!src.ok || env.OC_BACKUP_DATABASE_URL === url || targetIdentity(src) === targetIdentity(t)) {
      return { ok: false, code: 2, reason: 'OC_RESTORE_DATABASE_URL resolves to the export source (or the source cannot be resolved). Refusing to restore over the source.' }
    }
  }
  if (!/^oc_restore_[a-z0-9_]+$/.test(t.database)) {
    return { ok: false, code: 2, reason: `restore database must be named oc_restore_<suffix> so it is unmistakably a throwaway (got ${JSON.stringify(t.database)}). Refusing.` }
  }
  return { ok: true, port: t.port, database: t.database, target: t }
}

// R370-1: resolve a postgres URL ONCE into the exact host/port/user/db
// every child process uses (pgEnv takes this object, never the raw URL).
// Default-deny: anything libpq could read as a second source of host,
// port, database or user is refused rather than interpreted - query
// params other than sslmode (host, hostaddr, port, dbname, user, service,
// options, ...), duplicated params, multi-host lists, unix sockets and an
// empty host. Inherited PG* env vars are stripped by pgEnv.
const QUERY_ALLOW = new Set(['sslmode'])
const SSLMODES = new Set(['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'])
export function resolvePgTarget(raw, label = 'database URL') {
  const fail = why => ({ ok: false, code: 2, reason: `${label}: ${why}. Refusing.` })
  if (raw == null || String(raw).trim() === '') return fail('not set')
  const text = String(raw)
  if (/[\s]/.test(text)) return fail('contains whitespace')
  let u
  try { u = new URL(text) } catch { return fail('not a valid URL') }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') return fail('not a postgres:// URL')
  const authority = text.slice(u.protocol.length + 2).split(/[/?#]/)[0]
  const hostport = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority
  if (hostport.includes(',')) return fail('multiple hosts are not allowed')
  if (!u.hostname || hostport.startsWith('%2F') || hostport.startsWith('%2f')) return fail('a host is required (unix sockets are not allowed)')
  if (u.hash) return fail('fragment not allowed')
  const seen = new Set()
  for (const [k, v] of u.searchParams) {
    if (seen.has(k)) return fail(`duplicate query parameter ${k}`)
    seen.add(k)
    if (!QUERY_ALLOW.has(k)) return fail(`query parameter ${k} is not allowed (connection overrides are refused)`)
    if (k === 'sslmode' && !SSLMODES.has(v)) return fail('bad sslmode')
  }
  if (u.port && !/^\d{1,5}$/.test(u.port)) return fail('bad port')
  const port = Number(u.port || 5432)
  let database, user, password
  try {
    database = decodeURIComponent(u.pathname.replace(/^\//, '')) || 'postgres'
    user = decodeURIComponent(u.username || ''); password = decodeURIComponent(u.password || '')
  } catch { return fail('bad percent-encoding') }
  if (database.includes('/')) return fail('bad database name')
  let host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const loopback = host === 'localhost' || host === '::1' || /^127\./.test(host)
  return { ok: true, host, port, database, user, password, sslmode: u.searchParams.get('sslmode') || null, loopback }
}

// Same server + database regardless of spelling (localhost vs 127.0.0.1).
export function targetIdentity(t) {
  return `${t.loopback ? 'loopback' : t.host}:${t.port}/${t.database}`
}

export function sha256File(path) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(path).on('error', reject).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex')))
  })
}
