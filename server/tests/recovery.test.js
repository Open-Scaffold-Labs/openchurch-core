// Getting things back — the Continuity Vault, the release rollback path,
// and the off-site backup that has to refuse rather than lie.
//
// Extracted from smoke.test.js, which had grown past 15,000 lines. These
// blocks moved because they already stood alone: each signs up its own
// parish and shares nothing with the rest of the suite. Nothing about them
// changed in the move — same assertions, same fixtures, same names.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
import { RUN_ID, app, bindServer, closeServer, migrateOnce } from './support/harness.js'

let server

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
}, 60_000)

afterAll(async () => {
  await closeServer(server)
  await pool.end()
})

describe('the weekly backup refuses rather than lying', () => {
  const KEY = 'RESEND_API_KEY'
  const ADMIN = 'SUPER_ADMIN_EMAIL'
  const STORE = ['BACKUP_STORAGE', 'BACKUP_DIR', 'BACKUP_S3_ENDPOINT', 'BACKUP_S3_BUCKET',
                 'BACKUP_S3_REGION', 'BACKUP_S3_KEY_ID', 'BACKUP_S3_SECRET']
  let saved

  beforeAll(() => { saved = Object.fromEntries([KEY, ADMIN, ...STORE].map(v => [v, process.env[v]])) })
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  })

  it('IT SKIPS WHEN THERE IS NOWHERE TO DELIVER', async () => {
    const { runWeeklyBackupDigest } = await import('../src/services/backupDigest.js')
    process.env[ADMIN] = 'founder@example.com'
    delete process.env[KEY]
    delete process.env.BACKUP_STORAGE
    delete process.env.BACKUP_DIR

    const res = await runWeeklyBackupDigest()
    // Skipped, and the reason names what is missing. Storage is the only
    // destination for parish data (#214), so no storage = no export built.
    expect(res.skipped).toMatch(/no backup storage/i)
    expect(res.storage).toBeTruthy()
    expect(res.email).toBeTruthy()
    // And emphatically NOT the success shape, which is what it used to
    // return here: { orgs, attached, oversized, failed }.
    expect(res.orgs).toBeUndefined()
    expect(res.stored).toBeUndefined()
  })

  it('STORAGE ALONE IS A WORKING BACKUP — NO MAILBOX REQUIRED', async () => {
    // The point of the whole change. Before this, no email meant no
    // backup; the artifact was built and discarded weekly.
    const { mkdtemp, readdir } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { runWeeklyBackupDigest } = await import('../src/services/backupDigest.js')

    delete process.env[KEY]
    delete process.env[ADMIN]
    const dir = await mkdtemp(join(tmpdir(), 'ochr-digest-'))
    process.env.BACKUP_STORAGE = 'file'
    process.env.BACKUP_DIR = dir

    // Own fixtures (flake fix): two parishes this test creates and nobody
    // else touches. The assertions that matter are made about THEM.
    const own = []
    for (const tag of ['a', 'b']) {
      const { rows: [o] } = await pool.query(
        `INSERT INTO ochr_organizations (name, slug) VALUES ($1, $2) RETURNING id`,
        [`Recovery fixture ${tag} ${RUN_ID}`, `recovery-fixture-${tag}-${RUN_ID}`.toLowerCase().replace(/[^a-z0-9-]/g, '-')])
      own.push(String(o.id))
    }

    const res = await runWeeklyBackupDigest()
    expect(res.skipped).toBeUndefined()
    expect(res.stored).toBeGreaterThan(0)

    // ACCOUNTING, not equality. runWeeklyBackupDigest() enumerates EVERY
    // organization in the database — correct for a backup, and the reason
    // this assertion cannot be `stored === orgs` here: the suite runs its
    // files in parallel against one database, so other files create and
    // delete parishes while this loop is running. The org list is read
    // once and the set moves underneath it, which made this test fail
    // about two runs in three once the suite grew past ten files.
    //
    // What must be true regardless of who else is writing is that the
    // digest ACCOUNTS for every org it set out to store. There are THREE
    // buckets, not two: stored, store_failures (the write went wrong), and
    // failed (buildOrgExport threw — which is what a parish deleted
    // mid-loop produces). The digest computes `failed + storeFailures.length`
    // for its own subject line, so this identity is the code's, not one
    // invented here.
    // That is the property the surrounding describe is about — a backup
    // that refuses rather than lying — and it is strictly stronger than
    // the equality it replaces, which could be satisfied by a digest that
    // dropped an org from both counts.
    // FLAKE (83 vs 84): the identity above was asserted over EVERY org in
    // the shared database. A parish another file places on HOLD after the
    // list is read is skipped by the digest's per-org HOLD re-check and
    // lands in no bucket, so the global sum came up one short. Globally we
    // can only say nothing was double-counted; exact accounting is asserted
    // for this test's own parishes below.
    expect(res.stored + res.store_failures.length + res.failed).toBeLessThanOrEqual(res.orgs)
    for (const id of own) {
      expect(res.store_failures.some(f => f.startsWith(`org ${id}:`))).toBe(false)
    }
    expect(res.notified).toBe(false)      // truthfully: nobody was told
    expect(res.attached).toBe(0)

    // And the artifacts are really on disk — one per parish that stored,
    // not per parish that existed when the list was taken.
    // Tenant-separated (#214): orgs/<orgId>/<date>.json.gz — one prefix
    // per parish, keyed by id, never by name or slug.
    const stamp = new Date().toISOString().slice(0, 10)
    const orgDirs = await readdir(join(dir, 'orgs'))
    const files = []
    for (const id of orgDirs) {
      expect(id).toMatch(/^\d+$/)
      for (const f of await readdir(join(dir, 'orgs', id))) files.push(f)
    }
    expect(files.length).toBe(res.stored)
    expect(files.every(f => f === `${stamp}.json.gz`)).toBe(true)
    for (const id of own) {
      expect(orgDirs).toContain(id)
      expect(await readdir(join(dir, 'orgs', id))).toEqual([`${stamp}.json.gz`])
    }
    await pool.query('DELETE FROM ochr_organizations WHERE id = ANY($1::int[])', [own.map(Number)])

    delete process.env.BACKUP_STORAGE
    delete process.env.BACKUP_DIR
  })

  it('A WRITE THAT SUCCEEDS AND LEAVES NOTHING IS CAUGHT', async () => {
    // The failure this whole change exists to remove, reproduced: a
    // store that answers 200 to every PUT and then has nothing in it.
    // Counting successful writes would call this a clean backup. Only
    // reading the object back catches it — so the digest does, and this
    // proves the digest does rather than assuming it.
    const http = await import('node:http')
    const server = http.createServer((req, res) => {
      if (req.method === 'PUT') { req.resume(); res.writeHead(200); return res.end() }
      // ListObjectsV2, always empty. The write "worked"; nothing is there.
      res.writeHead(200, { 'Content-Type': 'application/xml' })
      res.end('<ListBucketResult></ListBucketResult>')
    })
    await new Promise(r => server.listen(0, '127.0.0.1', r))
    const port = server.address().port

    delete process.env[KEY]
    delete process.env[ADMIN]
    process.env.BACKUP_STORAGE = 's3'
    process.env.BACKUP_S3_ENDPOINT = `http://127.0.0.1:${port}`
    process.env.BACKUP_S3_BUCKET = 'openchurch-backups'
    process.env.BACKUP_S3_REGION = 'us-east-1'
    process.env.BACKUP_S3_KEY_ID = 'AKIAIOSFODNN7EXAMPLE'
    process.env.BACKUP_S3_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'

    // Own fixtures (flake fix, same as the test above): two parishes only
    // this test creates. Exact accounting is asserted for THEM.
    const own = []
    for (const tag of ['a', 'b']) {
      const { rows: [o] } = await pool.query(
        `INSERT INTO ochr_organizations (name, slug) VALUES ($1, $2) RETURNING id`,
        [`Recovery verify fixture ${tag} ${RUN_ID}`, `recovery-verify-fixture-${tag}-${RUN_ID}`.toLowerCase().replace(/[^a-z0-9-]/g, '-')])
      own.push(o.id)
    }

    // Fixture-level proof that the scoped assertions survive concurrent
    // churn, made deterministic: two OUTSIDE parishes are in the org list,
    // and at the digest's per-org HOLD re-check one is held and the other
    // deleted, exactly what parallel files do. Both fall out of every bucket,
    // which is what made the old global equality come up short.
    const outside = []
    for (const tag of ['held', 'gone']) {
      const { rows: [o] } = await pool.query(
        `INSERT INTO ochr_organizations (name, slug) VALUES ($1, $2) RETURNING id`,
        [`Recovery outside ${tag} ${RUN_ID}`, `recovery-outside-${tag}-${RUN_ID}`.toLowerCase().replace(/[^a-z0-9-]/g, '-')])
      outside.push(o.id)
    }
    const [heldOutside, goneOutside] = outside
    const realQuery = pool.query.bind(pool)
    const churn = vi.spyOn(pool, 'query').mockImplementation(async (sql, params) => {
      if (typeof sql === 'string' && sql.includes('WHERE id = $1 AND held_at IS NULL') && Array.isArray(params)) {
        if (params[0] === heldOutside) await realQuery('UPDATE ochr_organizations SET held_at = NOW() WHERE id = $1', [heldOutside])
        if (params[0] === goneOutside) await realQuery('DELETE FROM ochr_organizations WHERE id = $1', [goneOutside])
      }
      return realQuery(sql, params)
    })

    const { monitor } = await import('../src/monitoring/index.js')
    const verifyLog = vi.spyOn(monitor, 'error')
    try {
      const { runWeeklyBackupDigest } = await import('../src/services/backupDigest.js')
      const res = await runWeeklyBackupDigest()
      churn.mockRestore()
      expect(res.skipped).toBeUndefined()
      // Nothing counted as stored, and every parish named as a problem.
      expect(res.stored).toBe(0)
      // Same three-bucket accounting as above: a parish deleted by another
      // test file mid-loop lands in `failed`, never reaching the store at
      // all, so it cannot appear in store_failures.
      // FLAKE (93 vs 94): asserted over EVERY org in the shared database, a
      // parish another file holds after the list is read is skipped by the
      // digest's per-org HOLD re-check and lands in no bucket. Globally only
      // "nothing double-counted" holds; each of this test's own parishes
      // must be named as a verify failure.
      // No org counted twice: every store failure names a distinct org.
      const failedOrgIds = res.store_failures.map(f => Number(/^org (\d+):/.exec(f)?.[1]))
      expect(failedOrgIds.every(Number.isInteger)).toBe(true)
      expect(new Set(failedOrgIds).size).toBe(failedOrgIds.length)
      // Globally only "nothing double-counted" holds: the buckets never sum
      // past the org list. The two outside parishes are in that list and in
      // no bucket, so the old equality could not hold here.
      expect(res.store_failures.length + res.failed).toBeLessThanOrEqual(res.orgs - 2)
      expect(failedOrgIds).not.toContain(heldOutside)
      expect(failedOrgIds).not.toContain(goneOutside)
      // Exact accounting for this test's own parishes: each named once, as a
      // verify failure, and none in `failed` (verify calls name each once).
      for (const id of own) {
        const mine = res.store_failures.filter(f => f.startsWith(`org ${id}:`))
        expect(mine).toHaveLength(1)
        expect(mine[0]).toMatch(/not found after writing/)
      }
      expect(res.store_failures.length).toBeGreaterThan(0)
      expect(res.store_failures[0]).toMatch(/not found after writing/)
      // The heartbeat says "details are in the monitor log". A verify
      // failure has to write that log, once per store failure.
      const verifyCalls = verifyLog.mock.calls.filter(c => c[0] === 'backup.digest.verify')
      expect(verifyCalls.length).toBe(res.store_failures.length)
      for (const id of own) expect(verifyCalls.filter(([, , ctx]) => ctx.orgId === id)).toHaveLength(1)
      for (const [, err, ctx] of verifyCalls) {
        expect(err.message).toMatch(/not found after writing/)
        expect(ctx.orgId).toEqual(expect.any(Number))
        expect(ctx.key).toMatch(/^orgs\/\d+\/\d{4}-\d{2}-\d{2}\.json\.gz$/)
        expect(ctx).toEqual({ orgId: ctx.orgId, key: ctx.key })
      }
    } finally {
      churn.mockRestore()
      verifyLog.mockRestore()
      await pool.query('DELETE FROM ochr_organizations WHERE id = ANY($1::int[])', [[...own, ...outside]]).catch(() => {})
      await new Promise(r => server.close(r))
      for (const v of ['BACKUP_STORAGE', 'BACKUP_S3_ENDPOINT', 'BACKUP_S3_BUCKET',
                       'BACKUP_S3_REGION', 'BACKUP_S3_KEY_ID', 'BACKUP_S3_SECRET']) delete process.env[v]
    }
  })

  it('the run reports honestly which half is missing', async () => {
    const { runWeeklyBackupDigest } = await import('../src/services/backupDigest.js')
    delete process.env[ADMIN]
    process.env[KEY] = 'test-key-not-used-for-delivery'
    delete process.env.BACKUP_STORAGE
    delete process.env.BACKUP_DIR
    // A key with no recipient and no storage: skipped, nothing built,
    // and the missing recipient is named.
    const res = await runWeeklyBackupDigest()
    expect(res.skipped).toMatch(/no backup storage/i)
    expect(res.email).toMatch(/SUPER_ADMIN_EMAIL/)
  })

  it('and the transport reports itself honestly', async () => {
    const { emailTransportIsLive } = await import('../src/email/send.js')
    delete process.env[KEY]
    expect(emailTransportIsLive()).toBe(false)
    process.env[KEY] = 'anything'
    expect(emailTransportIsLive()).toBe(true)
    delete process.env[KEY]
  })
})

// ─────────────────────────────────────────────────────────────────────────
// The way back — release log and rollback safety
//
// The valuable half of a rollback tool is the REFUSAL, and a refusal that
// has never been seen to fire is a refusal nobody should trust. So the
// classifier is tested against each of the five things that break old
// code, written as real DDL, plus the three shapes that look dangerous
// and are not.
//
// The distinction that matters most is the last one: a constraint DROPPED
// and re-ADDED under the same name is a replacement, not a new
// restriction. The first real target this tool was pointed at was refused
// because of migration 086, which widens a CHECK — a wrong answer on its
// first real question, and the fastest way to teach somebody to ignore it.
// ─────────────────────────────────────────────────────────────────────────
describe('the way back — a rollback that refuses when it should', () => {
  it('A RESTORE PUTS PARENTS BEFORE CHILDREN', async () => {
    // Getting this wrong is SILENT: the restore still succeeds, it just
    // inserts every child twice and takes six times longer. Nothing
    // fails, so nothing tells you — it survived until a parish big
    // enough for seconds to become minutes was drilled. 21,100 records
    // restored in 95s alphabetically and 14.5s in dependency order.
    const { dependencyOrder } = await import('../../scripts/dependency-order.mjs')

    // The exact case that cost 80 seconds: donations sort before funds
    // alphabetically, and every gift references one.
    const order = dependencyOrder(
      ['ochr_donations', 'ochr_funds', 'ochr_clients', 'ochr_organizations'],
      [
        { child: 'ochr_donations', parent: 'ochr_funds' },
        { child: 'ochr_donations', parent: 'ochr_clients' },
        { child: 'ochr_clients', parent: 'ochr_organizations' },
        { child: 'ochr_funds', parent: 'ochr_organizations' },
      ])
    expect(order.indexOf('ochr_organizations')).toBeLessThan(order.indexOf('ochr_clients'))
    expect(order.indexOf('ochr_funds')).toBeLessThan(order.indexOf('ochr_donations'))
    expect(order.indexOf('ochr_clients')).toBeLessThan(order.indexOf('ochr_donations'))
    expect(order).toHaveLength(4)

    // A self-reference cannot be helped by ordering and must not stall
    // the sort — ochr_calendar_events points at itself for recurrence.
    const selfy = dependencyOrder(
      ['ochr_calendar_events', 'ochr_organizations'],
      [
        { child: 'ochr_calendar_events', parent: 'ochr_calendar_events' },
        { child: 'ochr_calendar_events', parent: 'ochr_organizations' },
      ])
    expect(selfy).toEqual(['ochr_organizations', 'ochr_calendar_events'])

    // A cycle leaves its members at the end rather than dropping them or
    // looping; the drill's retry pass settles those exactly as before.
    const cyclic = dependencyOrder(['a', 'b'], [{ child: 'a', parent: 'b' }, { child: 'b', parent: 'a' }])
    expect(cyclic.slice().sort()).toEqual(['a', 'b'])

    // Nothing is ever lost, whatever the graph.
    const many = ['t1', 't2', 't3', 't4', 't5']
    expect(dependencyOrder(many, [{ child: 't1', parent: 't5' }]).slice().sort()).toEqual(many)
  })

  it('THE RELEASE LOG RECORDS THE PAIR, NOT THE COMMIT', async () => {
    const { recordRelease, releaseHistory, _resetForTests } = await import('../src/release/log.js')
    const env = `test-${RUN_ID}`
    const commit = 'a'.repeat(40)

    _resetForTests()
    const first = await recordRelease({ commit, commit_short: 'aaaaaaa', environment: env })
    expect(first.recorded).toBeTruthy()
    expect(first.recorded.boots).toBe(1)

    // Same process, same release: written once, not per request. This is
    // the serverless case — a warm container must not write on every hit.
    const again = await recordRelease({ commit, commit_short: 'aaaaaaa', environment: env })
    expect(again.skipped).toBe(true)

    // A new process (a cold start, a redeploy) bumps the same row.
    _resetForTests()
    const reboot = await recordRelease({ commit, commit_short: 'aaaaaaa', environment: env })
    expect(reboot.recorded.boots).toBe(2)
    expect(reboot.recorded.id).toBe(first.recorded.id)

    // The SAME commit against a DIFFERENT schema is a different row,
    // because it is a different state of the system and therefore a
    // different thing to roll back to.
    await pool.query(
      `INSERT INTO ochr_release_log (commit, commit_short, environment, migration)
       VALUES ($1, 'aaaaaaa', $2, '001-bilingual')`, [commit, env])
    const hist = await releaseHistory(env)
    expect(hist.length).toBe(2)
    expect(new Set(hist.map(h => h.commit)).size).toBe(1)

    // One environment only. A preview release is not a rollback target
    // for production, and mixing them is how somebody picks wrong at speed.
    await pool.query(
      `INSERT INTO ochr_release_log (commit, commit_short, environment, migration)
       VALUES ($1, 'bbbbbbb', $2, '001-bilingual')`, ['b'.repeat(40), `${env}-preview`])
    expect((await releaseHistory(env)).length).toBe(2)
  })

  it('the recorder can never be the reason a deploy fails to boot', async () => {
    const { recordRelease, _resetForTests } = await import('../src/release/log.js')
    _resetForTests()
    // A commit longer than the column, a null environment — whatever goes
    // wrong, it reports the failure and does not throw. This runs inside
    // the health handler and after migrations on boot; throwing here would
    // take the site down at exactly the moment it is needed up.
    const res = await recordRelease({ commit: null, commit_short: null, environment: null })
    expect(res.failed).toBeTruthy()
    _resetForTests()
  })

  it('EVERY ONE OF THE FIVE HAZARDS IS REFUSED', async () => {
    const { classifySql } = await import('../../scripts/rollback-classify.mjs')
    const hazards = [
      ['ALTER TABLE ochr_clients DROP COLUMN nickname',                    /drops a column/],
      ['DROP TABLE ochr_old_thing',                                        /drops a table/],
      ['ALTER TABLE ochr_clients ALTER COLUMN name TYPE VARCHAR(40)',      /changes a column type/],
      ['ALTER TABLE ochr_clients RENAME COLUMN name TO full_name',         /renames something/],
      ['ALTER TABLE ochr_clients ADD COLUMN parish_code TEXT NOT NULL',    /NOT NULL column with no DEFAULT/],
      [`ALTER TABLE ochr_clients ADD CONSTRAINT ochr_clients_status_check
          CHECK (status IN ('active'))`,                                   /adds a new CHECK/],
      ['ALTER TABLE ochr_clients ALTER COLUMN email SET NOT NULL',         /makes an existing column required/],
    ]
    for (const [sql, why] of hazards) {
      const c = classifySql(sql)
      expect(c.reasons.length, `should block: ${sql.slice(0, 50)}`).toBeGreaterThan(0)
      expect(c.reasons.join(' ')).toMatch(why)
    }
  })

  it('AND EVERY ADDITIVE CHANGE IS ALLOWED THROUGH', async () => {
    const { classifySql } = await import('../../scripts/rollback-classify.mjs')
    const safe = [
      'ALTER TABLE ochr_clients ADD COLUMN parish_code TEXT',
      "ALTER TABLE ochr_clients ADD COLUMN parish_code TEXT NOT NULL DEFAULT ''",
      `CREATE TABLE IF NOT EXISTS ochr_brand_new (
         id SERIAL PRIMARY KEY,
         kind TEXT NOT NULL CHECK (kind IN ('a', 'b')))`,
      'CREATE INDEX IF NOT EXISTS idx_x ON ochr_clients(name)',
    ]
    for (const sql of safe) {
      const c = classifySql(sql)
      expect(c.reasons, `should be safe: ${sql.slice(0, 50)}`).toEqual([])
    }
  })

  it('A REPLACED CONSTRAINT IS READ, NOT REFUSED', async () => {
    const { classifySql } = await import('../../scripts/rollback-classify.mjs')
    // Migration 086's real shape. Widening a CHECK is safe for old code:
    // it writes a subset of what is now allowed.
    const replaced = classifySql(`
      ALTER TABLE ochr_coa_mappings DROP CONSTRAINT ochr_coa_mappings_source_type_check;
      ALTER TABLE ochr_coa_mappings
        ADD CONSTRAINT ochr_coa_mappings_source_type_check
        CHECK (source_type IN ('donation_category', 'payroll', 'fund'));
    `)
    expect(replaced.reasons).toEqual([])
    expect(replaced.warnings.join(' ')).toMatch(/replaces the CHECK/)

    // But a NEW constraint under a name nothing dropped still blocks.
    const brandNew = classifySql(`
      ALTER TABLE ochr_coa_mappings
        ADD CONSTRAINT ochr_coa_mappings_new_check CHECK (source_type IN ('payroll'));
    `)
    expect(brandNew.reasons.length).toBeGreaterThan(0)
  })

  // A CHECK on a column the SAME migration adds constrains nothing an older
  // build can produce, for exactly the reason the classifier already gives
  // for CREATE TABLE: old code cannot write what it has never heard of.
  //
  // Found because migration 093 (organization locale) was flagged by this
  // tool. The tool was right to ask and wrong to block, and the fix is the
  // existing principle applied one level down — not an exception for 093.
  it('a CHECK confined to columns the migration itself adds is not a rollback hazard', async () => {
    const { classifySql } = await import('../../scripts/rollback-classify.mjs')

    const newColumn = classifySql(`
      ALTER TABLE ochr_organizations ADD COLUMN IF NOT EXISTS locale TEXT NOT NULL DEFAULT 'en';
      ALTER TABLE ochr_organizations
        ADD CONSTRAINT ochr_organizations_locale_check CHECK (locale IN ('en', 'es'));
    `)
    expect(newColumn.reasons).toEqual([])
    expect(newColumn.warnings.join(' ')).toMatch(/only columns this migration adds/)

    // Narrow on purpose. One pre-existing column in the expression and it
    // blocks again, because then old code CAN write a rejected value.
    const preExisting = classifySql(`
      ALTER TABLE ochr_organizations
        ADD CONSTRAINT ochr_organizations_tradition_check CHECK (tradition IN ('catholic'));
    `)
    expect(preExisting.reasons.length).toBeGreaterThan(0)

    // THE CASE THAT FORCED A BALANCED-PAREN READER.
    //
    // The statement slicer terminates on a quote, so this arrives at the
    // CHECK analysis as `CHECK (newcol IN (` — everything from the first
    // literal onward, INCLUDING `oldcol`, is missing. Reading columns off
    // that fragment would call this safe on the strength of the half it
    // happened to receive. The expression is now read from the source with
    // balanced parentheses instead.
    const mixed = classifySql(`
      ALTER TABLE t ADD COLUMN newcol TEXT;
      ALTER TABLE t ADD CONSTRAINT c CHECK (newcol IN ('a','b') AND oldcol > 0);
    `)
    expect(mixed.reasons.length).toBeGreaterThan(0)

    // An expression whose parens never balance is UNKNOWN, and unknown
    // blocks. A classifier that guesses when it cannot parse is the thing
    // this whole file exists to not be.
    const unreadable = classifySql(`
      ALTER TABLE t ADD COLUMN n TEXT;
      ALTER TABLE t ADD CONSTRAINT c CHECK (n IN (;
    `)
    expect(unreadable.reasons.length).toBeGreaterThan(0)
  })

  it('THE ROLLBACK WINDOW STAYS ADDITIVE, AND THE TOOL KNOWS WHERE IT ENDS', async () => {
    const { classifyFile, migrationFiles } = await import('../../scripts/rollback-classify.mjs')
    const all = migrationFiles()

    // The property the tool depends on, scoped to the window a real
    // rollback actually targets. "Every migration ever is additive" is
    // NOT the claim and never was — 003, 044, 058 and 063 each did
    // something old code could not survive, years of releases ago. Nobody
    // rolls back to migration 003. But if somebody drops a column in 090,
    // that IS in the window, and this goes red in CI rather than at 9pm.
    const WINDOW = 12
    const recent = all.slice(-WINDOW)
    const offenders = []
    for (const f of recent) {
      const c = classifyFile(f)
      if (c.reasons.length) offenders.push(`${f}: ${c.reasons.join('; ')}`)
    }
    expect(offenders).toEqual([])

    // And the older hazards are still SEEN — a classifier that reported
    // the whole history as clean would be one that had stopped looking.
    //
    // This list was 003, 044, 058, 063. Two of those four turned out to be
    // FALSE POSITIVES, found when migration 093 was flagged for the same
    // shape: 058 and 063 each ADD a column and then CHECK that column, and
    // old code cannot write a column it has never heard of. They are
    // asserted below as safe-for-a-stated-reason rather than dropped from
    // the file, because "it stopped being flagged" and "it was never a
    // hazard" are different facts and only one of them is true here.
    //
    // 003 and 044 are the real ones and are load-bearing for this
    // assertion: 003 CHECKs `role`, a column that already existed, so old
    // code genuinely can write a value it now rejects; 044 SET NOT NULL on
    // an existing column, which old INSERTs omit.
    const ancient = all.filter(f => /^(003|044)-/.test(f))
    expect(ancient.length).toBe(2)
    for (const f of ancient) {
      expect(classifyFile(f).reasons.length, `${f} should be flagged`).toBeGreaterThan(0)
    }

    // The two reclassified ones, pinned. If a future edit to the classifier
    // makes these blocking again it is a regression; if it makes them
    // silent — no reason AND no warning — the rule has stopped explaining
    // itself, which is how a tool starts getting ignored.
    for (const f of all.filter(f => /^(058|063)-/.test(f))) {
      const c = classifyFile(f)
      expect(c.reasons, `${f} constrains only columns it adds`).toEqual([])
      expect(c.warnings.join(' '), `${f} should say why it is safe`).toMatch(/only columns this migration adds/)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Multi-root capture — the recurring series
//
// The Vault registry used to carry a paragraph explaining why calendar
// events were NOT protected: a series delete removes twenty-six sibling
// rows in one statement, and "recoverable unless you deleted the series"
// is worse than no promise. This is that paragraph being deleted.
//
// The assertion that matters is not "the events came back". It is that
// the Mass intention attached to the THIRD Tuesday came back attached to
// the third Tuesday. Single-root capture would have reconnected it to
// whichever occurrence the entry called the root, which is a quiet,
// plausible, wrong answer — the kind that survives a green test suite.
// ─────────────────────────────────────────────────────────────────────────
describe('Continuity Vault — a whole recurring series', () => {
  const org = {
    organizationName: `Series Parish ${RUN_ID}`, name: 'Sera Admin',
    email: `series_admin_${RUN_ID}@example.com`, password: 'smoke-test-pw-series-1',
  }
  let tok, orgId
  let seedId, occurrenceIds, intentionId, entryId

  beforeAll(async () => {
    const r = await request(server).post('/api/auth/signup')
      .set('X-Forwarded-For', '10.99.14.81').send(org)
    expect(r.status).toBe(201)
    tok = r.body.token; orgId = r.body.user.organization.id

    // Four Tuesdays. Choir practice, which is the thing a parish
    // secretary actually deletes by accident.
    const made = await request(server).post('/api/calendar').set('Authorization', `Bearer ${tok}`)
      .send({
        title: `Choir practice ${RUN_ID}`, date: '2026-09-01',
        start_time: '19:00', end_time: '20:30', type: 'other',
        recurrence: { freq: 'weekly', interval: 1, count: 4 },
      })
    expect(made.status).toBeLessThan(300)
    seedId = made.body.id ?? made.body.event?.id

    const all = await pool.query(
      `SELECT id, date FROM ochr_calendar_events
        WHERE recurrence_parent_id = $1 AND organization_id = $2 ORDER BY date`,
      [seedId, orgId])
    occurrenceIds = all.rows.map(r => r.id)
    expect(occurrenceIds).toHaveLength(4)
    expect(occurrenceIds[0]).toBe(seedId)

    // A Mass intention on the THIRD occurrence — SET NULL, so it
    // survives the delete with a hole in it. This is the relink whose
    // target has to be remembered per root.
    const mi = await pool.query(
      `INSERT INTO ochr_mass_intentions
         (organization_id, intention, mass_date, calendar_event_id, status)
       VALUES ($1, $2, $3, $4, 'scheduled') RETURNING id`,
      [orgId, `+Series Test ${RUN_ID}`, '2026-09-15', occurrenceIds[2]])
    intentionId = mi.rows[0].id
    // CHK-05: a series with check-ins cannot be deleted. This block
    // proves multi-root capture and the Mass-intention relink, so it
    // keeps the series empty of attendance. The attendance refusal
    // lives in chk05EventAttendance.test.js.
  })

  it('DELETING THE SERIES CAPTURES EVERY OCCURRENCE, NOT ONE WITH CHILDREN', async () => {
    // Clicked from the second occurrence, which is the realistic case —
    // nobody opens the seed to cancel the term.
    const res = await request(server)
      .delete(`/api/calendar/${occurrenceIds[1]}?scope=series`)
      .set('Authorization', `Bearer ${tok}`)
    expect(res.status).toBe(204)

    const left = await pool.query(
      'SELECT COUNT(*)::int AS n FROM ochr_calendar_events WHERE id = ANY($1::int[])',
      [occurrenceIds])
    expect(left.rows[0].n).toBe(0)

    const { rows } = await pool.query(
      `SELECT id, kind, label, summary FROM ochr_vault_entries
        WHERE organization_id = $1 AND kind = 'event' ORDER BY id DESC LIMIT 1`, [orgId])
    expect(rows).toHaveLength(1)
    entryId = rows[0].id
    expect(rows[0].summary.roots).toBe(4)
    expect(rows[0].label).toContain('4 occurrences')
    expect(rows[0].label).toContain('2026-09-01')
    expect(rows[0].label).toContain('2026-09-22')

    // Siblings are ROOTS. If they had also been collected as cascade
    // children — which is what happens the moment the walk stops seeding
    // `seen` with every root — this count would be non-zero and the
    // restore would try to insert each occurrence twice.
    expect(rows[0].summary.cascaded.ochr_calendar_events ?? 0).toBe(0)
    expect(rows[0].summary.cascaded.ochr_checkins ?? 0).toBe(0)
  })

  it('the surviving Mass intention is left with a hole, and the entry knows about it', async () => {
    const mi = await pool.query(
      'SELECT calendar_event_id FROM ochr_mass_intentions WHERE id = $1', [intentionId])
    expect(mi.rowCount).toBe(1)
    expect(mi.rows[0].calendar_event_id).toBeNull()

    const res = await request(server).get(`/api/vault/${entryId}`).set('Authorization', `Bearer ${tok}`)
    expect(res.status).toBe(200)
    expect(res.body.would_restore.records).toBe(4)
    expect(res.body.would_restore.reconnections).toBe(1)
    // The one thing a restore will not put back, said before anyone
    // clicks rather than discovered afterwards.
    expect(res.body.would_restore.caveat).toMatch(/[Rr]eminders are not restored/)
  })

  it('RESTORING PUTS THE SEED BACK BEFORE ITS SIBLINGS, AND THE SERIES HOLDS', async () => {
    const res = await request(server).post(`/api/vault/${entryId}/restore`)
      .set('Authorization', `Bearer ${tok}`)
    expect(res.status).toBe(200)
    expect(res.body.restored.records).toBe(4)

    const back = await pool.query(
      `SELECT id, recurrence_parent_id FROM ochr_calendar_events
        WHERE id = ANY($1::int[]) ORDER BY id`, [occurrenceIds])
    expect(back.rowCount).toBe(4)
    // Every occurrence points at the seed, and the seed points at
    // itself. Insert the siblings first and this is a foreign-key error,
    // not a wrong number — which is why orderRoots exists.
    for (const row of back.rows) expect(row.recurrence_parent_id).toBe(seedId)
  })

  it('THE MASS INTENTION RECONNECTS TO ITS OWN TUESDAY, NOT THE FIRST ONE', async () => {
    const mi = await pool.query(
      'SELECT calendar_event_id FROM ochr_mass_intentions WHERE id = $1', [intentionId])
    // The whole point. A relink that forgot which root it pointed at
    // would put this on occurrenceIds[0] — a real date, a real event,
    // and the wrong Mass.
    expect(mi.rows[0].calendar_event_id).toBe(occurrenceIds[2])
    expect(mi.rows[0].calendar_event_id).not.toBe(occurrenceIds[0])
  })

  it('the seed goes back first even when the snapshot hands them over backwards', async () => {
    // Capture writes roots in id order, so on this table the seed
    // already leads and the ordering pass changes nothing. That makes it
    // exactly the kind of code that is never actually exercised — so
    // exercise it directly, with the order reversed, which is what a
    // hand-repaired entry or a table whose seed is not the lowest id
    // would hand it.
    const { orderRoots } = await import('../src/vault/index.js')
    const rows = await pool.query(
      `SELECT id, recurrence_parent_id FROM ochr_calendar_events
        WHERE recurrence_parent_id = $1 AND organization_id = $2 ORDER BY id DESC`,
      [seedId, orgId])
    expect(rows.rows[0].id).not.toBe(seedId)          // genuinely backwards

    const ordered = await orderRoots('ochr_calendar_events', rows.rows)
    expect(ordered).toHaveLength(rows.rows.length)
    expect(ordered[0].id).toBe(seedId)
    // Nothing dropped or duplicated on the way through.
    expect([...new Set(ordered.map(r => r.id))].sort())
      .toEqual(rows.rows.map(r => r.id).sort())
  })

  it('deleting one occurrence is one record, and deleting the seed says how many it took', async () => {
    // A single occurrence: one root, nothing cascaded from the calendar.
    const one = await request(server).delete(`/api/calendar/${occurrenceIds[3]}`)
      .set('Authorization', `Bearer ${tok}`)
    expect(one.status).toBe(204)
    const { rows: [single] } = await pool.query(
      `SELECT summary FROM ochr_vault_entries
        WHERE organization_id = $1 AND kind = 'event' ORDER BY id DESC LIMIT 1`, [orgId])
    expect(single.summary.roots).toBe(1)
    expect(single.summary.cascaded.ochr_calendar_events ?? 0).toBe(0)

    // The seed, alone, with no series scope. Its self-referencing FK
    // cascades the remaining occurrences away with it — a single-event
    // delete that quietly takes the term. The vault captures them, and
    // the entry is the first place that has ever been visible.
    const seed = await request(server).delete(`/api/calendar/${seedId}`)
      .set('Authorization', `Bearer ${tok}`)
    expect(seed.status).toBe(204)
    const { rows: [wide] } = await pool.query(
      `SELECT summary FROM ochr_vault_entries
        WHERE organization_id = $1 AND kind = 'event' ORDER BY id DESC LIMIT 1`, [orgId])
    expect(wide.summary.roots).toBe(1)
    expect(wide.summary.cascaded.ochr_calendar_events).toBe(2)

    const none = await pool.query(
      'SELECT COUNT(*)::int AS n FROM ochr_calendar_events WHERE id = ANY($1::int[])',
      [occurrenceIds])
    expect(none.rows[0].n).toBe(0)
  })
})
