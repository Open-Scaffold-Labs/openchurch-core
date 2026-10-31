import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildManifest, checkExportEnv, checkRestoreTarget, KEEP_DAILY_DEFAULT, normalizePrefix, objectNames,
  parseKeepDaily, parseObjectName, planPrune, resolvePgTarget, targetIdentity, latestComplete, validateManifest, PREFIX_DEFAULT } from './lib.mjs'

const P = PREFIX_DEFAULT
const R = 'age1' + 'q'.repeat(58)
const day = d => new Date(Date.UTC(2026, 9, d, 10, 17, 0))
const set = (d, { dump = true, manifest = true } = {}) => {
  const n = objectNames(P, day(d)); const out = []
  if (dump) out.push({ pathname: n.dump, size: 10 }); if (manifest) out.push({ pathname: n.manifest, size: 1 }); return out
}
const many = (from, to, opt) => Array.from({ length: to - from + 1 }, (_, i) => set(from + i, opt)).flat()

test('object names are dated, sortable and round-trip', () => {
  const n = objectNames(P, day(23))
  assert.equal(n.dump, 'db-backups/openchurch-prod/openchurch-2026-10-23T101700Z.dump.age')
  assert.equal(parseObjectName(n.manifest).kind, 'manifest')
  assert.equal(parseObjectName(n.dump).at.toISOString(), '2026-10-23T10:17:00.000Z')
  assert.equal(parseObjectName('db-backups/openchurch-prod/notes.txt'), null)
})

test('prefix must be a safe relative folder', () => {
  assert.equal(normalizePrefix(undefined), P)
  for (const bad of ['/abs/', 'no-slash', 'a/../b/', 'A/', 'a//b/']) assert.throws(() => normalizePrefix(bad))
})

test('keep: default 14 (operational), bounded, integers only', () => {
  assert.equal(parseKeepDaily(''), KEEP_DAILY_DEFAULT)
  assert.equal(KEEP_DAILY_DEFAULT, 14)
  assert.equal(parseKeepDaily('30'), 30)
  for (const bad of ['0', '2', '401', '-1', '7.5', 'x']) assert.throws(() => parseKeepDaily(bad))
})

const goodMan = (stamp, bytes = 10) => ({ format: 'openchurch-backup-manifest/v1', stamp,
  dump: { encrypted_bytes: bytes, encrypted_sha256: 'a'.repeat(64), plain_bytes: 9, plain_sha256: 'b'.repeat(64), toc_entries: 9 },
  schema: { migration_head: '125-x', migration_count: 126, public_table_count: 95 }, encryption: { tool: 'age' } })
const mansFor = blobs => new Map(blobs.filter(b => b.pathname.endsWith('.manifest.json')).map(b => { const st = parseObjectName(b.pathname).stamp; return [st, goodMan(st)] }))
const stampOf = d => objectNames(P, day(d)).stamp

test('prune keeps the newest N verified sets and deletes older verified ones', () => {
  const blobs = many(1, 20)
  const plan = planPrune(blobs, { prefix: P, keep: 14, manifests: mansFor(blobs) })
  assert.equal(plan.keep.length, 14)
  assert.equal(plan.delete.length, 12) // 6 sets x (dump + manifest)
  assert.ok(plan.delete.every(p => /2026-10-0[1-6]T/.test(p)))
})

test('prune never deletes with too few verified sets, and ignores incomplete newer sets', () => {
  const blobs = [...many(1, 5), ...many(6, 20, { manifest: false })]
  const plan = planPrune(blobs, { prefix: P, keep: 14, manifests: mansFor(blobs) })
  assert.deepEqual(plan.delete, [])
  assert.equal(plan.keep.length, 5)
})

// R370-2 regressions (each failed at 7a18b657: filename pairs alone counted).
test('R370-2: 15 newer zero-byte/{} pairs do not count and do not displace a verified set', () => {
  const blobs = [...set(1), ...Array.from({ length: 15 }, (_, i) => { const n = objectNames(P, day(2 + i)); return [{ pathname: n.dump, size: 0 }, { pathname: n.manifest, size: 2 }] }).flat()]
  const mans = new Map([[stampOf(1), goodMan(stampOf(1))], ...Array.from({ length: 15 }, (_, i) => [stampOf(2 + i), {}])])
  const plan = planPrune(blobs, { prefix: P, keep: 14, manifests: mans })
  assert.deepEqual(plan.delete, [])
  assert.deepEqual(plan.keep, [stampOf(1)])
  assert.equal(plan.unverified.length, 15)
})

test('R370-2: malformed manifest, wrong stamp, missing/zero/truncated dump never count and are never deleted', () => {
  const blobs = many(1, 20)
  const mans = mansFor(blobs)
  mans.set(stampOf(16), { format: 'nope' })                            // malformed
  mans.set(stampOf(17), goodMan(stampOf(3)))                           // wrong stamp
  const bad18 = objectNames(P, day(18)).dump; blobs.splice(blobs.findIndex(b => b.pathname === bad18), 1) // missing dump
  blobs.find(b => b.pathname === objectNames(P, day(19)).dump).size = 0 // zero-byte
  blobs.find(b => b.pathname === objectNames(P, day(20)).dump).size = 7 // truncated (manifest says 10)
  mans.set(stampOf(15), new Error('unreadable'))
  const plan = planPrune(blobs, { prefix: P, keep: 5, manifests: mans })
  assert.deepEqual(plan.unverified.map(u => u.stamp).sort(), [15, 16, 17, 18, 19, 20].map(stampOf).sort())
  assert.deepEqual(plan.keep, [14, 13, 12, 11, 10].map(stampOf))
  for (const d of [15, 16, 17, 18, 19, 20]) assert.ok(!plan.delete.some(p => p.includes(stampOf(d))), `deleted unverified ${d}`)
  assert.equal(plan.delete.length, 18) // days 1-9 verified, older than kept
})

test('R370-2: orphan dumps/manifests are preserved; foreign and out-of-prefix objects untouched', () => {
  const blobs = [...many(5, 20), ...set(1, { manifest: false }), ...set(2, { dump: false }), { pathname: P + 'README.txt' },
    { pathname: P + 'sub/openchurch-2026-10-01T000000Z.dump.age' }, { pathname: 'other/openchurch-2026-10-01T000000Z.dump.age' }]
  const mans = mansFor(blobs)
  const plan = planPrune(blobs, { prefix: P, keep: 14, manifests: mans })
  assert.ok(!plan.delete.includes(objectNames(P, day(1)).dump))
  assert.ok(!plan.delete.includes(objectNames(P, day(2)).manifest))
  assert.ok(!plan.delete.some(p => p.includes('README') || p.includes('/sub/') || p.startsWith('other/')))
  assert.equal(plan.delete.length, 4) // days 5,6
  assert.equal(plan.foreign.length, 2)
  assert.throws(() => planPrune(blobs, { prefix: P, keep: 1, manifests: mans }))
})

test('R370-2: no manifests map means nothing qualifies and nothing is deleted', () => {
  assert.deepEqual(planPrune(many(1, 20), { prefix: P, keep: 3 }).delete, [])
})

test('latestComplete skips a newest set whose manifest never uploaded', () => {
  const s = latestComplete([...many(1, 3), ...set(4, { manifest: false })], P)
  assert.equal(s.stamp, objectNames(P, day(3)).stamp)
})

const good = () => buildManifest({ stamp: '2026-10-23T101700Z', createdAt: '2026-10-23T10:17:00.000Z',
  encrypted: { bytes: 100, sha256: 'a'.repeat(64) }, plain: { bytes: 90, sha256: 'b'.repeat(64) },
  migration: { head: '125-x', count: 126 }, tableCount: 95, tocEntries: 400, pgDumpVersion: 'pg_dump 17', serverVersion: '17.4',
  gitSha: 'abc', encryption: { tool: 'age', recipient: R } })

test('manifest carries schema facts only and rejects key or URL material', () => {
  const m = good()
  assert.equal(m.schema.public_table_count, 95)
  assert.throws(() => validateManifest({ ...m, note: 'postgresql://u:p@h/db' }), /connection string/)
  assert.throws(() => validateManifest({ ...m, note: 'AGE-SECRET-KEY-1ABC' }), /key material/)
  assert.throws(() => validateManifest({ ...m, dump: { ...m.dump, encrypted_sha256: 'zz' } }))
  assert.throws(() => validateManifest({ ...m, schema: { ...m.schema, public_table_count: 0 } }))
})

test('export env: requires all three names, refuses loopback source, secret keys and stub in Actions', () => {
  const ok = { OC_BACKUP_DATABASE_URL: 'postgresql://ro@db.example.com:5432/postgres', OC_BACKUP_AGE_RECIPIENT: R, BLOB_READ_WRITE_TOKEN: 't' }
  assert.deepEqual(checkExportEnv(ok), [])
  assert.equal(checkExportEnv({}).length, 3)
  assert.match(checkExportEnv({ ...ok, OC_BACKUP_DATABASE_URL: 'postgresql://u@127.0.0.1:5999/x' }).join(), /loopback/)
  assert.deepEqual(checkExportEnv({ ...ok, OC_BACKUP_DATABASE_URL: 'postgresql://u@127.0.0.1:5999/x' }, { allowLocal: true }), [])
  assert.match(checkExportEnv({ ...ok, OC_BACKUP_AGE_RECIPIENT: 'AGE-SECRET-KEY-1XYZ' }).join(), /SECRET/)
  assert.match(checkExportEnv({ ...ok, OC_BACKUP_BLOB_STUB_DIR: '/tmp/x', GITHUB_ACTIONS: 'true' }).join(), /refused in GitHub Actions/)
})

test('restore target: loopback + OCHR_REHEARSAL=local + throwaway name + not 5433 + not the source', () => {
  const base = { OCHR_REHEARSAL: 'local', OC_RESTORE_DATABASE_URL: 'postgresql://postgres@127.0.0.1:55301/oc_restore_test' }
  assert.equal(checkRestoreTarget(base).ok, true)
  assert.equal(checkRestoreTarget({ ...base, OCHR_REHEARSAL: '' }).ok, false)
  assert.equal(checkRestoreTarget({ ...base, OC_RESTORE_DATABASE_URL: 'postgresql://u@db.supabase.co:5432/oc_restore_x' }).ok, false)
  assert.equal(checkRestoreTarget({ ...base, OC_RESTORE_DATABASE_URL: 'postgresql://u@localhost/oc_restore_x?host=db.example.com' }).ok, false)
  assert.match(checkRestoreTarget({ ...base, OC_RESTORE_DATABASE_URL: 'postgresql://u@127.0.0.1:5433/oc_restore_x' }).reason, /5433/)
  assert.equal(checkRestoreTarget({ ...base, OC_BACKUP_FORBIDDEN_PORTS: '55192,55301' }).ok, false)
  assert.match(checkRestoreTarget({ ...base, OC_RESTORE_DATABASE_URL: 'postgresql://u@127.0.0.1:55301/openchurch_local' }).reason, /oc_restore_/)
  assert.match(checkRestoreTarget({ ...base, OC_BACKUP_DATABASE_URL: base.OC_RESTORE_DATABASE_URL }).reason, /source/)
})

// R370-1 regressions (query ?port=5433 returned ok:true at 7a18b657).
test('R370-1: connection overrides in the restore URL are refused', () => {
  const base = { OCHR_REHEARSAL: 'local' }
  const T = u => checkRestoreTarget({ ...base, OC_RESTORE_DATABASE_URL: u })
  for (const u of [
    'postgresql://postgres@127.0.0.1:55310/oc_restore_probe?port=5433',
    'postgresql://postgres@127.0.0.1:55310/oc_restore_probe?port=55310&port=5433',
    'postgresql://postgres@127.0.0.1:55310/oc_restore_probe?sslmode=disable&sslmode=disable',
    'postgresql://postgres@127.0.0.1:55310/oc_restore_probe?hostaddr=127.0.0.1',
    'postgresql://postgres@127.0.0.1:55310/oc_restore_probe?dbname=openchurch_local',
    'postgresql://postgres@127.0.0.1:55310/oc_restore_probe?service=prod',
    'postgresql://postgres@127.0.0.1:55310/oc_restore_probe?options=-c%20x%3D1',
    'postgresql://postgres@127.0.0.1:55310,127.0.0.1:5433/oc_restore_probe',
    'postgresql://postgres@%2Ftmp:55310/oc_restore_probe',
    'postgresql:///oc_restore_probe',
  ]) assert.equal(T(u).ok, false, u)
  const ok = T('postgresql://postgres@127.0.0.1:55310/oc_restore_probe?sslmode=disable')
  assert.equal(ok.ok, true); assert.equal(ok.target.port, 55310); assert.equal(ok.target.database, 'oc_restore_probe')
})

test('R370-1: pgEnv uses exactly the validated target and drops inherited PG* overrides', async () => {
  const { pgEnv } = await import('./pg.mjs')
  const g = checkRestoreTarget({ OCHR_REHEARSAL: 'local', OC_RESTORE_DATABASE_URL: 'postgresql://postgres@127.0.0.1:55310/oc_restore_probe' })
  const e = pgEnv(g.target, { PATH: '/bin', PGPORT: '5433', PGHOST: 'db.example.com', PGSERVICE: 'prod', PGHOSTADDR: '10.0.0.1', PGOPTIONS: '-c x=1', PGDATABASE: 'openchurch_local' })
  assert.equal(e.PGPORT, '55310'); assert.equal(e.PGHOST, '127.0.0.1'); assert.equal(e.PGDATABASE, 'oc_restore_probe')
  for (const k of ['PGSERVICE', 'PGHOSTADDR', 'PGOPTIONS']) assert.equal(e[k], undefined, k)
  assert.equal(e.PGSERVICEFILE, '/dev/null')
  assert.throws(() => pgEnv('postgresql://u@127.0.0.1:55310/x?port=5433'))
})

test('R370-1: source/target compared by resolved identity, not raw string', () => {
  const r = checkRestoreTarget({ OCHR_REHEARSAL: 'local', OC_RESTORE_DATABASE_URL: 'postgresql://postgres@localhost:55310/oc_restore_a',
    OC_BACKUP_DATABASE_URL: 'postgresql://other@127.0.0.1:55310/oc_restore_a?sslmode=disable' })
  assert.equal(r.ok, false); assert.match(r.reason, /source/)
  assert.equal(targetIdentity(resolvePgTarget('postgresql://a@[::1]:1/d')), targetIdentity(resolvePgTarget('postgresql://b@localhost:1/d')))
  assert.match(checkExportEnv({ OC_BACKUP_DATABASE_URL: 'postgresql://ro@db.example.com:5432/postgres?host=evil', OC_BACKUP_AGE_RECIPIENT: R, BLOB_READ_WRITE_TOKEN: 't' }).join(), /overrides/)
})
