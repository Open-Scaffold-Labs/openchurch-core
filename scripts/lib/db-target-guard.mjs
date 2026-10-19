import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'

const require = createRequire(import.meta.url)

// Shared fail-closed database target resolution for local recovery /
// rehearsal tooling (RECOVERY-L3-05).
//
// A loopback authority with a remote ?host= / ?hostaddr= is NOT local —
// libpq prefers those query params over the URL authority (Sentinel #154,
// same rule as scripts/demo-rehearsal.mjs).
//
// Destructive or write-capable rehearsal scripts must also see an explicit
// safe-environment identity (OCHR_REHEARSAL=local). NODE_ENV is never a
// safety mechanism.

export const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

// Raw ASCII whitespace in a non-blank URL is refused before `new URL`.
//
// WHATWG strips leading and trailing U+0020 (and C0 controls) before
// parsing. pg-connection-string 2.14.0 matches a raw U+0020 and runs
// `encodeURI` first, so that space stays in `ConnectionParameters.database`
// (`openchurch_local `). The same path written as `%20` is that same driver
// name. Parsing first made both guards return ok:true. Tab, newline, and
// the other ASCII whitespace characters are included because WHATWG strips
// them at the ends, and a destructive rehearsal must not depend on that
// strip. A string that is only whitespace stays `missing`. Encoded `%20`
// and spaces in `PGDATABASE` or the user are not this check — node-pg keeps
// those, and trimming them is a different hole.
//
// Secondary, not this check: a `%2F` / `%2f` authority host
// (`postgresql://postgres@%2Ftmp?host=127.0.0.1` and
// `postgresql://%2Ftmp?host=127.0.0.1`). pg-connection-string prepends that
// hostname onto the path when query `host` is set, so both driver databases
// are `%2Ftmp`. This guard refuses that authority in both rehearsal and identity checks.
// `classifyDatabaseUrl` treats the authority as remote, so
// `requireLocalRehearsal` returns ok:false and the drills exit 2 before
// identity. Identity resolution also refuses it; no prepend emulation is needed.
const RAW_URL_WHITESPACE = /[ \t\n\r\f\v]/

function hasRawUrlWhitespace(raw) {
  if (raw == null) return false
  const text = String(raw)
  if (text.trim() === '') return false
  return RAW_URL_WHITESPACE.test(text)
}

// pg-connection-string 2.14.0, before `new URL`:
//
//   if (/ |%[^a-f0-9]|%[a-f0-9][^a-f0-9]/i.test(str)) {
//     str = encodeURI(str).replace(/%25(\d\d)/g, '%$1')
//   }
//
// A raw space is already refused above. The other alternative is an
// invalid `%` (not two hex digits) anywhere in the string — a junk query
// (`?x=%g`) or a password (`s3cretPASS%real`). `encodeURI` turns every
// `%` into `%25`, and the replace puts back only `%25` plus two decimal
// digits. A valid escape whose hex contains A–F therefore stays encoded
// for the driver (`openchurch%2Elocal`, host `%6Cocalhost`) while WHATWG
// plus `decodeURI` turns it into a dot or `localhost`. Both guards then
// returned ok:true. The same rewrite is what makes
// `postgresql://postgres:s3cretPASS%real@localhost:5433/mydb%2Ebackup`
// and an empty path with `PGDATABASE=mydb%2Ebackup` one driver database.
//
// Refuse all malformed escapes, including terminal `%` / `%2` in query
// values. Do not emulate the rewrite. A `%` that is two hex
// digits, including `%40` in a password or `%6C` with no invalid `%`
// beside it, does not match and is unchanged. `%2Ftmp?host=` is still
// the documented boundary above, not this check.
const PG_INVALID_PERCENT = /%(?![a-f0-9]{2})/i

function hasInvalidPgPercent(raw) {
  if (raw == null) return false
  const text = String(raw)
  if (text.trim() === '') return false
  return PG_INVALID_PERCENT.test(text)
}

// pg-connection-string 2.14.0 treats `socket:` as a unix-socket URL: the
// host is `decodeURI(pathname)`, and the database is the query `db`.
// `socket://localhost/tmp/pg.sock?db=openchurch_local` is driver host
// `/tmp/pg.sock`, not the authority token `localhost`. An empty pathname
// is a falsy host, so ConnectionParameters then uses `PGHOST` or the
// driver's default host. WHATWG still reports hostname `localhost`, and
// both guards returned ok:true. Refuse the protocol. Do not try to decide
// which socket paths are local.
function isSocketDatabaseUrl(raw) {
  if (raw == null) return false
  const text = String(raw)
  if (text.trim() === '') return false
  if (hasRawUrlWhitespace(text)) return false
  try {
    return new URL(text).protocol === 'socket:'
  } catch {
    return false
  }
}

// Malformed escapes anywhere are rejected by hasInvalidPgPercent. This
// additional path check catches valid hex escapes that are invalid UTF-8
// for decodeURI, before the driver can throw.
function hasUndecodableDatabasePath(raw) {
  if (raw == null) return false
  const text = String(raw)
  if (text.trim() === '') return false
  if (hasRawUrlWhitespace(text) || hasInvalidPgPercent(text)) return false
  let u
  try {
    u = new URL(text)
  } catch {
    return false
  }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') return false
  let pathName = u.pathname || ''
  if (pathName.startsWith('/')) pathName = pathName.slice(1)
  if (pathName === '') return false
  try {
    decodeURI(pathName)
    return false
  } catch {
    return true
  }
}

export function isLoopbackHost(name) {
  if (name == null || String(name).trim() === '') return false
  const h = String(name).trim()
  if (LOOPBACK.has(h)) return true
  const bare = h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h
  return LOOPBACK.has(bare) || LOOPBACK.has(`[${bare}]`)
}

// Query hosts are passed to node-pg verbatim after URL decoding. Unlike
// an IPv6 authority, query hosts must not be bracket-unwrapped or split.
function isExactLoopbackHost(name) {
  return name === 'localhost' || name === '127.0.0.1' || name === '::1'
}

export function classifyDatabaseUrl(raw) {
  if (raw == null || String(raw).trim() === '') return { kind: 'missing', hostname: null }
  if (hasRawUrlWhitespace(raw)) return { kind: 'invalid', hostname: null }
  if (hasInvalidPgPercent(raw)) return { kind: 'invalid', hostname: null }
  if (isSocketDatabaseUrl(raw)) return { kind: 'invalid', hostname: null }
  if (hasUndecodableDatabasePath(raw)) return { kind: 'invalid', hostname: null }
  let u
  try {
    u = new URL(String(raw))
  } catch {
    return { kind: 'invalid', hostname: null }
  }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') {
    return { kind: 'invalid', hostname: null }
  }
  if (!isLoopbackHost(u.hostname)) {
    return { kind: 'remote', hostname: u.hostname || null }
  }
  for (const key of ['host', 'hostaddr']) {
    // Check every override; a later query value must not hide an unsafe one.
    for (const value of u.searchParams.getAll(key)) {
      if (!isExactLoopbackHost(value)) {
        return { kind: 'remote', hostname: value || u.hostname || null }
      }
    }
  }
  return { kind: 'local', hostname: u.hostname }
}

// libpq matches parameter names case-insensitively. Userinfo password is
// separate from these query keys; both must be gone before a log line.
const SECRET_QUERY_KEYS = new Set(['password', 'sslpassword'])

/** Strip userinfo password and query `password` / `sslpassword` before any log line. */
export function redactDatabaseUrl(raw) {
  if (raw == null || String(raw).trim() === '') return '[missing url]'
  // Do not run WHATWG on a raw-whitespace URL. Stripping the space would
  // hide the input, and the raw text can carry a password.
  if (hasRawUrlWhitespace(raw)) return '[unparseable url]'
  // Same as raw whitespace: do not run WHATWG. The raw text can carry a
  // password, and parsing it would hide the encodeURI rewrite.
  if (hasInvalidPgPercent(raw)) return '[unparseable url]'
  // A socket URL or a path decodeURI rejects is not a loggable target.
  // The raw text can carry a password.
  if (isSocketDatabaseUrl(raw) || hasUndecodableDatabasePath(raw)) return '[unparseable url]'
  try {
    const u = new URL(String(raw))
    if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') return '[unparseable url]'
    if (u.password) u.password = '***'
    const secretKeys = new Set()
    for (const key of u.searchParams.keys()) {
      if (SECRET_QUERY_KEYS.has(String(key).toLowerCase())) secretKeys.add(key)
    }
    for (const key of secretKeys) u.searchParams.delete(key)
    return u.toString()
  } catch {
    return '[unparseable url]'
  }
}

/**
 * Fail closed unless OCHR_REHEARSAL is exactly `local` and every named URL
 * classifies as loopback (including libpq ?host= / ?hostaddr= overrides).
 *
 * @param {{ rehearsal?: string, urls: { label: string, url?: string|null }[] }} opts
 */
export function requireLocalRehearsal({ rehearsal, urls } = {}) {
  if (rehearsal !== 'local') {
    return {
      ok: false,
      code: 2,
      reason: 'OCHR_REHEARSAL must be exactly "local" before this recovery rehearsal. Refusing.',
    }
  }
  for (const { label, url } of urls || []) {
    if (hasRawUrlWhitespace(url)) {
      return {
        ok: false,
        code: 2,
        reason: `${label} contains raw whitespace. Refusing — recovery rehearsal will not parse a URL that contains raw whitespace.`,
      }
    }
    if (hasInvalidPgPercent(url)) {
      return {
        ok: false,
        code: 2,
        reason: `${label} contains an invalid percent-encoding. Refusing — recovery rehearsal will not parse a URL that node-pg rewrites with encodeURI.`,
      }
    }
    if (isSocketDatabaseUrl(url)) {
      return {
        ok: false,
        code: 2,
        reason: `${label} is a socket URL. Refusing — recovery rehearsal will not treat a socket URL as a loopback host.`,
      }
    }
    if (hasUndecodableDatabasePath(url)) {
      return {
        ok: false,
        code: 2,
        reason: `${label} database path is not valid percent-encoding. Refusing — recovery rehearsal will not parse a path that throws URIError.`,
      }
    }
    const cls = classifyDatabaseUrl(url)
    if (cls.kind === 'missing') {
      return {
        ok: false,
        code: 2,
        reason: `${label} is missing. Set a loopback URL (or \`node scripts/local-db.mjs env\`) and retry. Refusing.`,
      }
    }
    if (cls.kind !== 'local') {
      return {
        ok: false,
        code: 2,
        reason: `${label} host ${cls.hostname || '(unparseable)'} is not loopback (${redactDatabaseUrl(url)}). Refusing — recovery rehearsal cannot target production or a shared database.`,
      }
    }
  }
  const hosts = (urls || []).map(({ label, url }) => `${label}=${classifyDatabaseUrl(url).hostname}`).join(', ')
  return { ok: true, code: 0, reason: `local rehearsal (${hosts})` }
}

function foldName(name) {
  return String(name).toLowerCase()
}

// pg-connection-string keeps the last exact-case query key. `user` is
// case-sensitive there; `User` does not override the userinfo.
function lastExactQuery(u, key) {
  let seen = false
  let value = ''
  for (const [k, v] of u.searchParams.entries()) {
    if (k === key) {
      seen = true
      value = v
    }
  }
  return seen ? value : undefined
}

// node-pg 8.22 ConnectionParameters when the URL path is empty:
// database = PGDATABASE if set, otherwise the user. The user is the query
// `user` (if truthy), else the userinfo, else PGUSER, else the OS user.
// Query `dbname` is not read. Measured against pg 8.22.0 /
// pg-connection-string 2.14.0. This function does not import `pg`.
//
// `pg/lib/defaults.js` freezes that OS user when `pg` is first loaded.
// A later change to `env.USER` does not change a Pool created after that
// load. When `env` is this process's `process.env` and `pg` is already in
// the module cache, the frozen `defaults.user` is the OS user. A
// caller-supplied env object is a snapshot (tests); it is not that freeze.
// If two loaded copies disagree, the fallback is ambiguous.
function nodePgFallbackDatabase(u, env) {
  // Truthy check matches ConnectionParameters `val`: an empty PGDATABASE
  // falls through. Spaces are not trimmed — node-pg keeps them.
  if (env.PGDATABASE) return { ok: true, name: String(env.PGDATABASE).normalize('NFC') }
  let userinfo = ''
  try {
    userinfo = decodeURIComponent(u.username || '')
  } catch {
    return { ok: false, reason: 'ambiguous' }
  }
  const qUser = lastExactQuery(u, 'user')
  let user = qUser || userinfo || env.PGUSER
  if (!user) {
    const os = osUserForFallback(env)
    if (!os.ok) return os
    user = os.user || ''
  }
  if (!user) return { ok: false, reason: 'missing' }
  return { ok: true, name: String(user).normalize('NFC') }
}

function osUserForFallback(env) {
  if (env === process.env) {
    const loaded = loadedPgOsUser()
    if (loaded.state === 'ambiguous') return { ok: false, reason: 'ambiguous' }
    if (loaded.state === 'frozen') return { ok: true, user: loaded.user }
  }
  const live = process.platform === 'win32' ? env.USERNAME : env.USER
  return { ok: true, user: live == null ? '' : String(live) }
}

// Do not import `pg` here. Drills load the driver only after the gate, and
// importing it would freeze USER at guard-load time. Read the freeze only
// if some other module already loaded `pg`.
function loadedPgOsUser() {
  const cache = require.cache
  if (!cache) return { state: 'unloaded' }
  const users = []
  for (const key of Object.keys(cache)) {
    if (!isPgDefaultsCacheKey(key)) continue
    const exported = cache[key] && cache[key].exports
    if (!exported || typeof exported !== 'object' || !Object.prototype.hasOwnProperty.call(exported, 'user')) {
      return { state: 'ambiguous' }
    }
    users.push(exported.user)
  }
  if (users.length === 0) return { state: 'unloaded' }
  const first = users[0]
  for (const user of users) {
    if (user !== first) return { state: 'ambiguous' }
  }
  return { state: 'frozen', user: first == null ? '' : String(first) }
}

function isPgDefaultsCacheKey(key) {
  const normalized = String(key).split(sep).join('/')
  if (normalized.endsWith('/pg/lib/defaults.js')) return true
  if (!normalized.endsWith('/lib/defaults.js')) return false
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(key), '..', 'package.json'), 'utf8'))
    return pkg?.name === 'pg'
  } catch {
    return false
  }
}

// A raw slash, or a `%2F` that `decodeURI` deliberately leaves encoded, is
// not a second database. `%2F` and `%252F` are the same driver string
// (`openchurch_local%2F`); refusing both keeps SLASH-NAME fail-closed.
function hasSlashDatabaseName(name) {
  return name.includes('/') || /%2f/i.test(name)
}

// Database identity is what node-pg opens, not the raw URL and not a query
// `dbname` decoy. Host aliases, port, and credentials are not a different
// database. A path and a `?dbname=` that disagree, repeated `dbname` values
// that disagree, or a `dbname` that disagrees with the empty-path fallback
// are ambiguous. A slash in a name is ambiguous. Case folding is
// fail-closed: names that differ only by case are the same.
//
// The path is decoded with `decodeURI`, matching pg-connection-string 2.14
// (`config.database = pathname ? decodeURI(pathname) : null`). `decodeURI`
// leaves `# ? & @ + ; , : = $ /` encoded, so `%2523` and `%23` are both
// `x%23y`. `decodeURIComponent` turns only the second into `x#y` and would
// report two databases. Encoded spaces are kept: node-pg does not trim,
// and a trimmed path is not a different database from an untrimmed user or
// PGDATABASE. A raw space in the URL text is refused before `new URL`
// (see `hasRawUrlWhitespace`); it is not decoded into a name. An invalid
// `%` that would make pg-connection-string `encodeURI` the whole string
// is refused the same way (see `hasInvalidPgPercent`). A path `decodeURI`
// rejects, and a `socket:` URL, are refused before that parse.
function resolveDatabaseName(raw, env = process.env) {
  if (raw == null || String(raw).trim() === '') return { ok: false, reason: 'missing' }
  if (hasRawUrlWhitespace(raw)) return { ok: false, reason: 'raw whitespace' }
  if (hasInvalidPgPercent(raw)) return { ok: false, reason: 'invalid percent' }
  if (isSocketDatabaseUrl(raw)) return { ok: false, reason: 'socket url' }
  if (hasUndecodableDatabasePath(raw)) return { ok: false, reason: 'malformed path' }
  let u
  try {
    u = new URL(String(raw))
  } catch {
    return { ok: false, reason: 'unparseable' }
  }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') {
    return { ok: false, reason: 'unparseable' }
  }
  // Identity is supported only for accepted local targets. This also
  // refuses the pg authority-to-path prepend (%2Ftmp with a query host).
  if (classifyDatabaseUrl(raw).kind !== 'local') {
    return { ok: false, reason: 'unsupported local target' }
  }
  let pathName = u.pathname || ''
  if (pathName.startsWith('/')) pathName = pathName.slice(1)
  if (pathName !== '') {
    try {
      pathName = decodeURI(pathName)
    } catch {
      return { ok: false, reason: 'ambiguous' }
    }
    pathName = pathName.normalize('NFC')
    if (hasSlashDatabaseName(pathName)) return { ok: false, reason: 'ambiguous' }
  }

  const dbnames = []
  const seenKeys = new Set()
  for (const key of u.searchParams.keys()) {
    if (String(key).toLowerCase() !== 'dbname') continue
    if (seenKeys.has(key)) continue
    seenKeys.add(key)
    for (const value of u.searchParams.getAll(key)) {
      const decoded = String(value ?? '').normalize('NFC')
      if (hasSlashDatabaseName(decoded)) return { ok: false, reason: 'ambiguous' }
      dbnames.push(decoded)
    }
  }
  if (dbnames.some((name) => name === '')) return { ok: false, reason: 'ambiguous' }
  if (dbnames.some((name) => foldName(name) !== foldName(dbnames[0]))) {
    return { ok: false, reason: 'ambiguous' }
  }

  if (pathName !== '') {
    if (dbnames.length > 0 && foldName(dbnames[0]) !== foldName(pathName)) {
      return { ok: false, reason: 'ambiguous' }
    }
    return { ok: true, name: pathName }
  }

  const fallback = nodePgFallbackDatabase(u, env)
  if (!fallback.ok) return fallback
  // PGDATABASE and the user are not percent-decoded. A literal `%2F` there
  // is the driver database name. Only a raw slash is ambiguous.
  if (fallback.name.includes('/')) return { ok: false, reason: 'ambiguous' }
  // ARGUS-DBNAME: query dbname is not node-pg's database. On an empty path
  // the driver uses PGDATABASE or the user. A query value that disagrees is
  // a decoy — trusting it reported a distinct database while node-pg opened
  // the same one. libpq's reading of that decoy is not what this checks.
  if (dbnames.length > 0 && foldName(dbnames[0]) !== foldName(fallback.name)) {
    return { ok: false, reason: 'ambiguous' }
  }
  return { ok: true, name: fallback.name }
}

/**
 * Fail closed unless source and restore resolve to different database names.
 * Raw URL inequality is not identity: a loopback alias, a different
 * credential, query decoration, or an empty path (node-pg then uses
 * PGDATABASE, otherwise the user) can still name the same database.
 * `env`, when passed, replaces `process.env` for that fallback only.
 */
export function assertDistinctDatabaseUrls(a, b, { aLabel = 'DATABASE_URL', bLabel = 'RESTORE_URL', env = process.env } = {}) {
  const left = resolveDatabaseName(a, env)
  const right = resolveDatabaseName(b, env)
  if (!left.ok || !right.ok) {
    const part = (label, id) => (id.ok ? null : `${label} database name is ${id.reason}`)
    const bits = [part(aLabel, left), part(bLabel, right)].filter(Boolean)
    return {
      ok: false,
      code: 2,
      reason: `${bits.join(' and ')}. Refusing — source and restore identity must be unambiguous.`,
    }
  }
  if (left.name.toLowerCase() === right.name.toLowerCase()) {
    return {
      ok: false,
      code: 2,
      reason: `${bLabel} is the same database as ${aLabel}. Host aliases, credentials, query decoration, and an empty path are not a different database. Refusing.`,
    }
  }
  return { ok: true, code: 0, reason: `distinct database names (${left.name} vs ${right.name})` }
}

