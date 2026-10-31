#!/usr/bin/env node
// X-6 / FD-3 / A9 scheduled export: production Postgres -> pg_dump -Fc ->
// age (public recipient) -> PRIVATE Vercel Blob, plus a data-free manifest,
// then retention pruning. Run by .github/workflows/db-backup-export.yml.
// Setup and first-run verification: docs/ops/BACKUP-EXPORT.md.
//
// Fails loudly: any error exits non-zero and nothing after it runs. The
// manifest is uploaded LAST, so a set without a manifest is incomplete and
// is never chosen by the restore rehearsal or counted by pruning.
//
// Env (names only; values are GitHub Actions secrets):
//   OC_BACKUP_DATABASE_URL   read-only role connection string (required)
//   OC_BACKUP_AGE_RECIPIENT  age public key, age1... (required; NOT the secret identity)
//   BLOB_READ_WRITE_TOKEN    private Blob store read-write token (required)
//   OC_BACKUP_KEEP_DAILY     sets kept (default 14 = operational default, unconfirmed)
//   OC_BACKUP_BLOB_PREFIX    default db-backups/openchurch-prod/
//   OC_BACKUP_PG_MAJOR       required pg_dump major (default 17)
//   OC_BACKUP_BLOB_STUB_DIR  local test stub only (refused in Actions)
//   OC_BACKUP_ALLOW_LOCAL_SOURCE=1  local e2e only (refused in Actions)

import { mkdtemp, rm, stat, writeFile, chmod, readFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildManifest, checkExportEnv, resolvePgTarget, normalizePrefix, objectNames, parseKeepDaily, planPrune, sha256File, groupSets } from './lib.mjs'
import { openStore } from './blob-store.mjs'
import { openSnapshotSession, pgEnv, psqlRows, run, toolMajor } from './pg.mjs'

const log = m => console.log(`backup-export: ${m}`)

// Phase names are fixed strings (no values) so the failure issue can say
// where the run stopped without claiming whether a backup was stored.
let phase = 'preflight'
const setPhase = (env, p) => { phase = p; if (env.OC_BACKUP_PHASE_FILE) writeFileSync(env.OC_BACKUP_PHASE_FILE, p + '\n') }

async function main(env = process.env) {
  setPhase(env, 'preflight')
  const allowLocal = env.OC_BACKUP_ALLOW_LOCAL_SOURCE === '1' && env.GITHUB_ACTIONS !== 'true'
  const errs = checkExportEnv(env, { allowLocal })
  if (errs.length) throw new Error(`refusing to start:\n  - ${errs.join('\n  - ')}`)
  const prefix = normalizePrefix(env.OC_BACKUP_BLOB_PREFIX)
  const keep = parseKeepDaily(env.OC_BACKUP_KEEP_DAILY)
  const wantMajor = Number(env.OC_BACKUP_PG_MAJOR || 17)

  const dump = await toolMajor('pg_dump')
  if (dump.major !== wantMajor) throw new Error(`pg_dump major ${dump.major}, expected ${wantMajor} (${dump.text})`)
  await toolMajor('age')

  const penv = pgEnv(resolvePgTarget(env.OC_BACKUP_DATABASE_URL, 'OC_BACKUP_DATABASE_URL'), { PATH: env.PATH, HOME: env.HOME })
  // Read-only session: even if the role were mis-granted, this run cannot write.
  penv.PGOPTIONS = '-c default_transaction_read_only=on -c statement_timeout=0'

  const work = await mkdtemp(join(tmpdir(), 'oc-backup-'))
  await chmod(work, 0o700)
  let session = null
  try {
    // R370-3: facts and dump from ONE exported snapshot.
    setPhase(env, 'snapshot-and-facts')
    session = await openSnapshotSession(penv)
    const facts = session.facts
    const serverMajor = Number(/^(\d+)/.exec(facts.serverVersion)?.[1])
    if (serverMajor > dump.major) throw new Error(`server ${facts.serverVersion} is newer than pg_dump ${dump.major}`)
    if (!(facts.tableCount > 0) || !(facts.migration.count > 0)) throw new Error('source has no public tables or no migration ledger')
    log(`source: server ${facts.serverVersion}, ${facts.tableCount} public tables, migration head ${facts.migration.head} (${facts.migration.count} applied), snapshot exported`)
    // Local e2e only: run SQL on a second (superuser) connection between the
    // facts and the dump, to prove a migration landing there cannot split them.
    if (allowLocal && env.OC_BACKUP_TEST_BETWEEN_SQL && env.OC_BACKUP_TEST_BETWEEN_URL) {
      await psqlRows(pgEnv(env.OC_BACKUP_TEST_BETWEEN_URL, { PATH: env.PATH, HOME: env.HOME }), env.OC_BACKUP_TEST_BETWEEN_SQL)
      log('test hook: ran between-facts-and-dump SQL')
    }

    const now = new Date()
    const names = objectNames(prefix, now)
    const plainPath = join(work, 'plain.dump')
    const encPath = join(work, 'dump.age')
    const t0 = Date.now()
    setPhase(env, 'dump')
    await run('pg_dump', ['-Fc', '-Z', '6', '--no-owner', '--no-privileges', '-n', 'public', `--snapshot=${session.snapshot}`, '-f', plainPath], { env: penv })
    await session.close(); session = null
    const tocText = (await run('pg_restore', ['--list', plainPath])).stdout
    const toc = tocText.split('\n').filter(l => /^\d+;/.test(l)).length
    // Cross-check from the archive itself: TABLE entries in public must equal the snapshot's count.
    const archTables = tocText.split('\n').filter(l => /^\d+; \d+ \d+ TABLE public /.test(l)).length
    if (archTables !== facts.tableCount) throw new Error(`archive has ${archTables} public tables, snapshot facts say ${facts.tableCount}`)
    const plain = { bytes: (await stat(plainPath)).size, sha256: await sha256File(plainPath) }
    setPhase(env, 'encrypt')
    await run('age', ['-r', env.OC_BACKUP_AGE_RECIPIENT.trim(), '-o', encPath, plainPath])
    await rm(plainPath, { force: true })
    const encrypted = { bytes: (await stat(encPath)).size, sha256: await sha256File(encPath) }
    log(`dump ${plain.bytes} bytes -> encrypted ${encrypted.bytes} bytes in ${((Date.now() - t0) / 1000).toFixed(1)} s, ${toc} TOC entries`)

    const manifest = buildManifest({
      stamp: names.stamp, createdAt: now.toISOString(), encrypted, plain, migration: facts.migration,
      tableCount: facts.tableCount, tocEntries: toc, pgDumpVersion: dump.text, serverVersion: facts.serverVersion,
      gitSha: env.GITHUB_SHA, encryption: { tool: 'age', recipient: env.OC_BACKUP_AGE_RECIPIENT.trim() },
    })
    manifest.extensions = facts.extensions
    const manPath = join(work, 'manifest.json')
    await writeFile(manPath, JSON.stringify(manifest, null, 2) + '\n')

    setPhase(env, 'upload')
    const store = await openStore(env)
    await store.putFile(names.dump, encPath, 'application/octet-stream')
    await store.putFile(names.manifest, manPath, 'application/json')
    const listed = await store.list(prefix)
    const up = listed.find(b => b.pathname === names.dump)
    if (!up || up.size !== encrypted.bytes) throw new Error(`uploaded ${names.dump} not listed with ${encrypted.bytes} bytes`)
    if (!listed.some(b => b.pathname === names.manifest)) throw new Error(`uploaded ${names.manifest} not listed`)
    log(`uploaded ${names.dump} (sha256 ${encrypted.sha256}) and manifest to ${store.kind} store`)

    // R370-2: read every listed manifest (small JSON, no decryption) so only
    // verified sets count toward retention.
    setPhase(env, 'prune')
    const manifests = new Map()
    for (const s of groupSets(listed, prefix).sets) {
      if (!s.manifest) continue
      if (!(s.manifest.size > 0 && s.manifest.size <= 64 * 1024)) { manifests.set(s.stamp, new Error('manifest size out of range')); continue }
      const mp = join(work, `m-${s.stamp}.json`)
      try { await store.getToFile(s.manifest.pathname, mp); manifests.set(s.stamp, JSON.parse(await readFile(mp, 'utf8'))) }
      catch (e) { manifests.set(s.stamp, e) }
    }
    const plan = planPrune(listed, { prefix, keep, manifests })
    if (!plan.keep.includes(names.stamp)) throw new Error('the set just uploaded does not qualify for retention; refusing to prune')
    if (plan.foreign.length) log(`WARNING: ${plan.foreign.length} unrecognised object(s) under ${prefix} left untouched`)
    for (const u of plan.unverified) log(`WARNING: set ${u.stamp} not verified (${u.why}); left untouched, not counted`)
    if (plan.delete.length) await store.del(plan.delete)
    log(`retention: keep ${keep} (operational default, unconfirmed); kept ${plan.keep.length}, deleted ${plan.delete.length}, unverified ${plan.unverified.length}`)
    setPhase(env, 'done')
    log(`OK ${names.stamp}`)
    return { names, manifest, plan }
  } finally {
    if (session) await session.close().catch(() => {})
    await rm(work, { recursive: true, force: true })
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(`backup-export: FAILED in phase ${phase}: ${e.message}`); process.exit(1) })
}
export { main }
