// Local end-to-end: throwaway Postgres + local blob stub. Skipped unless
// OC_BACKUP_E2E_PGPORT names a loopback throwaway cluster (trust auth,
// user postgres) that is NOT 5433. Needs pg_dump 17, age, server deps.
//
//   OC_BACKUP_E2E_PGPORT=55301 node --test scripts/backup-export/e2e.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { objectNames, PREFIX_DEFAULT } from './lib.mjs'

const PORT = process.env.OC_BACKUP_E2E_PGPORT
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const skip = !PORT ? 'OC_BACKUP_E2E_PGPORT not set' : PORT === '5433' ? 'refusing port 5433' : false
const url = db => `postgresql://postgres@127.0.0.1:${PORT}/${db}`
const sh = (cmd, args, env = {}) => spawnSync(cmd, args, { encoding: 'utf8',
  env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } })
const psql = (db, sql) => { const r = sh('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', PORT, '-U', 'postgres', '-d', db, '-At', '-F', '\t', ...sql]); assert.equal(r.status, 0, r.stderr); return r.stdout }

test('export -> stub blob -> prune -> restore rehearsal (isolated)', { skip }, () => {
  const work = mkdtempSync(join(tmpdir(), 'oc-x6-e2e-'))
  const stub = join(work, 'blob'); const SRC = 'oc_src_x6e2e'; const DST = 'oc_restore_x6e2e'
  for (const db of [SRC, DST]) sh('dropdb', ['--if-exists', '-h', '127.0.0.1', '-p', PORT, '-U', 'postgres', db])
  try {
    assert.equal(sh('createdb', ['-h', '127.0.0.1', '-p', PORT, '-U', 'postgres', SRC]).status, 0)
    const mig = sh('node', [join(ROOT, 'server/src/migrate-cli.js')], { DATABASE_URL: url(SRC), DOTENV_CONFIG_PATH: '/dev/null' })
    assert.equal(mig.status, 0, mig.stderr)
    psql(SRC, ['-f', join(ROOT, 'docs/stage11-12/pilot-backup-seed.sql')])

    // R370-4: the documented role recipe (backup-role.sql), minus the password on trust auth.
    psql(SRC, ['-c', 'CREATE SCHEMA oc_private_fixture; CREATE TABLE oc_private_fixture.secret(x text); INSERT INTO oc_private_fixture.secret VALUES (\'not-public\')'])
    psql('postgres', ['-c', 'DROP ROLE IF EXISTS oc_backup_ro'])
    psql(SRC, ['-f', join(HERE, 'backup-role.sql')])
    const asRo = sql => sh('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', PORT, '-U', 'oc_backup_ro', '-d', SRC, '-At', '-c', sql])
    assert.notEqual(asRo('DELETE FROM ochr_schema_migrations').status, 0, 'backup role could write (session default)')
    const w = asRo('SET default_transaction_read_only = off; BEGIN READ WRITE; DELETE FROM ochr_schema_migrations; COMMIT')
    assert.notEqual(w.status, 0, 'backup role could write after opting out of read-only'); assert.match(w.stderr, /permission denied/)
    assert.notEqual(asRo('SET default_transaction_read_only = off; CREATE TABLE public.oc_x6_rogue(x int)').status, 0, 'backup role could create')
    assert.notEqual(asRo('CREATE ROLE oc_x6_rogue').status, 0, 'backup role could manage roles')
    const priv = asRo('SELECT * FROM oc_private_fixture.secret')
    assert.notEqual(priv.status, 0, 'backup role read a non-public schema'); assert.match(priv.stderr, /permission denied/)
    assert.equal(asRo("SELECT pg_has_role('oc_backup_ro', 'pg_read_all_data', 'member')").stdout.trim(), 'f')

    const kg = sh('age-keygen', ['-o', join(work, 'id.txt')])
    assert.equal(kg.status, 0, kg.stderr)
    const recipient = /age1[0-9a-z]{58}/.exec(readFileSync(join(work, 'id.txt'), 'utf8'))[0]

    // Twenty older VERIFIED fake sets (valid manifest, size matches) so pruning
    // has work, plus R370-2 unverified sets that must survive pruning.
    mkdirSync(join(stub, PREFIX_DEFAULT), { recursive: true })
    const fakeMan = stamp => JSON.stringify({ format: 'openchurch-backup-manifest/v1', stamp,
      dump: { encrypted_bytes: 1, encrypted_sha256: 'a'.repeat(64), plain_bytes: 1, plain_sha256: 'b'.repeat(64), toc_entries: 1 },
      schema: { migration_head: '1-x', migration_count: 1, public_table_count: 1 }, encryption: { tool: 'age' } })
    for (let d = 1; d <= 20; d++) {
      const n = objectNames(PREFIX_DEFAULT, new Date(Date.UTC(2026, 8, d, 10, 17)))
      writeFileSync(join(stub, n.dump), 'x'); writeFileSync(join(stub, n.manifest), fakeMan(n.stamp))
    }
    const unv = [1, 2, 3, 4].map(d => objectNames(PREFIX_DEFAULT, new Date(Date.UTC(2026, 7, d, 10, 17))))
    writeFileSync(join(stub, unv[0].dump), ''); writeFileSync(join(stub, unv[0].manifest), '{}')          // zero-byte + {}
    writeFileSync(join(stub, unv[1].dump), 'x'); writeFileSync(join(stub, unv[1].manifest), fakeMan(unv[3].stamp)) // wrong stamp
    writeFileSync(join(stub, unv[2].dump), 'x')                                                           // orphan dump
    writeFileSync(join(stub, unv[3].dump), 'xyz'); writeFileSync(join(stub, unv[3].manifest), fakeMan(unv[3].stamp)) // truncated/size mismatch
    writeFileSync(join(stub, PREFIX_DEFAULT, 'keep-me.txt'), 'foreign')
    const base = { OC_BACKUP_BLOB_STUB_DIR: stub, OC_BACKUP_ALLOW_LOCAL_SOURCE: '1', OC_BACKUP_AGE_RECIPIENT: recipient,
      OC_BACKUP_DATABASE_URL: `postgresql://oc_backup_ro@127.0.0.1:${PORT}/${SRC}`, OC_BACKUP_KEEP_DAILY: '5',
      // R370-3: a "migration" commits between the facts and pg_dump.
      OC_BACKUP_TEST_BETWEEN_URL: url(SRC),
      OC_BACKUP_TEST_BETWEEN_SQL: "CREATE TABLE public.oc_x6_late(id int); INSERT INTO ochr_schema_migrations(name) VALUES ('999-late-x6')" }
    const before = psql(SRC, ['-c', 'SELECT count(*) FROM ochr_schema_migrations']).trim()

    // Fail loudly: missing recipient -> non-zero, nothing uploaded.
    const bad = sh('node', [join(HERE, 'export.mjs')], { ...base, OC_BACKUP_AGE_RECIPIENT: '' })
    assert.equal(bad.status, 1); assert.match(bad.stderr, /OC_BACKUP_AGE_RECIPIENT is not set/)
    const unreachable = sh('node', [join(HERE, 'export.mjs')], { ...base, OC_BACKUP_DATABASE_URL: 'postgresql://postgres@127.0.0.1:9/nope' })
    assert.equal(unreachable.status, 1)

    const ex = sh('node', [join(HERE, 'export.mjs')], base)
    console.log(ex.stdout)
    assert.equal(ex.status, 0, ex.stderr)
    assert.match(ex.stdout, /test hook: ran between-facts-and-dump SQL/)
    assert.match(ex.stdout, /retention: keep 5 .* kept 5, deleted 32, unverified 4/)
    for (const n of unv) assert.ok(readdirSync(join(stub, PREFIX_DEFAULT)).includes(n.dump.slice(PREFIX_DEFAULT.length)), `unverified ${n.stamp} deleted`)
    // Undo the late "migration" so the source fingerprint matches the snapshot again.
    psql(SRC, ['-c', "DROP TABLE public.oc_x6_late; DELETE FROM ochr_schema_migrations WHERE name = '999-late-x6'"])
    const files = readdirSync(join(stub, PREFIX_DEFAULT))
    assert.equal(files.filter(f => f.endsWith('.dump.age')).length, 9) // 5 kept + 4 unverified preserved
    assert.ok(files.includes('keep-me.txt'))
    const man = JSON.parse(readFileSync(join(stub, PREFIX_DEFAULT, files.find(f => f.endsWith('.manifest.json') && f.startsWith('openchurch-2026-10'))), 'utf8'))
    assert.ok(man.schema.migration_head.startsWith('127'))
    assert.equal(String(man.schema.migration_count), before, 'manifest must describe the snapshot, not the post-hook DB')
    const raw = JSON.stringify(man)
    for (const leak of ['Example', 'example.org', 'postgres@', 'AGE-SECRET']) assert.ok(!raw.includes(leak), `manifest leaks ${leak}`)
    const enc = readFileSync(join(stub, PREFIX_DEFAULT, `openchurch-${man.stamp}.dump.age`))
    assert.ok(enc.subarray(0, 21).toString().startsWith('age-encryption.org/v1'))
    assert.ok(!enc.includes(Buffer.from('rehearsal-st-example')), 'ciphertext contains plaintext')

    const rbase = { OC_BACKUP_BLOB_STUB_DIR: stub, OCHR_REHEARSAL: 'local', OC_BACKUP_AGE_IDENTITY_FILE: join(work, 'id.txt'), OC_RESTORE_DATABASE_URL: url(DST) }
    const r5433 = sh('node', [join(HERE, 'restore-rehearsal.mjs')], { ...rbase, OC_RESTORE_DATABASE_URL: 'postgresql://postgres@127.0.0.1:5433/oc_restore_x' })
    assert.equal(r5433.status, 2); assert.match(r5433.stderr, /5433/)
    for (const u of [`postgresql://postgres@127.0.0.1:${PORT}/oc_restore_x?port=5433`, `postgresql://postgres@127.0.0.1:${PORT},127.0.0.1:5433/oc_restore_x`]) {
      const r = sh('node', [join(HERE, 'restore-rehearsal.mjs')], { ...rbase, OC_RESTORE_DATABASE_URL: u })
      assert.equal(r.status, 2, u); assert.match(r.stderr, /REFUSED/); assert.doesNotMatch(r.stdout, /set /, 'refusal must precede any store/DB work')
    }
    const rRemote = sh('node', [join(HERE, 'restore-rehearsal.mjs')], { ...rbase, OC_RESTORE_DATABASE_URL: 'postgresql://u@db.example.com/oc_restore_x' })
    assert.equal(rRemote.status, 2)
    const rSrc = sh('node', [join(HERE, 'restore-rehearsal.mjs')], { ...rbase, OC_RESTORE_DATABASE_URL: url(SRC) })
    assert.equal(rSrc.status, 2) // not an oc_restore_ name

    // Inherited PG* overrides pointing at 5433 must be ignored (stripped by pgEnv).
    const ok = sh('node', [join(HERE, 'restore-rehearsal.mjs')], { ...rbase, PGPORT: '5433', PGSERVICE: 'nope', PGDATABASE: 'openchurch_local' })
    assert.match(ok.stdout, new RegExp(`on port ${PORT}`))
    console.log(ok.stdout)
    assert.equal(ok.status, 0, ok.stderr + ok.stdout)
    assert.match(ok.stdout, /RESTORE VERIFIED/)
    const fp = db => psql(db, ['-f', join(ROOT, 'docs/stage11-12/pilot-backup-fingerprint.sql')])
    assert.equal(fp(DST), fp(SRC), '#337 fingerprint differs after restore')

    const again = sh('node', [join(HERE, 'restore-rehearsal.mjs')], rbase)
    assert.equal(again.status, 2); assert.match(again.stderr, /non-empty/)

    // Tampered ciphertext -> sha mismatch, exit 1.
    const p = join(stub, PREFIX_DEFAULT, `openchurch-${man.stamp}.dump.age`)
    const b = readFileSync(p); b[b.length - 1] ^= 1; writeFileSync(p, b)
    sh('dropdb', ['-h', '127.0.0.1', '-p', PORT, '-U', 'postgres', DST])
    const t = sh('node', [join(HERE, 'restore-rehearsal.mjs')], rbase)
    assert.equal(t.status, 1); assert.match(t.stderr, /sha256 mismatch/)
  } finally {
    for (const db of [SRC, DST]) sh('dropdb', ['--if-exists', '-h', '127.0.0.1', '-p', PORT, '-U', 'postgres', db])
    sh('psql', ['-X', '-h', '127.0.0.1', '-p', PORT, '-U', 'postgres', '-d', 'postgres', '-c', 'DROP ROLE IF EXISTS oc_backup_ro'])
    rmSync(work, { recursive: true, force: true })
  }
})
