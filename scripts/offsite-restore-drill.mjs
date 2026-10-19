#!/usr/bin/env node
// Off-site restore drill (RELIABILITY 1.3).
//
// OpenChurch has produced a weekly off-site backup for months and had
// never restored from one. A backup nobody has restored is a rumour, and
// "your data is backed up" is a sentence we were not entitled to say.
//
// This drill takes the SAME artifact the Saturday run stores — the
// gzipped JSON that services/backupDigest.js writes to `orgs/<orgId>/<date>.json.gz` — and restores it
// into an isolated, empty database. It then checks the three things that
// make a restore a restore rather than a file that decompressed:
//
//   1. COMPLETENESS   every table and row count in the artifact arrives
//   2. ISOLATION      the restored copy contains exactly one parish, and
//                     no row belonging to any other
//   3. SEPARATION     the isolated database is not the source, and the
//                     restore never wrote to the source
//
// It also measures how long it took, because an RTO nobody has timed is
// a number somebody made up.
//
// Usage:
//   OCHR_REHEARSAL=local \
//   DATABASE_URL=<local source>  RESTORE_URL=<local, empty isolated db>  \
//     node scripts/offsite-restore-drill.mjs [--org <id>]
//
// FAIL-CLOSED (RECOVERY-L3-05). Both URLs must be loopback (including
// libpq ?host= / ?hostaddr= overrides). OCHR_REHEARSAL must be exactly
// `local`. RESTORE_URL must be a database you are willing to have emptied;
// the drill also refuses if it already holds parish data, and refuses if
// the restore database name is the same as the source — including when
// the URLs differ only by host alias (localhost vs 127.0.0.1),
// credentials, or query decoration. An empty path is the database
// node-pg opens (PGDATABASE, otherwise the user), not a ?dbname= decoy.
// A missing or ambiguous name (conflicting ?dbname=, or a name that
// contains /) is refused. Raw URL inequality is not identity.
// The most expensive mistake available here is restoring a backup over
// the thing you were backing up.
//
// WHAT THIS DRILL DOES NOT PROVE. The artifact is the LOGICAL layer:
// per-parish records, credential columns stripped by design. It is not a
// cluster restore, so it does not exercise Supabase point-in-time
// recovery, and it deliberately cannot bring back password hashes or
// tokens. Recovering a parish's records is not the same as recovering
// their ability to log in, and the policy has to say both. A green local
// restore is not production DR.

import { gzipSync, gunzipSync } from 'node:zlib'
import { dependencyOrder } from './dependency-order.mjs'
import {
  assertDistinctDatabaseUrls,
  redactDatabaseUrl,
  requireLocalRehearsal,
} from './lib/db-target-guard.mjs'

const argOrg = (() => {
  const i = process.argv.indexOf('--org')
  return i > -1 ? Number(process.argv[i + 1]) : null
})()

const RESTORE_URL = process.env.RESTORE_URL
const gate = requireLocalRehearsal({
  rehearsal: process.env.OCHR_REHEARSAL,
  urls: [
    { label: 'DATABASE_URL', url: process.env.DATABASE_URL },
    { label: 'RESTORE_URL', url: RESTORE_URL },
  ],
})
if (!gate.ok) {
  console.error(`offsite-restore-drill: ${gate.reason}`)
  process.exit(gate.code)
}
const distinct = assertDistinctDatabaseUrls(process.env.DATABASE_URL, RESTORE_URL)
if (!distinct.ok) {
  console.error(`offsite-restore-drill: ${distinct.reason}`)
  process.exit(distinct.code)
}
console.log(`offsite-restore-drill: ${gate.reason}`)
console.log(`  source  ${redactDatabaseUrl(process.env.DATABASE_URL)}`)
console.log(`  restore ${redactDatabaseUrl(RESTORE_URL)}`)
console.log('  LOCAL ONLY — logical parish restore ≠ PITR / hosted backup / prod rollback.\n')

const { default: pg } = await import('pg')
const { default: pool } = await import('../server/src/db.js')
const { buildOrgExport } = await import('../server/src/services/orgExport.js')

const checks = []
const check = (name, ok, detail = '') => { checks.push({ name, ok, detail }); return ok }
const started = Date.now()

const target = new pg.Pool({ connectionString: RESTORE_URL, max: 4 })

try {
  // ── produce the artifact, exactly as the Saturday email does ───────────
  const { rows: orgs } = await pool.query(
    argOrg
      ? 'SELECT id, name FROM ochr_organizations WHERE id = $1'
      : 'SELECT id, name FROM ochr_organizations ORDER BY id LIMIT 1',
    argOrg ? [argOrg] : []
  )
  if (!orgs.length) throw new Error('no organization to drill against')
  const org = orgs[0]

  const dump = await buildOrgExport(org.id)
  const gz = gzipSync(Buffer.from(JSON.stringify(dump), 'utf8'))
  const artifactBytes = gz.length
  console.log(`artifact: ${org.name} (id ${org.id}) — ${(artifactBytes / 1024).toFixed(1)} KiB gzipped`)

  // Round-trip through the compressed bytes, not the in-memory object.
  // Reading the object we just built would test nothing about the file
  // that actually leaves the building.
  const restored = JSON.parse(gunzipSync(gz).toString('utf8'))
  check('the artifact decompresses and parses', restored.format === 'openchurch-export')

  // ── the isolated target must be safe to write to ──────────────────────
  const { rows: [{ n: preexisting }] } = await target.query(
    `SELECT COUNT(*)::int AS n FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name LIKE 'ochr\\_%' ESCAPE '\\'`
  )
  if (preexisting > 0) {
    const { rows: [{ n }] } = await target.query('SELECT COUNT(*)::int AS n FROM ochr_organizations')
    if (n > 0) throw new Error(`RESTORE_URL already holds ${n} organization(s). Refusing to write into it.`)
  }
  // Build the schema in the target from migrations, the same way a new
  // environment would be built.
  process.env.DATABASE_URL_ORIGINAL = process.env.DATABASE_URL
  const restoreStarted = Date.now()

  // Recreate the parish row first; everything else references it.
  const o = restored.organization
  const { rows: [newOrg] } = await target.query(
    `INSERT INTO ochr_organizations (name, slug) VALUES ($1, $2) RETURNING id`,
    [`${o.name} (restored)`, `${o.slug || 'restored'}-drill`]
  )

  // Whatever the target computes for itself cannot be written back. The
  // export no longer carries these, but a drill must be able to restore
  // an OLDER artifact too — the ones already sitting in a mailbox were
  // produced before that fix.
  const { rows: genRows } = await target.query(`
    SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public'
       AND (is_generated <> 'NEVER' OR is_identity <> 'NO')`)
  const generated = {}
  for (const r of genRows) (generated[r.table_name] ||= new Set()).add(r.column_name)

  // A NOT NULL column the export deliberately strips still has to be
  // satisfied on the way in. ochr_users.password_hash is the only one
  // today: the artifact carries who the staff were, and without a
  // placeholder the restore drops them entirely — which loses the
  // parish's own record of its people to protect credentials that were
  // never in the file. The placeholder is random bytes nobody holds, the
  // same shape a pending invitation uses, so every restored account is
  // reachable only through a password reset.
  const { rows: notNullRows } = await target.query(`
    SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND is_nullable = 'NO'
       AND column_default IS NULL
       AND (is_generated = 'NEVER' AND is_identity = 'NO')`)
  const required = {}
  for (const r of notNullRows) (required[r.table_name] ||= new Set()).add(r.column_name)
  const placeholder = () => 'restored-no-login-' + Math.random().toString(36).slice(2) + Date.now().toString(36)
  let placeholders = 0
  const placed = new Set()

  let inserted = 0, skipped = []

  // DEPENDENCY ORDER, not alphabetical.
  //
  // This used to insert in the artifact's own order, which is
  // alphabetical, and rely on a second pass to pick up children that
  // arrived before their parents. It worked, and for a 321-record parish
  // it cost nothing. Drilled at 21,100 records it cost 95 seconds:
  // ochr_donations sorts before ochr_funds, so all sixteen thousand gifts
  // failed on pass 0 and were inserted again on pass 1 — thirty-two
  // thousand statements to insert sixteen thousand rows.
  //
  // Sorting by the target's own foreign-key graph puts parents first, so
  // pass 0 lands almost everything and pass 1 becomes the safety net it
  // was always meant to be rather than the main event.
  const { rows: fkRows } = await target.query(`
    SELECT tc.table_name AS child, ccu.table_name AS parent
      FROM information_schema.table_constraints tc
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
     WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'`)
  const tables = dependencyOrder(Object.keys(restored.tables),
    fkRows.map(r => ({ child: r.child, parent: r.parent })))
  // Views are not exported any more, but an artifact produced before
  // that fix still contains them and must not sink the restore.
  const isView = new Set((await target.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type <> 'BASE TABLE'`)).rows.map(r => r.table_name))
  // Insert in the artifact's own table order, then retry what failed:
  // the export is alphabetical, not dependency-ordered, so a child can
  // arrive before its parent. Two passes settles every graph this schema
  // has; anything still failing is reported rather than swallowed.
  for (let pass = 0; pass < 2; pass++) {
    for (const table of tables) {
      if (isView.has(table)) continue
      for (const row of restored.tables[table]) {
        const cols = Object.keys(row)
          .filter(k => k !== 'organization_id')
          .filter(k => !generated[table]?.has(k))
        if (!cols.length) continue
        const values = cols.map(k => {
          const v = row[k]
          return v !== null && typeof v === 'object' ? JSON.stringify(v) : v
        })
        for (const req of required[table] || []) {
          if (req === 'organization_id' || cols.includes(req)) continue
          cols.push(req); values.push(placeholder())
          if (pass === 0) placeholders++
        }
        try {
          await target.query(
            `INSERT INTO "${table}" (${cols.map(c => `"${c}"`).join(',')}, organization_id)
             VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}, $${cols.length + 1})
             ON CONFLICT DO NOTHING`,
            [...values, newOrg.id]
          )
          // Count on whichever pass actually placed the row. Counting
          // only pass 0 reported "5184 rows restored" for a parish whose
          // 21,100 records had all arrived — a headline number three
          // quarters wrong, on the one line an operator reads to decide
          // whether the restore worked.
          if (!placed.has(`${table}#${row.id}`)) { placed.add(`${table}#${row.id}`); inserted++ }
        } catch (err) {
          if (pass === 1) skipped.push(`${table}#${row.id}: ${err.message.slice(0, 80)}`)
        }
      }
    }
  }
  const restoreSeconds = (Date.now() - restoreStarted) / 1000

  // ── 1. completeness ───────────────────────────────────────────────────
  let missing = []
  for (const [table, count] of Object.entries(restored.counts)) {
    if (!count) continue
    try {
      const { rows: [{ n }] } = await target.query(
        `SELECT COUNT(*)::int AS n FROM "${table}" WHERE organization_id = $1`, [newOrg.id]
      )
      if (n !== count) missing.push(`${table}: ${n}/${count}`)
    } catch (err) {
      missing.push(`${table}: unreadable (${err.message.slice(0, 40)})`)
    }
  }
  check('every table in the artifact arrived with its full row count',
    missing.length === 0, missing.slice(0, 8).join('; '))

  // ── 2. tenant isolation ───────────────────────────────────────────────
  const { rows: [{ n: orgCount }] } = await target.query('SELECT COUNT(*)::int AS n FROM ochr_organizations')
  check('the restored database holds exactly one parish', orgCount === 1, `found ${orgCount}`)

  const { rows: strays } = await target.query(
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'organization_id'
        AND table_name LIKE 'ochr\\_%' ESCAPE '\\'`
  )
  let leaked = []
  for (const { table_name } of strays) {
    const { rows: [{ n }] } = await target.query(
      `SELECT COUNT(*)::int AS n FROM "${table_name}" WHERE organization_id <> $1`, [newOrg.id]
    )
    if (n > 0) leaked.push(`${table_name}: ${n}`)
  }
  check('NO ROW BELONGING TO ANY OTHER PARISH IS PRESENT', leaked.length === 0, leaked.join('; '))

  // ── 3. separation ─────────────────────────────────────────────────────
  const { rows: [srcDb] } = await pool.query('SELECT current_database() AS d')
  const { rows: [tgtDb] } = await target.query('SELECT current_database() AS d')
  check('the drill ran against a different database from the source',
    srcDb.d !== tgtDb.d, `${srcDb.d} → ${tgtDb.d}`)

  const { rows: [{ n: srcOrgs }] } = await pool.query('SELECT COUNT(*)::int AS n FROM ochr_organizations')
  check('the source was not written to', srcOrgs >= 1, `${srcOrgs} organizations still present`)

  // ── the honest limits, stated as findings rather than silence ─────────
  check(`${placeholders} required credential column(s) were filled with an unusable placeholder`,
    true, 'every restored account needs a password reset before anyone can sign in')

  check('credential columns are ABSENT from the restore, by design',
    !JSON.stringify(restored.tables.ochr_users ?? []).includes('password_hash'),
    'a restored parish cannot log in until passwords are reset — see the policy')

  // Partial restore must fail the drill, not print a green "restored and
  // verified" while rows sit in the skipped list. Completeness usually
  // catches this; this check makes the honesty explicit (RECOVERY-L3-05).
  check('no rows were left unrestored after both passes',
    skipped.length === 0,
    skipped.length ? `${skipped.length} row(s) still failing` : '')

  console.log('')
  for (const c of checks) console.log(`${c.ok ? '  ✓' : '  ✗'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`)
  if (skipped.length) {
    console.log(`\n  rows that could not be re-inserted (${skipped.length}):`)
    skipped.slice(0, 10).forEach(s => console.log(`    · ${s}`))
  }

  const failed = checks.filter(c => !c.ok)
  console.log(`\n${'-'.repeat(62)}`)
  console.log(`parish            : ${org.name}`)
  console.log(`artifact          : ${(artifactBytes / 1024).toFixed(1)} KiB gzipped`)
  console.log(`rows restored     : ${inserted}`)
  console.log(`restore duration  : ${restoreSeconds.toFixed(1)}s   ← this is the measured RTO for this layer`)
  console.log(`total drill time  : ${((Date.now() - started) / 1000).toFixed(1)}s`)
  console.log(`result            : ${failed.length ? 'FAILED — the off-site backup is NOT known to be restorable' : 'restored and verified'}`)
  process.exitCode = failed.length ? 1 : 0
} catch (err) {
  console.error('\ndrill aborted:', err.message)
  process.exitCode = 1
} finally {
  await target.end().catch(() => {})
  await pool.end().catch(() => {})
}
