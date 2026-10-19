// RECOVERY-L3-05 — fail-closed local recovery / destructive-guard rehearsal.
//
//   node --test scripts/recovery-guard.test.mjs
//
// Proves: non-loopback and ambiguously resolved (?host=) targets refuse;
// OCHR_REHEARSAL identity is required; userinfo and query password /
// sslpassword are absent from reasons;
// distinct source/restore database names are enforced. Host aliases,
// credentials, and query decoration are not a different database. An
// empty path uses node-pg's database (PGDATABASE, otherwise the user),
// not a query dbname decoy. A non-blank URL with raw ASCII whitespace
// is refused before WHATWG parsing. A URL whose `%` would make
// pg-connection-string run its encodeURI pre-pass is refused the same
// way. A `socket:` URL is not a loopback host. A query `host` /
// `hostaddr` is compared without trimming, so BOM, NBSP, and ASCII
// padding cannot become `localhost`. A database path `decodeURI` rejects
// (`db%`) is refused before rehearsal. Does not claim PITR, hosted
// backup, or production rollback.

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  LOOPBACK,
  assertDistinctDatabaseUrls,
  classifyDatabaseUrl,
  redactDatabaseUrl,
  requireLocalRehearsal,
} from './lib/db-target-guard.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const LOCAL = 'postgresql://postgres@localhost:5433/openchurch_local'
const LOCAL_B = 'postgresql://postgres@127.0.0.1:5434/openchurch_restore'
const REMOTE = 'postgresql://user:s3cretPASS@db.prod.example:5432/postgres'
const AMBIGUOUS = 'postgresql://postgres@localhost:5433/openchurch_local?host=db.prod.example'
// Query secrets sit beside a remote ?host= so the refuse line would print them.
const QUERY_SECRET =
  'postgresql://user:s3cretPASS@localhost:5433/openchurch_local?password=querySECRET&sslpassword=sslSECRET&host=db.prod.example&Password=OtherSECRET&SSLPassword=SslOther'

describe('classifyDatabaseUrl (recovery shared)', () => {
  it('pins the loopback allow-list', () => {
    assert.deepEqual([...LOOPBACK].sort(), ['127.0.0.1', '::1', '[::1]', 'localhost'].sort())
  })

  it('accepts loopback including IPv6', () => {
    assert.equal(classifyDatabaseUrl(LOCAL).kind, 'local')
    assert.equal(classifyDatabaseUrl('postgres://postgres@[::1]:5433/x').kind, 'local')
  })

  it('treats a blank string as missing and a raw space in a URL as invalid', () => {
    assert.equal(classifyDatabaseUrl('   ').kind, 'missing')
    assert.equal(classifyDatabaseUrl('postgresql://postgres@localhost:5433/openchurch_local ').kind, 'invalid')
    assert.equal(classifyDatabaseUrl('postgresql://postgres@127.0.0.1:5434/openchurch_local%20').kind, 'local')
  })

  it('refuses remote and ambiguous ?host= / ?hostaddr=', () => {
    assert.equal(classifyDatabaseUrl(REMOTE).kind, 'remote')
    assert.equal(classifyDatabaseUrl(AMBIGUOUS).kind, 'remote')
    assert.equal(classifyDatabaseUrl(AMBIGUOUS).hostname, 'db.prod.example')
    assert.equal(
      classifyDatabaseUrl('postgresql://postgres@127.0.0.1:5433/x?hostaddr=8.8.8.8').kind,
      'remote',
    )
  })
})

describe('redactDatabaseUrl', () => {
  it('strips passwords from loggable URLs', () => {
    const out = redactDatabaseUrl(REMOTE)
    assert.match(out, /\*\*\*/)
    assert.doesNotMatch(out, /s3cretPASS/)
  })

  it('drops query password and sslpassword (probe fails if those keys remain)', () => {
    const out = redactDatabaseUrl(QUERY_SECRET)
    assert.doesNotMatch(out, /s3cretPASS/)
    assert.doesNotMatch(out, /querySECRET/)
    assert.doesNotMatch(out, /sslSECRET/)
    assert.doesNotMatch(out, /OtherSECRET/)
    assert.doesNotMatch(out, /SslOther/)
    assert.doesNotMatch(out, /[?&]password=/i)
    assert.doesNotMatch(out, /[?&]sslpassword=/i)
    // Redaction must not strip the libpq host override the classifier uses.
    assert.match(out, /[?&]host=db\.prod\.example/)
    assert.equal(classifyDatabaseUrl(QUERY_SECRET).kind, 'remote')
    assert.equal(classifyDatabaseUrl(QUERY_SECRET).hostname, 'db.prod.example')
  })

  it('handles missing and unparseable input', () => {
    assert.equal(redactDatabaseUrl(''), '[missing url]')
    assert.equal(redactDatabaseUrl('not-a-url'), '[unparseable url]')
  })

  it('does not echo a password when the URL contains raw whitespace', () => {
    const out = redactDatabaseUrl(
      'postgresql://user:s3cretPASS@localhost:5433/openchurch_local ?password=querySECRET&sslpassword=sslSECRET',
    )
    assert.equal(out, '[unparseable url]')
    assert.doesNotMatch(out, /s3cretPASS/)
    assert.doesNotMatch(out, /querySECRET/)
    assert.doesNotMatch(out, /sslSECRET/)
  })

  it('does not echo a password when an invalid percent would trigger encodeURI', () => {
    const out = redactDatabaseUrl(
      'postgresql://postgres:s3cretPASS%real@localhost:5433/mydb%2Ebackup?password=querySECRET&sslpassword=sslSECRET',
    )
    assert.equal(out, '[unparseable url]')
    assert.doesNotMatch(out, /s3cretPASS/)
    assert.doesNotMatch(out, /querySECRET/)
    assert.doesNotMatch(out, /sslSECRET/)
  })
})

describe('requireLocalRehearsal', () => {
  it('refuses without OCHR_REHEARSAL=local', () => {
    const g = requireLocalRehearsal({ rehearsal: undefined, urls: [{ label: 'DATABASE_URL', url: LOCAL }] })
    assert.equal(g.ok, false)
    assert.equal(g.code, 2)
    assert.match(g.reason, /OCHR_REHEARSAL/)
  })

  it('refuses remote and ambiguous targets even with the flag', () => {
    assert.equal(requireLocalRehearsal({
      rehearsal: 'local',
      urls: [{ label: 'DATABASE_URL', url: REMOTE }],
    }).ok, false)
    const amb = requireLocalRehearsal({
      rehearsal: 'local',
      urls: [{ label: 'RESTORE_URL', url: AMBIGUOUS }],
    })
    assert.equal(amb.ok, false)
    assert.match(amb.reason, /not loopback/)
    assert.doesNotMatch(amb.reason, /s3cretPASS/)
  })

  it('refuses the cited raw-space pair before parsing RAW-WS-REHEARSAL', () => {
    const raw = 'postgresql://postgres@localhost:5433/openchurch_local '
    const encoded = 'postgresql://postgres@127.0.0.1:5434/openchurch_local%20'
    const gate = requireLocalRehearsal({
      rehearsal: 'local',
      urls: [
        { label: 'DATABASE_URL', url: raw },
        { label: 'RESTORE_URL', url: encoded },
      ],
    })
    assert.equal(gate.ok, false)
    assert.equal(gate.code, 2)
    assert.match(gate.reason, /raw whitespace/)
    assert.doesNotMatch(gate.reason, /local rehearsal/)
    const alone = requireLocalRehearsal({
      rehearsal: 'local',
      urls: [{ label: 'DATABASE_URL', url: raw }],
    })
    assert.equal(alone.ok, false)
    assert.match(alone.reason, /DATABASE_URL/)
    const secret = 'postgresql://user:s3cretPASS@localhost:5433/openchurch_local ?password=querySECRET&sslpassword=sslSECRET'
    const leaked = requireLocalRehearsal({
      rehearsal: 'local',
      urls: [{ label: 'DATABASE_URL', url: secret }],
    })
    assert.equal(leaked.ok, false)
    assert.doesNotMatch(leaked.reason, /s3cretPASS/)
    assert.doesNotMatch(leaked.reason, /querySECRET/)
    assert.doesNotMatch(leaked.reason, /sslSECRET/)
    assert.doesNotMatch(leaked.reason, /openchurch_local/)
  })

  it('refuses encodeURI invalid-% targets before parsing ENCODE-PCT', () => {
    const triggered = 'postgresql://postgres@localhost:5433/openchurch%2Elocal?x=%g'
    const partner = 'postgresql://postgres@127.0.0.1:5434/openchurch%252Elocal'
    const password = 'postgresql://postgres:s3cretPASS%real@localhost:5433/mydb%2Ebackup?password=querySECRET&sslpassword=sslSECRET'
    const empty = 'postgresql://postgres@127.0.0.1:5434/'
    const falseLocal = 'postgresql://postgres@127.0.0.1:5433/openchurch_local?host=%6Cocalhost&x=%g'
    const gate = requireLocalRehearsal({
      rehearsal: 'local',
      urls: [
        { label: 'DATABASE_URL', url: triggered },
        { label: 'RESTORE_URL', url: partner },
      ],
    })
    assert.equal(gate.ok, false, gate.reason)
    assert.equal(gate.code, 2)
    assert.match(gate.reason, /invalid percent/)
    assert.doesNotMatch(gate.reason, /local rehearsal/)
    const passwordGate = requireLocalRehearsal({
      rehearsal: 'local',
      urls: [
        { label: 'DATABASE_URL', url: password },
        { label: 'RESTORE_URL', url: empty },
      ],
    })
    assert.equal(passwordGate.ok, false)
    assert.equal(passwordGate.code, 2)
    assert.match(passwordGate.reason, /DATABASE_URL/)
    assert.match(passwordGate.reason, /invalid percent/)
    assert.doesNotMatch(passwordGate.reason, /s3cretPASS/)
    assert.doesNotMatch(passwordGate.reason, /querySECRET/)
    assert.doesNotMatch(passwordGate.reason, /sslSECRET/)
    assert.doesNotMatch(passwordGate.reason, /local rehearsal/)
    const hostGate = requireLocalRehearsal({
      rehearsal: 'local',
      urls: [{ label: 'DATABASE_URL', url: falseLocal }],
    })
    assert.equal(hostGate.ok, false, hostGate.reason)
    assert.equal(hostGate.code, 2)
    assert.match(hostGate.reason, /invalid percent/)
    assert.equal(classifyDatabaseUrl(falseLocal).kind, 'invalid')
    assert.equal(classifyDatabaseUrl(triggered).kind, 'invalid')
    // No invalid `%`: pg does not encodeURI, `%6C` is `l`, driver host is localhost.
    const plainHost = 'postgresql://postgres@127.0.0.1:5433/openchurch_local?host=%6Cocalhost'
    assert.equal(classifyDatabaseUrl(plainHost).kind, 'local')
    const plainGate = requireLocalRehearsal({
      rehearsal: 'local',
      urls: [{ label: 'DATABASE_URL', url: plainHost }],
    })
    assert.equal(plainGate.ok, true)
    const ConnectionParameters = createRequire(import.meta.url)('pg/lib/connection-parameters.js')
    assert.equal(new ConnectionParameters(falseLocal).host, '%6Cocalhost')
    assert.equal(new ConnectionParameters(plainHost).host, 'localhost')
  })

  it('refuses socket URLs the driver does not open on the authority host SOCKET-URL', () => {
    const cited = 'socket://localhost/tmp/pg.sock?db=openchurch_local'
    const pathDb = 'socket://localhost/openchurch_restore?db=openchurch_local'
    const emptyPath = 'socket://localhost?db=openchurch_local'
    const ConnectionParameters = createRequire(import.meta.url)('pg/lib/connection-parameters.js')
    assert.equal(new ConnectionParameters(cited).host, '/tmp/pg.sock')
    assert.equal(new ConnectionParameters(cited).database, 'openchurch_local')
    assert.equal(new ConnectionParameters(pathDb).host, '/openchurch_restore')
    for (const url of [cited, pathDb, emptyPath]) {
      const gate = requireLocalRehearsal({
        rehearsal: 'local',
        urls: [{ label: 'DATABASE_URL', url }],
      })
      assert.equal(gate.ok, false, gate.reason)
      assert.equal(gate.code, 2)
      assert.match(gate.reason, /socket URL/)
      assert.doesNotMatch(gate.reason, /local rehearsal/)
      assert.equal(classifyDatabaseUrl(url).kind, 'invalid')
    }
    const secret = 'socket://user:s3cretPASS@localhost/tmp/pg.sock?db=openchurch_local&password=querySECRET'
    assert.equal(redactDatabaseUrl(secret), '[unparseable url]')
    const leaked = requireLocalRehearsal({
      rehearsal: 'local',
      urls: [{ label: 'DATABASE_URL', url: secret }],
    })
    assert.equal(leaked.ok, false)
    assert.doesNotMatch(leaked.reason, /s3cretPASS/)
    assert.doesNotMatch(leaked.reason, /querySECRET/)
    const distinct = assertDistinctDatabaseUrls(cited, LOCAL_B)
    assert.equal(distinct.ok, false, distinct.reason)
    assert.match(distinct.reason, /socket url/)
    assert.doesNotMatch(distinct.reason, /distinct database names/)
    // Empty pathname is a falsy driver host, so PGHOST wins. No dial.
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const { createRequire } = await import('node:module')
      const ConnectionParameters = createRequire(import.meta.url)('pg/lib/connection-parameters.js')
      const host = new ConnectionParameters(process.argv[1]).host
      console.log(JSON.stringify({ host }))
    `, emptyPath], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, PGHOST: 'db.prod.example' },
    })
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`)
    assert.equal(JSON.parse(child.stdout).host, 'db.prod.example')
    const pgHostGate = requireLocalRehearsal({
      rehearsal: 'local',
      urls: [{ label: 'DATABASE_URL', url: emptyPath }],
    })
    assert.equal(pgHostGate.ok, false, pgHostGate.reason)
  })

  it('refuses query hosts the driver does not trim PAD-HOST', () => {
    const ConnectionParameters = createRequire(import.meta.url)('pg/lib/connection-parameters.js')
    const pads = [
      ['%EF%BB%BFlocalhost', '\uFEFFlocalhost'],
      ['localhost%EF%BB%BF', 'localhost\uFEFF'],
      ['%C2%A0localhost', '\u00A0localhost'],
      ['localhost%C2%A0', 'localhost\u00A0'],
      ['%20localhost', ' localhost'],
      ['localhost%20', 'localhost '],
      ['%09localhost', '\tlocalhost'],
      ['localhost%0A', 'localhost\n'],
      ['localhost%0D', 'localhost\r'],
    ]
    for (const [enc, driverHost] of pads) {
      const url = `postgresql://postgres@127.0.0.1:5433/openchurch_local?host=${enc}`
      assert.equal(new ConnectionParameters(url).host, driverHost, enc)
      const gate = requireLocalRehearsal({
        rehearsal: 'local',
        urls: [{ label: 'DATABASE_URL', url }],
      })
      assert.equal(gate.ok, false, `${enc} ${gate.reason}`)
      assert.equal(gate.code, 2)
      assert.match(gate.reason, /not loopback/)
      assert.doesNotMatch(gate.reason, /local rehearsal/)
      assert.equal(classifyDatabaseUrl(url).kind, 'remote', enc)
    }
    // node-pg keeps hostaddr on the parsed config and still sets ConnectionParameters.host
    // from the authority. libpq prefers hostaddr, so a padded value is not loopback.
    const hostaddr = 'postgresql://postgres@127.0.0.1:5433/openchurch_local?hostaddr=%EF%BB%BF127.0.0.1'
    const parsed = createRequire(import.meta.url)('pg-connection-string').parse(hostaddr)
    assert.equal(parsed.hostaddr, '\uFEFF127.0.0.1')
    assert.equal(new ConnectionParameters(hostaddr).host, '127.0.0.1')
    assert.equal(classifyDatabaseUrl(hostaddr).kind, 'remote')
    assert.equal(requireLocalRehearsal({
      rehearsal: 'local',
      urls: [{ label: 'DATABASE_URL', url: hostaddr }],
    }).ok, false)
    const secret = 'postgresql://user:s3cretPASS@127.0.0.1:5433/openchurch_local?host=%C2%A0localhost&password=querySECRET&sslpassword=sslSECRET'
    const leaked = requireLocalRehearsal({
      rehearsal: 'local',
      urls: [{ label: 'DATABASE_URL', url: secret }],
    })
    assert.equal(leaked.ok, false)
    assert.doesNotMatch(leaked.reason, /s3cretPASS/)
    assert.doesNotMatch(leaked.reason, /querySECRET/)
    assert.doesNotMatch(leaked.reason, /sslSECRET/)
    // Exact decoded loopback query hosts stay allowed. No padding.
    const plain = 'postgresql://postgres@127.0.0.1:5433/openchurch_local?host=%6Cocalhost'
    assert.equal(new ConnectionParameters(plain).host, 'localhost')
    assert.equal(classifyDatabaseUrl(plain).kind, 'local')
    assert.equal(requireLocalRehearsal({
      rehearsal: 'local',
      urls: [{ label: 'DATABASE_URL', url: plain }],
    }).ok, true)
    const v6 = 'postgresql://postgres@127.0.0.1:5433/openchurch_local?host=%5B%3A%3A1%5D'
    assert.equal(classifyDatabaseUrl(v6).kind, 'remote')
    assert.equal(new ConnectionParameters(v6).host, '[::1]')
  })

  it('refuses a path-final bare percent that throws URIError BARE-PCT', () => {
    const cited = 'postgresql://postgres@localhost:5433/db%'
    const oneHex = 'postgresql://postgres@localhost:5433/db%2'
    const ConnectionParameters = createRequire(import.meta.url)('pg/lib/connection-parameters.js')
    for (const url of [cited, oneHex]) {
      assert.throws(() => new ConnectionParameters(url), URIError)
      const gate = requireLocalRehearsal({
        rehearsal: 'local',
        urls: [{ label: 'DATABASE_URL', url }],
      })
      assert.equal(gate.ok, false, gate.reason)
      assert.equal(gate.code, 2)
      assert.match(gate.reason, /invalid percent|not valid percent-encoding/)
      assert.doesNotMatch(gate.reason, /local rehearsal/)
      assert.equal(classifyDatabaseUrl(url).kind, 'invalid')
      const distinct = assertDistinctDatabaseUrls(url, LOCAL_B)
      assert.equal(distinct.ok, false, distinct.reason)
      assert.match(distinct.reason, /malformed path|invalid percent/)
      assert.doesNotMatch(distinct.reason, /distinct database names/)
    }
    const secret = 'postgresql://user:s3cretPASS@localhost:5433/db%?password=querySECRET&sslpassword=sslSECRET'
    assert.equal(redactDatabaseUrl(secret), '[unparseable url]')
    const leaked = requireLocalRehearsal({
      rehearsal: 'local',
      urls: [{ label: 'DATABASE_URL', url: secret }],
    })
    assert.equal(leaked.ok, false)
    assert.doesNotMatch(leaked.reason, /s3cretPASS/)
    assert.doesNotMatch(leaked.reason, /querySECRET/)
    assert.doesNotMatch(leaked.reason, /sslSECRET/)
    assert.doesNotMatch(leaked.reason, /db%/)
  })

  it('allows local + identity together', () => {
    const g = requireLocalRehearsal({
      rehearsal: 'local',
      urls: [
        { label: 'DATABASE_URL', url: LOCAL },
        { label: 'RESTORE_URL', url: LOCAL_B },
      ],
    })
    assert.equal(g.ok, true)
  })
})

const ALIAS = 'postgresql://postgres@127.0.0.1:5433/openchurch_local'
// Fallback tests pass this so ambient PGDATABASE / USER cannot change them.
const CLEAN_ENV = { PGDATABASE: '', PGUSER: '', USER: '', USERNAME: '' }
const ARGUS_RESTORE = 'postgresql://postgres@127.0.0.1:5434/?dbname=decoy_restore&user=openchurch_local'
const SAME_NAME_CREDENTIALS = 'postgresql://other:s3cretPASS@localhost:5433/openchurch_local'
const SAME_NAME_DECORATED = 'postgresql://postgres@localhost:5433/openchurch_local?sslmode=require'
const SAME_NAME_OTHER_PORT = 'postgresql://postgres@localhost:5434/openchurch_local'

describe('assertDistinctDatabaseUrls', () => {
  it('refuses identical source and restore', () => {
    const d = assertDistinctDatabaseUrls(LOCAL, LOCAL)
    assert.equal(d.ok, false)
    assert.equal(d.code, 2)
    assert.match(d.reason, /same database/)
  })

  it('refuses host-alias same database name', () => {
    const d = assertDistinctDatabaseUrls(LOCAL, ALIAS)
    assert.equal(d.ok, false)
    assert.equal(d.code, 2)
    assert.match(d.reason, /same database/)
    assert.match(d.reason, /Host aliases/)
  })

  it('refuses credentials and query decoration on the same database name', () => {
    const creds = assertDistinctDatabaseUrls(LOCAL, SAME_NAME_CREDENTIALS)
    const decorated = assertDistinctDatabaseUrls(LOCAL, SAME_NAME_DECORATED)
    assert.equal(creds.ok, false)
    assert.equal(decorated.ok, false)
    assert.doesNotMatch(creds.reason, /s3cretPASS/)
  })

  it('refuses the same database name on another port', () => {
    const d = assertDistinctDatabaseUrls(LOCAL, SAME_NAME_OTHER_PORT)
    assert.equal(d.ok, false)
    assert.match(d.reason, /same database/)
  })

  it('refuses a missing or ambiguous database name', () => {
    // No path, no user, and no PGDATABASE / PGUSER / OS user. A userinfo
    // with an empty path is not missing: node-pg uses that user.
    const missing = assertDistinctDatabaseUrls(LOCAL, 'postgresql://127.0.0.1:5433', { env: CLEAN_ENV })
    const clash = assertDistinctDatabaseUrls(
      LOCAL,
      'postgresql://postgres@127.0.0.1:5434/openchurch_restore?dbname=openchurch_local',
    )
    const junk = assertDistinctDatabaseUrls(LOCAL, 'not-a-url')
    assert.equal(missing.ok, false)
    assert.match(missing.reason, /missing/)
    assert.equal(clash.ok, false)
    assert.match(clash.reason, /ambiguous/)
    assert.equal(junk.ok, false)
    assert.match(junk.reason, /unparseable/)
    assert.match(missing.reason, /unambiguous/)
  })

  it('refuses a slash in the database name SLASH-NAME', () => {
    const slash = assertDistinctDatabaseUrls(
      LOCAL,
      'postgresql://postgres@127.0.0.1:5433/openchurch_local/',
    )
    assert.equal(slash.ok, false)
    assert.equal(slash.code, 2)
    assert.match(slash.reason, /ambiguous/)
    const encoded = assertDistinctDatabaseUrls(
      LOCAL,
      'postgresql://postgres@127.0.0.1:5433/openchurch_local%2F',
    )
    assert.equal(encoded.ok, false)
    assert.match(encoded.reason, /ambiguous/)
    const querySlash = assertDistinctDatabaseUrls(
      LOCAL,
      'postgresql://postgres@127.0.0.1:5434/openchurch_restore?dbname=openchurch_local/',
    )
    assert.equal(querySlash.ok, false)
    assert.match(querySlash.reason, /ambiguous/)
  })

  it('allows two unambiguous different database names', () => {
    const d = assertDistinctDatabaseUrls(LOCAL, LOCAL_B)
    assert.equal(d.ok, true)
    assert.match(d.reason, /openchurch_local/)
    assert.match(d.reason, /openchurch_restore/)
    const restated = assertDistinctDatabaseUrls(
      LOCAL,
      'postgresql://postgres@127.0.0.1:5434/openchurch_restore?dbname=openchurch_restore',
    )
    assert.equal(restated.ok, true)
  })

  it('refuses the Argus empty-path dbname decoy ARGUS-DBNAME', () => {
    // node-pg opens openchurch_local for both: path on the source, and the
    // query user on the restore. ?dbname=decoy_restore is not the database.
    const d = assertDistinctDatabaseUrls(LOCAL, ARGUS_RESTORE, { env: CLEAN_ENV })
    assert.equal(d.ok, false)
    assert.equal(d.code, 2)
    assert.match(d.reason, /ambiguous|same database/)
    assert.doesNotMatch(d.reason, /decoy_restore/)
    assert.doesNotMatch(d.reason, /distinct database names/)
  })

  it('refuses an empty path whose user is the source database', () => {
    const d = assertDistinctDatabaseUrls(
      LOCAL,
      'postgresql://openchurch_local@127.0.0.1:5434/',
      { env: CLEAN_ENV },
    )
    assert.equal(d.ok, false)
    assert.equal(d.code, 2)
    assert.match(d.reason, /same database/)
    assert.match(d.reason, /empty path/)
  })

  it('refuses an empty path when query user is the source database', () => {
    const d = assertDistinctDatabaseUrls(
      LOCAL,
      'postgresql://postgres@127.0.0.1:5434/?user=openchurch_local',
      { env: { ...CLEAN_ENV, PGUSER: 'other', USER: 'other' } },
    )
    assert.equal(d.ok, false)
    assert.match(d.reason, /same database/)
  })

  it('does not treat a differently cased user query key as the node-pg user', () => {
    const d = assertDistinctDatabaseUrls(
      LOCAL,
      'postgresql://postgres@127.0.0.1:5434/?USER=openchurch_local',
      { env: CLEAN_ENV },
    )
    assert.equal(d.ok, true)
    assert.match(d.reason, /postgres/)
  })

  it('refuses an empty path when PGDATABASE is the source database', () => {
    const d = assertDistinctDatabaseUrls(
      LOCAL,
      'postgresql://other@127.0.0.1:5434/',
      { env: { ...CLEAN_ENV, PGDATABASE: 'openchurch_local' } },
    )
    assert.equal(d.ok, false)
    assert.match(d.reason, /same database/)
    const folded = assertDistinctDatabaseUrls(
      LOCAL,
      'postgresql://other@127.0.0.1:5434/',
      { env: { ...CLEAN_ENV, PGDATABASE: 'OpenChurch_Local' } },
    )
    assert.equal(folded.ok, false)
  })

  it('lets PGDATABASE override the user fallback', () => {
    const d = assertDistinctDatabaseUrls(
      LOCAL,
      'postgresql://openchurch_local@127.0.0.1:5434/',
      { env: { ...CLEAN_ENV, PGDATABASE: 'openchurch_restore' } },
    )
    assert.equal(d.ok, true)
    assert.match(d.reason, /openchurch_restore/)
  })

  it('keeps an explicit path when PGDATABASE names the source database', () => {
    const d = assertDistinctDatabaseUrls(LOCAL, LOCAL_B, {
      env: { ...CLEAN_ENV, PGDATABASE: 'openchurch_local', USER: 'openchurch_local' },
    })
    assert.equal(d.ok, true)
    assert.match(d.reason, /openchurch_restore/)
  })

  it('refuses a dbname that disagrees with the empty-path fallback', () => {
    // node-pg would open `postgres` and ignore ?dbname=. That is not the
    // source database, but the decoy is still ambiguous (libpq NOT MEASURED).
    const d = assertDistinctDatabaseUrls(
      LOCAL,
      'postgresql://postgres@127.0.0.1:5434/?dbname=openchurch_restore',
      { env: CLEAN_ENV },
    )
    assert.equal(d.ok, false)
    assert.match(d.reason, /ambiguous/)
    assert.doesNotMatch(d.reason, /distinct database names/)
  })

  it('refuses empty-path identities node-pg collapses to the source database', () => {
    const pguser = assertDistinctDatabaseUrls(LOCAL, 'postgresql://127.0.0.1:5434/', {
      env: { ...CLEAN_ENV, PGUSER: 'openchurch_local', USER: 'other' },
    })
    assert.equal(pguser.ok, false)
    assert.match(pguser.reason, /same database/)
    const osUser = assertDistinctDatabaseUrls(LOCAL, 'postgresql://127.0.0.1:5434/', {
      env: { ...CLEAN_ENV, USER: 'openchurch_local' },
    })
    assert.equal(osUser.ok, false)
    // pg-connection-string overwrites query `database` with the empty path.
    const queryDatabase = assertDistinctDatabaseUrls(
      LOCAL,
      'postgresql://postgres@127.0.0.1:5434/?database=decoy_restore&user=openchurch_local',
      { env: CLEAN_ENV },
    )
    assert.equal(queryDatabase.ok, false)
    assert.doesNotMatch(queryDatabase.reason, /decoy_restore/)
  })

  it('refuses two empty paths that fall back to the same database', () => {
    const d = assertDistinctDatabaseUrls(
      'postgresql://postgres@localhost:5433/',
      'postgresql://postgres@127.0.0.1:5434/',
      { env: { ...CLEAN_ENV, PGDATABASE: 'openchurch_local' } },
    )
    assert.equal(d.ok, false)
    assert.match(d.reason, /same database/)
    const users = assertDistinctDatabaseUrls(
      'postgresql://openchurch_local@localhost:5433/',
      'postgresql://openchurch_restore@127.0.0.1:5434/',
      { env: CLEAN_ENV },
    )
    assert.equal(users.ok, true)
  })

  it('refuses decodeURI pairs the driver collapses DECODE-URI', () => {
    // pg-connection-string uses decodeURI on the path. decodeURIComponent
    // turns `%23` into `#` and leaves `%2523` as `%23`, so the prior guard
    // reported two databases. The driver opens `x%23y` for both.
    const cited = assertDistinctDatabaseUrls(
      'postgresql://postgres@localhost:5433/x%2523y',
      'postgresql://postgres@127.0.0.1:5434/x%23y',
    )
    assert.equal(cited.ok, false)
    assert.equal(cited.code, 2)
    assert.match(cited.reason, /same database/)
    assert.doesNotMatch(cited.reason, /distinct database names/)
    // Same leftover class: decodeURI does not decode ? & @ + ; , : = $
    const leftovers = [
      ['%253F', '%3F'],
      ['%2526', '%26'],
      ['%2540', '%40'],
      ['%252B', '%2B'],
      ['%253B', '%3B'],
      ['%252C', '%2C'],
      ['%253A', '%3A'],
      ['%253D', '%3D'],
      ['%2524', '%24'],
    ]
    for (const [doubleEncoded, once] of leftovers) {
      const d = assertDistinctDatabaseUrls(
        `postgresql://postgres@localhost:5433/x${doubleEncoded}y`,
        `postgresql://postgres@127.0.0.1:5434/x${once}y`,
      )
      assert.equal(d.ok, false, `${doubleEncoded} vs ${once}`)
      assert.match(d.reason, /same database/)
    }
  })

  it('refuses untrimmed names node-pg does not trim TRIM-NAME', () => {
    const lead = assertDistinctDatabaseUrls(
      'postgresql://postgres@localhost:5433/%20openchurch_local',
      'postgresql://postgres@127.0.0.1:5434/?user=%20openchurch_local',
      { env: CLEAN_ENV },
    )
    assert.equal(lead.ok, false)
    assert.equal(lead.code, 2)
    assert.match(lead.reason, /same database/)
    assert.doesNotMatch(lead.reason, /distinct database names/)
    const trail = assertDistinctDatabaseUrls(
      'postgresql://postgres@localhost:5433/openchurch_local%20',
      'postgresql://other@127.0.0.1:5434/',
      { env: { ...CLEAN_ENV, PGDATABASE: 'openchurch_local ' } },
    )
    assert.equal(trail.ok, false)
    assert.match(trail.reason, /same database/)
    const userinfo = assertDistinctDatabaseUrls(
      'postgresql://postgres@localhost:5433/%20openchurch_local',
      'postgresql://%20openchurch_local@127.0.0.1:5434/',
      { env: CLEAN_ENV },
    )
    assert.equal(userinfo.ok, false)
    assert.match(userinfo.reason, /same database/)
    // A leading space is a different database from the unspaced name.
    // Trimming would invent sameness the driver does not have.
    const unspaced = assertDistinctDatabaseUrls(
      'postgresql://postgres@localhost:5433/%20openchurch_local',
      'postgresql://postgres@127.0.0.1:5434/openchurch_local',
    )
    assert.equal(unspaced.ok, true)
  })

  it('refuses a raw trailing space that node-pg keeps and WHATWG strips RAW-WS', () => {
    // Cited pair. The first URL ends in U+0020. pg-connection-string
    // encodeURI-encodes it; WHATWG strips it. Both driver databases are
    // `openchurch_local ` (code point 32). No dial.
    const raw = 'postgresql://postgres@localhost:5433/openchurch_local '
    const encoded = 'postgresql://postgres@127.0.0.1:5434/openchurch_local%20'
    const ConnectionParameters = createRequire(import.meta.url)('pg/lib/connection-parameters.js')
    const driver = (url) => new ConnectionParameters(url).database
    assert.equal(driver(raw), driver(encoded))
    assert.equal(driver(raw), 'openchurch_local ')
    const forward = assertDistinctDatabaseUrls(raw, encoded)
    const reverse = assertDistinctDatabaseUrls(encoded, raw)
    assert.equal(forward.ok, false, forward.reason)
    assert.equal(forward.code, 2)
    assert.equal(reverse.ok, false, reverse.reason)
    assert.match(forward.reason, /raw whitespace/)
    assert.doesNotMatch(forward.reason, /distinct database names/)
    assert.doesNotMatch(reverse.reason, /distinct database names/)
    const two = 'postgresql://postgres@localhost:5433/openchurch_local  '
    const twoEncoded = 'postgresql://postgres@127.0.0.1:5434/openchurch_local%20%20'
    assert.equal(driver(two), driver(twoEncoded))
    assert.equal(assertDistinctDatabaseUrls(two, twoEncoded).ok, false)
    const secret = 'postgresql://user:s3cretPASS@localhost:5433/openchurch_local ?password=querySECRET&sslpassword=sslSECRET'
    const secretPair = assertDistinctDatabaseUrls(secret, encoded)
    assert.equal(secretPair.ok, false)
    assert.doesNotMatch(secretPair.reason, /s3cretPASS/)
    assert.doesNotMatch(secretPair.reason, /querySECRET/)
    assert.doesNotMatch(secretPair.reason, /sslSECRET/)
  })

  it('refuses encodeURI invalid-% identities node-pg collapses ENCODE-PCT', () => {
    // Cited pairs. An invalid `%` makes pg-connection-string encodeURI the
    // whole string and restore only %25 plus two digits. WHATWG then
    // disagrees. No dial.
    const ConnectionParameters = createRequire(import.meta.url)('pg/lib/connection-parameters.js')
    const driver = (url) => new ConnectionParameters(url).database
    const triggered = 'postgresql://postgres@localhost:5433/openchurch%2Elocal?x=%g'
    const partner = 'postgresql://postgres@127.0.0.1:5434/openchurch%252Elocal'
    assert.equal(driver(triggered), driver(partner))
    assert.equal(driver(triggered), 'openchurch%2Elocal')
    const forward = assertDistinctDatabaseUrls(triggered, partner)
    const reverse = assertDistinctDatabaseUrls(partner, triggered)
    assert.equal(forward.ok, false, forward.reason)
    assert.equal(forward.code, 2)
    assert.equal(reverse.ok, false, reverse.reason)
    assert.match(forward.reason, /invalid percent/)
    assert.doesNotMatch(forward.reason, /distinct database names/)
    assert.doesNotMatch(reverse.reason, /distinct database names/)

    const escapes = ['%2E', '%2D', '%2A', '%5F', '%7E', '%0A']
    for (const enc of escapes) {
      const hex = enc.slice(1)
      const left = `postgresql://postgres@localhost:5433/mydb${enc}backup?x=%g`
      const right = `postgresql://postgres@127.0.0.1:5434/mydb%25${hex}backup`
      assert.equal(driver(left), driver(right), enc)
      const d = assertDistinctDatabaseUrls(left, right)
      assert.equal(d.ok, false, `${enc} ${d.reason}`)
      assert.doesNotMatch(d.reason, /distinct database names/)
    }

    const password = 'postgresql://postgres:s3cretPASS%real@localhost:5433/mydb%2Ebackup'
    const empty = 'postgresql://postgres@127.0.0.1:5434/'
    const pgDatabase = 'mydb%2Ebackup'
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const { createRequire } = await import('node:module')
      const ConnectionParameters = createRequire(import.meta.url)('pg/lib/connection-parameters.js')
      const urls = process.argv.slice(1)
      const out = urls.map((url) => new ConnectionParameters(url).database)
      console.log(JSON.stringify(out))
    `, password, empty], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, PGDATABASE: pgDatabase, PGUSER: '' },
    })
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`)
    const [passwordDb, emptyDb] = JSON.parse(child.stdout)
    assert.equal(passwordDb, emptyDb)
    assert.equal(passwordDb, pgDatabase)
    const passwordPair = assertDistinctDatabaseUrls(password, empty, {
      env: { ...CLEAN_ENV, PGDATABASE: pgDatabase },
    })
    assert.equal(passwordPair.ok, false, passwordPair.reason)
    assert.equal(passwordPair.code, 2)
    assert.match(passwordPair.reason, /invalid percent/)
    assert.doesNotMatch(passwordPair.reason, /distinct database names/)
    assert.doesNotMatch(passwordPair.reason, /s3cretPASS/)

    const userinfo = 'postgresql://mydb%252Ebackup@127.0.0.1:5434/'
    assert.equal(driver(password), driver(userinfo))
    assert.equal(driver(userinfo), pgDatabase)
    const userPair = assertDistinctDatabaseUrls(password, userinfo, { env: CLEAN_ENV })
    assert.equal(userPair.ok, false, userPair.reason)
    assert.doesNotMatch(userPair.reason, /distinct database names/)

    // Flip side stays closed: the driver names differ, and so does the guard.
    const literal = 'postgresql://postgres@127.0.0.1:5434/mydb.backup'
    assert.notEqual(driver(password), driver(literal))
    const flip = assertDistinctDatabaseUrls(password, literal)
    assert.equal(flip.ok, false, flip.reason)
    assert.doesNotMatch(flip.reason, /distinct database names/)

    // An invalid `%` in the password refuses even when the driver names differ.
    // The string is unsafe: the pre-pass rewrites every other `%` in it.
    const unsafeDistinct = assertDistinctDatabaseUrls(
      'postgresql://postgres:s3cretPASS%real@localhost:5433/openchurch_local',
      'postgresql://postgres@127.0.0.1:5434/openchurch_restore',
    )
    assert.equal(unsafeDistinct.ok, false, unsafeDistinct.reason)
    assert.doesNotMatch(unsafeDistinct.reason, /distinct database names/)
    assert.doesNotMatch(unsafeDistinct.reason, /s3cretPASS/)

    // A valid two-hex password encoding does not trigger the pre-pass.
    const validPassword = 'postgresql://postgres:p%40ss@localhost:5433/openchurch_local'
    const other = 'postgresql://postgres@127.0.0.1:5434/openchurch_restore'
    assert.equal(driver(validPassword), 'openchurch_local')
    const valid = assertDistinctDatabaseUrls(validPassword, other)
    assert.equal(valid.ok, true, valid.reason)
    assert.match(valid.reason, /distinct database names/)
  })

  it('refuses a %2F authority host in rehearsal and identity PCT-HOST', () => {
    // pg prepends a %2F hostname onto the path when ?host= is set. The
    // guard does not. Both of these are remote, so rehearsal refuses
    // before any dial. Identity now also refuses unsupported local targets.
    const withUser = 'postgresql://postgres@%2Ftmp?host=127.0.0.1'
    const bare = 'postgresql://%2Ftmp?host=127.0.0.1'
    assert.equal(assertDistinctDatabaseUrls(withUser, bare).ok, false)
    assert.equal(classifyDatabaseUrl(withUser).kind, 'remote')
    assert.equal(classifyDatabaseUrl(bare).kind, 'remote')
    const gate = requireLocalRehearsal({
      rehearsal: 'local',
      urls: [
        { label: 'DATABASE_URL', url: withUser },
        { label: 'RESTORE_URL', url: bare },
      ],
    })
    assert.equal(gate.ok, false)
    assert.equal(gate.code, 2)
    assert.match(gate.reason, /not loopback/)
  })

  it('refuses empty-path URLs when pg froze USER before a later change USER-FREEZE', () => {
    const guardUrl = pathToFileURL(join(ROOT, 'scripts/lib/db-target-guard.mjs')).href
    const script = `
      const userA = 'user_alpha'
      const userB = 'user_beta'
      if (process.env.USER !== userA) {
        console.log(JSON.stringify({ error: 'start-user', user: process.env.USER }))
        process.exit(2)
      }
      const pg = (await import('pg')).default
      if (pg.defaults.user !== userA) {
        console.log(JSON.stringify({ error: 'freeze', frozen: pg.defaults.user }))
        process.exit(2)
      }
      process.env.USER = userB
      process.env.USERNAME = userB
      const { assertDistinctDatabaseUrls } = await import(${JSON.stringify(guardUrl)})
      const { createRequire } = await import('node:module')
      const ConnectionParameters = createRequire(import.meta.url)('pg/lib/connection-parameters.js')
      const emptyFrozen = 'postgresql://127.0.0.1:5434/'
      const emptyUserA = 'postgresql://' + userA + '@localhost:5433/'
      const emptyUserB = 'postgresql://' + userB + '@localhost:5433/'
      const driver = (url) => new ConnectionParameters(url).database
      const clientFrozen = new pg.Client(emptyFrozen).database
      const matched = assertDistinctDatabaseUrls(emptyUserA, emptyFrozen)
      const distinct = assertDistinctDatabaseUrls(emptyUserB, emptyFrozen)
      console.log(JSON.stringify({
        frozen: pg.defaults.user,
        envUser: process.env.USER,
        driverA: driver(emptyUserA),
        driverFrozen: driver(emptyFrozen),
        driverB: driver(emptyUserB),
        clientFrozen,
        matchedOk: matched.ok,
        matchedReason: matched.reason,
        distinctOk: distinct.ok,
        distinctReason: distinct.reason,
      }))
    `
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        USER: 'user_alpha',
        USERNAME: 'user_alpha',
        PGDATABASE: '',
        PGUSER: '',
      },
    })
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
    const body = JSON.parse(r.stdout)
    assert.equal(body.frozen, 'user_alpha')
    assert.equal(body.envUser, 'user_beta')
    assert.equal(body.driverA, 'user_alpha')
    assert.equal(body.driverFrozen, 'user_alpha')
    assert.equal(body.clientFrozen, 'user_alpha')
    assert.equal(body.driverB, 'user_beta')
    assert.equal(body.driverA, body.driverFrozen)
    assert.equal(body.matchedOk, false)
    assert.match(body.matchedReason, /same database|ambiguous/)
    assert.doesNotMatch(body.matchedReason, /distinct database names/)
    // userinfo B is a different database from the frozen OS user A.
    // Reading the live USER would call them the same.
    assert.equal(body.distinctOk, true)
    assert.match(body.distinctReason, /distinct database names/)
  })
})

function spawnDrill(script, env) {
  return spawnSync(process.execPath, [join(ROOT, 'scripts', script)], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}

describe('restore-drill CLI refuse path', () => {
  it('exits 2 without OCHR_REHEARSAL', () => {
    const r = spawnDrill('restore-drill.mjs', {
      OCHR_REHEARSAL: '',
      DATABASE_URL: LOCAL,
    })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /OCHR_REHEARSAL/)
  })

  it('exits 2 on remote DATABASE_URL', () => {
    const r = spawnDrill('restore-drill.mjs', {
      OCHR_REHEARSAL: 'local',
      DATABASE_URL: REMOTE,
    })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /not loopback/)
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /s3cretPASS/)
  })

  it('exits 2 on ambiguous ?host= override', () => {
    const r = spawnDrill('restore-drill.mjs', {
      OCHR_REHEARSAL: 'local',
      DATABASE_URL: AMBIGUOUS,
    })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /not loopback/)
  })

  it('exits 2 when DATABASE_URL has a raw trailing space', () => {
    const r = spawnDrill('restore-drill.mjs', {
      OCHR_REHEARSAL: 'local',
      DATABASE_URL: 'postgresql://user:s3cretPASS@localhost:5433/openchurch_local ?password=querySECRET&sslpassword=sslSECRET',
    })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /raw whitespace/)
    const blob = `${r.stdout}${r.stderr}`
    assert.doesNotMatch(blob, /s3cretPASS/)
    assert.doesNotMatch(blob, /querySECRET/)
    assert.doesNotMatch(blob, /sslSECRET/)
    assert.doesNotMatch(blob, /LOCAL ONLY/)
    assert.doesNotMatch(blob, /openchurch_local/)
  })

  it('exits 2 when an invalid percent hides a non-loopback host', () => {
    const r = spawnDrill('restore-drill.mjs', {
      OCHR_REHEARSAL: 'local',
      DATABASE_URL: 'postgresql://postgres:s3cretPASS%real@127.0.0.1:5433/openchurch_local?host=%6Cocalhost&x=%g&password=querySECRET',
    })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /invalid percent/)
    const blob = `${r.stdout}${r.stderr}`
    assert.doesNotMatch(blob, /s3cretPASS/)
    assert.doesNotMatch(blob, /querySECRET/)
    assert.doesNotMatch(blob, /LOCAL ONLY/)
    assert.doesNotMatch(blob, /%6Cocalhost/)
  })

  it('exits 2 on a socket URL whose authority token is localhost', () => {
    const r = spawnDrill('restore-drill.mjs', {
      OCHR_REHEARSAL: 'local',
      DATABASE_URL: 'socket://user:s3cretPASS@localhost/tmp/pg.sock?db=openchurch_local&password=querySECRET',
    })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /socket URL/)
    const blob = `${r.stdout}${r.stderr}`
    assert.doesNotMatch(blob, /s3cretPASS/)
    assert.doesNotMatch(blob, /querySECRET/)
    assert.doesNotMatch(blob, /LOCAL ONLY/)
  })

  it('exits 2 on a BOM-padded query host', () => {
    const r = spawnDrill('restore-drill.mjs', {
      OCHR_REHEARSAL: 'local',
      DATABASE_URL: 'postgresql://user:s3cretPASS@127.0.0.1:5433/openchurch_local?host=%EF%BB%BFlocalhost&password=querySECRET',
    })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /not loopback/)
    const blob = `${r.stdout}${r.stderr}`
    assert.doesNotMatch(blob, /s3cretPASS/)
    assert.doesNotMatch(blob, /querySECRET/)
    assert.doesNotMatch(blob, /LOCAL ONLY/)
  })

  it('exits 2 on a path-final bare percent', () => {
    const r = spawnDrill('restore-drill.mjs', {
      OCHR_REHEARSAL: 'local',
      DATABASE_URL: 'postgresql://user:s3cretPASS@localhost:5433/db%',
    })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /invalid percent|not valid percent-encoding/)
    const blob = `${r.stdout}${r.stderr}`
    assert.doesNotMatch(blob, /s3cretPASS/)
    assert.doesNotMatch(blob, /querySECRET/)
    assert.doesNotMatch(blob, /LOCAL ONLY/)
  })

  it('refuse line drops query password and sslpassword', () => {
    const r = spawnDrill('restore-drill.mjs', {
      OCHR_REHEARSAL: 'local',
      DATABASE_URL: QUERY_SECRET,
    })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /not loopback/)
    const blob = `${r.stdout}${r.stderr}`
    assert.doesNotMatch(blob, /querySECRET/)
    assert.doesNotMatch(blob, /sslSECRET/)
    assert.doesNotMatch(blob, /OtherSECRET/)
    assert.doesNotMatch(blob, /SslOther/)
    assert.doesNotMatch(blob, /s3cretPASS/)
    assert.doesNotMatch(blob, /[?&]password=/i)
    assert.doesNotMatch(blob, /[?&]sslpassword=/i)
    assert.match(blob, /db\.prod\.example/)
  })
})

describe('offsite-restore-drill CLI refuse path', () => {
  it('exits 2 when RESTORE_URL is remote', () => {
    const r = spawnDrill('offsite-restore-drill.mjs', {
      OCHR_REHEARSAL: 'local',
      DATABASE_URL: LOCAL,
      RESTORE_URL: REMOTE,
    })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /RESTORE_URL/)
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /s3cretPASS/)
  })

  it('exits 2 when RESTORE_URL hides a remote ?host=', () => {
    const r = spawnDrill('offsite-restore-drill.mjs', {
      OCHR_REHEARSAL: 'local',
      DATABASE_URL: LOCAL,
      RESTORE_URL: AMBIGUOUS,
    })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /not loopback/)
  })

  it('exits 2 when source and restore are identical', () => {
    const r = spawnDrill('offsite-restore-drill.mjs', {
      OCHR_REHEARSAL: 'local',
      DATABASE_URL: LOCAL,
      RESTORE_URL: LOCAL,
    })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /same database/)
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /LOCAL ONLY/)
  })

  it('exits 2 when the restore host is a loopback alias of the source database', () => {
    const r = spawnDrill('offsite-restore-drill.mjs', {
      OCHR_REHEARSAL: 'local',
      DATABASE_URL: LOCAL,
      RESTORE_URL: ALIAS,
    })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /same database/)
    assert.match(r.stderr, /Host aliases/)
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /LOCAL ONLY/)
  })

  it('exits 2 when the restore name only adds a trailing slash', () => {
    const r = spawnDrill('offsite-restore-drill.mjs', {
      OCHR_REHEARSAL: 'local',
      DATABASE_URL: LOCAL,
      RESTORE_URL: 'postgresql://postgres@127.0.0.1:5433/openchurch_local/',
    })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /ambiguous/)
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /LOCAL ONLY/)
  })

  it('exits 2 on the Argus empty-path dbname decoy', () => {
    const r = spawnDrill('offsite-restore-drill.mjs', {
      OCHR_REHEARSAL: 'local',
      DATABASE_URL: LOCAL,
      RESTORE_URL: ARGUS_RESTORE,
      PGDATABASE: '',
      PGUSER: '',
    })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /ambiguous|same database/)
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /LOCAL ONLY/)
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /decoy_restore/)
  })

  it('exits 2 when a raw trailing space and %20 name the same driver database', () => {
    const r = spawnDrill('offsite-restore-drill.mjs', {
      OCHR_REHEARSAL: 'local',
      DATABASE_URL: 'postgresql://postgres@127.0.0.1:5434/openchurch_local%20',
      RESTORE_URL: 'postgresql://user:s3cretPASS@localhost:5433/openchurch_local ?password=querySECRET&sslpassword=sslSECRET',
    })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /raw whitespace/)
    const blob = `${r.stdout}${r.stderr}`
    assert.doesNotMatch(blob, /s3cretPASS/)
    assert.doesNotMatch(blob, /querySECRET/)
    assert.doesNotMatch(blob, /sslSECRET/)
    assert.doesNotMatch(blob, /LOCAL ONLY/)
    assert.doesNotMatch(blob, /distinct database/)
  })

  it('exits 2 when an invalid percent makes two URLs one driver database', () => {
    const r = spawnDrill('offsite-restore-drill.mjs', {
      OCHR_REHEARSAL: 'local',
      DATABASE_URL: 'postgresql://postgres:s3cretPASS%real@localhost:5433/openchurch%2Elocal?x=%g&password=querySECRET',
      RESTORE_URL: 'postgresql://postgres@127.0.0.1:5434/openchurch%252Elocal',
    })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /invalid percent/)
    const blob = `${r.stdout}${r.stderr}`
    assert.doesNotMatch(blob, /s3cretPASS/)
    assert.doesNotMatch(blob, /querySECRET/)
    assert.doesNotMatch(blob, /LOCAL ONLY/)
    assert.doesNotMatch(blob, /distinct database/)
  })

  it('exits 2 when an empty restore path falls back to the source database name', () => {
    const r = spawnDrill('offsite-restore-drill.mjs', {
      OCHR_REHEARSAL: 'local',
      DATABASE_URL: LOCAL,
      RESTORE_URL: 'postgresql://openchurch_local@127.0.0.1:5434/',
      PGDATABASE: '',
      PGUSER: '',
    })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /same database/)
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /LOCAL ONLY/)
  })
})

describe('scale-drill CLI refuse path (closes prior regex hole)', () => {
  it('exits 2 on ambiguous ?host= that the old authority regex accepted', () => {
    // Prior defect: /^postgres(ql)?:\/\/[^/]*@(localhost|127\.0\.0\.1):\d+/
    // ACCEPTed this URL. The shared classifier must refuse it.
    assert.equal(classifyDatabaseUrl(AMBIGUOUS).kind, 'remote')
    const r = spawnDrill('scale-drill.mjs', {
      OCHR_REHEARSAL: 'local',
      DATABASE_URL: AMBIGUOUS,
      RESTORE_URL: LOCAL_B,
    })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /not loopback/)
  })

  it('exits 2 without OCHR_REHEARSAL even on loopback', () => {
    const r = spawnDrill('scale-drill.mjs', {
      OCHR_REHEARSAL: '',
      DATABASE_URL: LOCAL,
      RESTORE_URL: LOCAL_B,
    })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /OCHR_REHEARSAL/)
  })

  it('exits 2 when the restore host is a loopback alias of the source database', () => {
    const r = spawnDrill('scale-drill.mjs', {
      OCHR_REHEARSAL: 'local',
      DATABASE_URL: LOCAL,
      RESTORE_URL: ALIAS,
    })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /same database/)
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /LOCAL ONLY/)
  })

  it('exits 2 when a raw trailing space and %20 name the same driver database', () => {
    const r = spawnDrill('scale-drill.mjs', {
      OCHR_REHEARSAL: 'local',
      DATABASE_URL: 'postgresql://postgres@localhost:5433/openchurch_local ',
      RESTORE_URL: 'postgresql://postgres@127.0.0.1:5434/openchurch_local%20',
    })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /raw whitespace/)
    const blob = `${r.stdout}${r.stderr}`
    assert.doesNotMatch(blob, /LOCAL ONLY/)
    assert.doesNotMatch(blob, /distinct database/)
  })

  it('exits 2 when an invalid percent makes two URLs one driver database', () => {
    const r = spawnDrill('scale-drill.mjs', {
      OCHR_REHEARSAL: 'local',
      DATABASE_URL: 'postgresql://postgres@localhost:5433/mydb%2Ebackup?x=%g',
      RESTORE_URL: 'postgresql://postgres@127.0.0.1:5434/mydb%252Ebackup',
      PGDATABASE: '',
      PGUSER: '',
    })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /invalid percent/)
    const blob = `${r.stdout}${r.stderr}`
    assert.doesNotMatch(blob, /LOCAL ONLY/)
    assert.doesNotMatch(blob, /distinct database/)
  })

  it('exits 2 on the Argus empty-path dbname decoy', () => {
    const r = spawnDrill('scale-drill.mjs', {
      OCHR_REHEARSAL: 'local',
      DATABASE_URL: LOCAL,
      RESTORE_URL: ARGUS_RESTORE,
      PGDATABASE: '',
      PGUSER: '',
    })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /ambiguous|same database/)
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /LOCAL ONLY/)
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /decoy_restore/)
  })
})

describe('pull-backup CLI refuse path with --to', () => {
  it('exits 2 on remote without acknowledgment', () => {
    const r = spawnSync(
      process.execPath,
      [join(ROOT, 'scripts', 'pull-backup.mjs'), '--to', '/tmp/ochr-backup-refuse'],
      {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, DATABASE_URL: REMOTE, OCHR_BACKUP_PULL: '' },
      },
    )
    assert.equal(r.status, 2)
    assert.match(`${r.stdout}${r.stderr}`, /not loopback|Refusing/)
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /s3cretPASS/)
  })
})


// TARS closure: refuse unsupported representations rather than reinterpret them.
const RESIDUAL_URLS = [
  ...['[127.0.0.1]', '[localhost]', '[[::1]]', '[::1]', 'localhost,127.0.0.1', '127.0.0.1%2Clocalhost']
    .flatMap(host => ['host', 'hostaddr'].map(key => `${LOCAL}?${key}=${host}`)),
  `${LOCAL}?x=%`, `${LOCAL}?x=%2`,
  'http://localhost/openchurch_local', 'unix://localhost/tmp/pg.sock?db=openchurch_local',
  'postgresql://postgres@%2Ftmp?host=127.0.0.1',
]

describe('TARS residual closure', () => {
  for (const [index, url] of RESIDUAL_URLS.entries()) {
    it(`rejects unsupported representation ${index} TARS-RESIDUAL`, () => {
      assert.notEqual(classifyDatabaseUrl(url).kind, 'local', url)
      assert.equal(requireLocalRehearsal({ rehearsal: 'local', urls: [{ label: 'DATABASE_URL', url }] }).ok, false, url)
      assert.equal(assertDistinctDatabaseUrls(url, LOCAL_B).ok, false, url)
      if (!url.startsWith('postgresql:')) assert.equal(redactDatabaseUrl(url), '[unparseable url]')
    })
  }

  it('keeps ordinary local TCP and IPv6 supported TARS-VALID', () => {
    for (const url of [LOCAL, LOCAL_B, 'postgresql://postgres@[::1]:5433/openchurch_local',
      `${LOCAL}?host=::1`, `${LOCAL}?host=127.0.0.1`, `${LOCAL}?host=%6Cocalhost`,
      `${LOCAL}?application_name=local%20rehearsal`]) {
      assert.equal(classifyDatabaseUrl(url).kind, 'local', url)
      assert.equal(requireLocalRehearsal({ rehearsal: 'local', urls: [{ label: 'DATABASE_URL', url }] }).ok, true, url)
    }
    assert.equal(assertDistinctDatabaseUrls(LOCAL, LOCAL_B).ok, true)
  })

  it('refuses residuals in each drill before driver import TARS-CLI', () => {
    for (const url of RESIDUAL_URLS) {
      // Prove refusal before spawning: no accepted target is ever dialed.
      assert.notEqual(classifyDatabaseUrl(url).kind, 'local')
      for (const script of ['restore-drill.mjs', 'offsite-restore-drill.mjs', 'scale-drill.mjs']) {
        const result = spawnDrill(script, { OCHR_REHEARSAL: 'local', DATABASE_URL: url, RESTORE_URL: LOCAL_B })
        assert.equal(result.status, 2, `${script}: ${result.stderr}`)
        assert.doesNotMatch(`${result.stdout}${result.stderr}`, /LOCAL ONLY|ERR_MODULE_NOT_FOUND|ECONN/)
      }
    }
  })
})
