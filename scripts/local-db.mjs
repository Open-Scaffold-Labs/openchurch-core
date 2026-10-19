#!/usr/bin/env node
// local-db — a clean OpenChurch database on this machine, from zero.
//
// WHY THIS EXISTS. Between Pass 7 and Pass 8 the Supabase dev database
// became unreachable and stayed that way. Two corrections sat at TESTED
// rather than VERIFIED for a full pass because there was nowhere to run
// them. PostgreSQL was already installed; what was missing was a way to
// stand a database up without improvising six commands from memory and
// getting one of them subtly wrong.
//
// WHAT IT IS NOT. A local Postgres is strong behavioural evidence and
// nothing more. It does not run through Supavisor, so it says nothing about
// transaction-pooling behaviour, prepared-statement handling, or connection
// limits. It is not the deployed dev environment and it is emphatically not
// production. See docs/EVIDENCE.md.
//
//   node scripts/local-db.mjs up      # cluster + database + all migrations
//   node scripts/local-db.mjs status  # what is applied, and where
//   node scripts/local-db.mjs reset   # drop and rebuild from zero
//   node scripts/local-db.mjs down    # stop the cluster, keep the data
//   node scripts/local-db.mjs env     # print the export line for a shell
//
// SAFETY. The target is decided by THIS FILE, not by the environment. There
// is no code path here that reads DATABASE_URL from the shell or from
// server/.env, so `local-db reset` cannot be pointed at the shared dev
// database by an env var, a stale export, or a copied terminal. NODE_ENV is
// never consulted: "we are in development" is a belief, and a belief is not
// a safety mechanism. Every command prints its target before it acts.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { classifyDatabaseUrl } from './lib/db-target-guard.mjs'

// WHERE POSTGRES LIVES IS DISCOVERED. WHAT THIS TOOL TOUCHES IS NOT.
//
// PGBIN was hardcoded to the Debian path and the cluster was always started
// by `su pg -c`. Both are true of the cloud container this script was written
// in and of neither macOS nor a plain Linux workstation, so from Pass 9 until
// 2026-09-03 "the default forge" ran in exactly one place while EVIDENCE.md
// called it the default. On the operator's own Mac it died on
// `mkdir /pgdata` — a path macOS will not create at all — and the entire
// server suite failed for a reason that had nothing to do with the code.
//
// So the LOCATION of the binaries and the ACCOUNT that runs them are now
// discovered from the machine. The TARGET — loopback, port, database name —
// is still decided here and still asserted below; none of it is read from
// DATABASE_URL, server/.env, or NODE_ENV. Portability is not a safety
// property and is not allowed to become one.
function findPgBin() {
  if (process.env.OCHR_LOCAL_PGBIN) return process.env.OCHR_LOCAL_PGBIN
  const candidates = [
    '/usr/lib/postgresql/16/bin',            // Debian/Ubuntu, the container
    '/opt/homebrew/opt/postgresql@16/bin',   // Homebrew, Apple silicon
    '/usr/local/opt/postgresql@16/bin',      // Homebrew, Intel
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ]
  for (const dir of candidates) if (existsSync(join(dir, 'initdb'))) return dir
  // Last resort: whatever is on PATH.
  const which = spawnSync('sh', ['-c', 'command -v initdb'], { encoding: 'utf8' })
  if (which.status === 0 && which.stdout.trim()) {
    return which.stdout.trim().replace(/\/initdb$/, '')
  }
  console.error('\nlocal-db: no PostgreSQL 16 binaries found.')
  console.error('          Looked in:\n            ' + candidates.join('\n            '))
  console.error('          Install postgresql@16, or set OCHR_LOCAL_PGBIN.\n')
  process.exit(3)
}

const PGBIN   = findPgBin()
// A cluster must not run as root. In the container an unprivileged `pg`
// account is created and used; on a workstation the invoking user is already
// unprivileged and owns the data directory, so there is nobody to switch to.
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0
const PGOWNER = 'pg'                    // unprivileged account, container only
const PGDATA  = process.env.OCHR_LOCAL_PGDATA
  || (IS_ROOT ? '/pgdata' : join(process.env.HOME || '.', '.openchurch', 'pgdata'))
const PGSOCK  = process.env.OCHR_LOCAL_PGSOCK
  || (IS_ROOT ? '/pgrun' : join(process.env.HOME || '.', '.openchurch', 'pgrun'))
const PGPORT  = process.env.OCHR_LOCAL_PGPORT || '5433'
const PGUSER  = 'postgres'
const DBNAME  = 'openchurch_local'

// The one URL this tool will ever touch. Not read from anywhere.
const URL = `postgresql://${PGUSER}@localhost:${PGPORT}/${DBNAME}`

// A last line of defence in case someone edits the constants above: the host
// must be loopback and the database name must be the local one. A URL that
// fails this is refused rather than corrected, because a tool that quietly
// rewrites the database you asked for is worse than one that stops. libpq
// ?host= / ?hostaddr= overrides are treated as the real host (RECOVERY-L3-05).
function assertLocal(url) {
  const cls = classifyDatabaseUrl(url)
  let pathname = ''
  try { pathname = new URL_(url).pathname } catch { /* invalid handled below */ }
  const localName = pathname === `/${DBNAME}`
  if (cls.kind !== 'local' || !localName) {
    console.error(`\nlocal-db: refusing to act on ${cls.hostname || '(unparseable)'}${pathname}`)
    console.error(`This tool only ever touches ${DBNAME} on loopback.\n`)
    process.exit(2)
  }
}
const URL_ = globalThis.URL

const sh = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { encoding: 'utf8', ...opts })

// As root, drop to the unprivileged account; otherwise we already are one.
const asOwner = (cmd) =>
  IS_ROOT ? sh('su', [PGOWNER, '-c', cmd]) : sh('sh', ['-c', cmd])

const psql = (sql, db = DBNAME) =>
  sh(`${PGBIN}/psql`, ['-h', PGSOCK, '-p', PGPORT, '-U', PGUSER, '-d', db, '-tAc', sql])

const running = () => psql('select 1', 'postgres').status === 0

function ensureOwner() {
  if (IS_ROOT) {
    if (sh('id', [PGOWNER]).status !== 0) sh('useradd', ['-m', PGOWNER])
    for (const dir of [PGDATA, PGSOCK]) {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      sh('chown', ['-R', PGOWNER, dir])
    }
    return
  }
  // Unprivileged: the directories belong to whoever is running this.
  for (const dir of [PGDATA, PGSOCK]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
}

function startCluster() {
  if (running()) return 'already running'
  if (!existsSync(join(PGDATA, 'PG_VERSION'))) {
    const init = asOwner(`${PGBIN}/initdb -D ${PGDATA} -A trust -U ${PGUSER}`)
    if (init.status !== 0) { console.error(init.stderr || init.stdout); process.exit(1) }
  }
  const start = asOwner(
    `${PGBIN}/pg_ctl -D ${PGDATA} -l ${PGSOCK}/pg.log -o '-p ${PGPORT} -k ${PGSOCK}' start`)
  if (start.status !== 0) { console.error(start.stderr || start.stdout); process.exit(1) }
  for (let i = 0; i < 20; i++) { if (running()) return 'started'; sh('sleep', ['1']) }
  console.error('local-db: cluster did not accept connections'); process.exit(1)
}

const dbExists = () =>
  psql(`select 1 from pg_database where datname = '${DBNAME}'`, 'postgres').stdout.trim() === '1'

function createDb() {
  if (dbExists()) return 'already present'
  const r = psql(`CREATE DATABASE ${DBNAME}`, 'postgres')
  if (r.status !== 0) { console.error(r.stderr); process.exit(1) }
  return 'created'
}

// Migrations run through the project's own CLI, deliberately. A second
// migration runner here would be a second thing to keep in step, and the
// point is to prove THE migration chain applies — not a copy of it.
function migrate() {
  const r = spawnSync('node', ['server/src/migrate-cli.js'], {
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: URL },
  })
  process.stdout.write(r.stdout || '')
  if (r.status !== 0) {
    process.stderr.write(r.stderr || '')
    console.error('\nlocal-db: migrations did NOT apply. The database is not usable.\n')
    process.exit(1)
  }
}

// What the tree expects, versus what the database has.
//
// The ledger is NOT queried here. The first version of this script ran its
// own SELECT against the migrations ledger to build a MISSING list, and the
// smoke suite failed it on the spot: "NOTHING OUTSIDE
// migrations/applied.js READS THE LEDGER FOR A VERSION". That guard exists
// because two readers of the ledger once drifted and the rollback tool spent
// a while reading a sentinel row as production's schema. A third reader is a
// third chance to drift, and a database helper is exactly the kind of tool
// that would sit unnoticed while it did.
//
// (That guard matches on source text and does not strip comments, so even
// quoting the table name in a comment trips it. Noted in the Pass 9 report;
// not changed here, because loosening a release-integrity guard to make room
// for my own documentation is the wrong trade.)
//
// So this asks the one bounded reader, the same way /api/health does. The
// per-migration MISSING list it replaced was decoration anyway: a migration
// that will not apply already fails the runner loudly, with a non-zero exit
// — proved by deliberately breaking one.
async function status() {
  if (!running())  { console.log('cluster:  not running'); return }
  if (!dbExists()) { console.log(`cluster:  running\ndatabase: ${DBNAME} does not exist`); process.exit(1) }

  process.env.DATABASE_URL = URL
  const { EXPECTED_MIGRATION } = await import('../server/src/migrations/names.js')
  const { appliedMigration }   = await import('../server/src/migrations/applied.js')
  const pool = (await import('../server/src/db.js')).default

  let applied
  try { applied = await appliedMigration() }
  catch (err) {
    console.log(`cluster:  running\ndatabase: ${DBNAME}\nledger:   unreadable — ${err.message}`)
    await pool.end().catch(() => {})
    process.exit(1)
  }

  console.log(`cluster:  running on port ${PGPORT}`)
  console.log(`database: ${DBNAME}`)
  console.log(`expected: ${EXPECTED_MIGRATION}`)
  console.log(`applied:  ${applied ?? 'none — never migrated'}`)
  await pool.end().catch(() => {})

  if (applied !== EXPECTED_MIGRATION) {
    console.log('state:    MISMATCH — run `node scripts/local-db.mjs up`')
    process.exit(1)
  }
  console.log('state:    tree and database agree')
}

const cmd = process.argv[2] || 'status'
assertLocal(URL)

if (cmd !== 'env') {
  console.log(`local-db: target ${URL}`)
  console.log('          LOCAL ONLY — not Supabase, not production.\n')
}

switch (cmd) {
  case 'up': {
    ensureOwner()
    console.log(`cluster:  ${startCluster()}`)
    console.log(`database: ${createDb()}`)
    migrate()
    await status()
    console.log(`\nRun the server:  DATABASE_URL='${URL}' node server/src/index.js`)
    console.log(`Run the tests:   cd server && DATABASE_URL='${URL}' npx vitest run`)
    break
  }
  case 'reset': {
    ensureOwner()
    startCluster()
    console.log(`dropping ${DBNAME} …`)
    psql(`DROP DATABASE IF EXISTS ${DBNAME} WITH (FORCE)`, 'postgres')
    createDb()
    migrate()
    await status()
    break
  }
  case 'down': {
    const r = asOwner(`${PGBIN}/pg_ctl -D ${PGDATA} -m fast stop`)
    console.log(r.status === 0 ? 'cluster stopped (data kept)' : (r.stderr || r.stdout).trim())
    break
  }
  case 'env':
    process.stdout.write(`export DATABASE_URL='${URL}'\n`)
    break
  case 'status':
    await status()
    break
  default:
    console.error(`local-db: unknown command '${cmd}' — use up | reset | status | down | env`)
    process.exit(2)
}
