#!/usr/bin/env node
// X-6 isolated restore rehearsal for the Blob export.
//
// Downloads the newest COMPLETE set (or --stamp <stamp>), checks the
// encrypted sha256 against the manifest, decrypts with an age identity
// file held offline by José, checks the plaintext sha256, restores into a
// THROWAWAY loopback database and compares schema facts with the manifest.
//
// Refusals (exit 2): OCHR_REHEARSAL must be "local"; OC_RESTORE_DATABASE_URL
// must be loopback, not port 5433 (or OC_BACKUP_FORBIDDEN_PORTS), not the
// export source, and named oc_restore_<suffix>; the database must be empty
// or absent (it is created). Never run against production.
//
// Env: OCHR_REHEARSAL=local, OC_RESTORE_DATABASE_URL, OC_BACKUP_AGE_IDENTITY_FILE,
//      BLOB_READ_WRITE_TOKEN (or OC_BACKUP_BLOB_STUB_DIR), OC_BACKUP_BLOB_PREFIX.

import { mkdtemp, readFile, rm, chmod, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkRestoreTarget, latestComplete, normalizePrefix, sha256File, validateManifest, groupSets } from './lib.mjs'
import { openStore } from './blob-store.mjs'
import { pgEnv, psqlRows, run, schemaFacts } from './pg.mjs'

const log = m => console.log(`restore-rehearsal: ${m}`)
// Extensions the rehearsal may create locally before restoring public.
const EXT_ALLOW = new Set(['btree_gist', 'pgcrypto', 'uuid-ossp', 'citext', 'pg_trgm'])

class Refusal extends Error {}

async function main(env = process.env, argv = process.argv) {
  const guard = checkRestoreTarget(env)
  if (!guard.ok) throw new Refusal(guard.reason)
  if (!env.OC_BACKUP_AGE_IDENTITY_FILE) throw new Refusal('OC_BACKUP_AGE_IDENTITY_FILE (path to the offline age identity) is not set')
  const prefix = normalizePrefix(env.OC_BACKUP_BLOB_PREFIX)
  const want = (() => { const i = argv.indexOf('--stamp'); return i > -1 ? argv[i + 1] : null })()

  const store = await openStore(env)
  const listed = await store.list(prefix)
  const set = want ? groupSets(listed, prefix).sets.find(s => s.stamp === want && s.dump && s.manifest) : latestComplete(listed, prefix)
  if (!set) throw new Error(want ? `no complete backup set ${want}` : `no complete backup set under ${prefix}`)
  log(`set ${set.stamp} from ${store.kind} store`)

  const work = await mkdtemp(join(tmpdir(), 'oc-restore-'))
  await chmod(work, 0o700)
  const t0 = Date.now()
  try {
    const manPath = join(work, 'manifest.json'); const encPath = join(work, 'dump.age'); const plainPath = join(work, 'plain.dump')
    await store.getToFile(set.manifest.pathname, manPath)
    const manifest = validateManifest(JSON.parse(await readFile(manPath, 'utf8')))
    if (manifest.stamp !== set.stamp) throw new Error('manifest stamp does not match its object name')
    await store.getToFile(set.dump.pathname, encPath)
    const encSha = await sha256File(encPath)
    if (encSha !== manifest.dump.encrypted_sha256) throw new Error(`encrypted sha256 mismatch: got ${encSha}, manifest ${manifest.dump.encrypted_sha256}`)
    log(`encrypted sha256 OK ${encSha}`)
    await run('age', ['-d', '-i', env.OC_BACKUP_AGE_IDENTITY_FILE, '-o', plainPath, encPath])
    const plainSha = await sha256File(plainPath)
    if (plainSha !== manifest.dump.plain_sha256 || (await stat(plainPath)).size !== manifest.dump.plain_bytes) {
      throw new Error('decrypted dump does not match the manifest (sha256/size)')
    }
    log('decrypted; plaintext sha256 OK')

    const target = pgEnv(guard.target, { PATH: env.PATH, HOME: env.HOME })
    const admin = { ...target, PGDATABASE: 'postgres' }
    const exists = await psqlRows(admin, `SELECT 1 FROM pg_database WHERE datname = '${guard.database}'`)
    if (exists.length) {
      const [[n]] = await psqlRows(target, `SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'`)
      if (Number(n) > 0) throw new Refusal(`${guard.database} already has ${n} public tables. Refusing to restore over a non-empty database; drop it first.`)
    } else {
      await run('createdb', [guard.database], { env: admin })
    }
    for (const e of manifest.extensions || []) {
      if (!EXT_ALLOW.has(e.name)) { log(`note: source extension ${e.name} (${e.schema}) not recreated locally`); continue }
      if (!/^[a-z_][a-z0-9_]*$/.test(e.schema)) throw new Error(`bad extension schema ${e.schema}`)
      await psqlRows(target, `CREATE SCHEMA IF NOT EXISTS "${e.schema}"; CREATE EXTENSION IF NOT EXISTS "${e.name}" WITH SCHEMA "${e.schema}"`)
    }
    // A fresh database already has schema public; drop only that TOC line.
    const listPath = join(work, 'toc.list')
    const toc = (await run('pg_restore', ['--list', plainPath])).stdout
    await writeFile(listPath, toc.split('\n').filter(l => !/^\d+; \d+ \d+ SCHEMA - public /.test(l)).join('\n'))
    await run('pg_restore', ['--exit-on-error', '--single-transaction', '--no-owner', '--no-privileges', '-L', listPath, '-d', guard.database, plainPath], { env: target })
    const facts = await schemaFacts(target)
    const checks = [
      ['public_table_count', facts.tableCount, manifest.schema.public_table_count],
      ['migration_count', facts.migration.count, manifest.schema.migration_count],
      ['migration_head', facts.migration.head, manifest.schema.migration_head],
    ]
    const bad = checks.filter(([, a, b]) => a !== b)
    for (const [k, a, b] of checks) log(`${a === b ? 'ok  ' : 'FAIL'} ${k}: restored ${a}, manifest ${b}`)
    if (bad.length) throw new Error(`RESTORE FAILED: ${bad.map(b => b[0]).join(', ')}`)
    log(`RESTORE VERIFIED: set ${set.stamp}, ${facts.tableCount} tables, migration head ${facts.migration.head}, ${((Date.now() - t0) / 1000).toFixed(1)} s into ${guard.database} on port ${guard.port}`)
    return { stamp: set.stamp, facts }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => {
    console.error(`restore-rehearsal: ${e instanceof Refusal ? 'REFUSED' : 'FAILED'}: ${e.message}`)
    process.exit(e instanceof Refusal ? 2 : 1)
  })
}
export { main, Refusal }
