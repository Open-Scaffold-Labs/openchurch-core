#!/usr/bin/env node
// Does the off-site restore still work for a parish that is not tiny?
//
// docs/RECOVERY-POLICY.md has carried this line since the layer-2 drill
// first passed:
//
//     "The measured RTO is for a 320-record parish. A parish fifty times
//      larger has never been restored."
//
// That is an honest gap and it stayed open because measuring it needs a
// parish nobody has. So this builds one — a cathedral-sized parish with
// eight years of giving behind it — restores it, and replaces the
// sentence with a number.
//
//   DATABASE_URL=<local source>  RESTORE_URL=<local, empty> \
//     node scripts/scale-drill.mjs [--members 3000] [--keep]
//
// IT REFUSES TO RUN AGAINST ANYTHING BUT LOCALHOST, on both URLs. This
// script INSERTS TENS OF THOUSANDS OF ROWS and then deletes the parish it
// made; pointed at production that is not a drill, it is an incident. The
// same guard the patch script grew for the same reason.
//
// The seeded parish is removed at the end unless --keep. The removal is
// a plain cascade delete of one organisation, which is also a small
// second proof: a parish can be taken out cleanly.

import { spawnSync } from 'node:child_process'
import pool from '../server/src/db.js'

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 ? Number(process.argv[i + 1]) : dflt
}
const MEMBERS = arg('members', 3000)
const KEEP = process.argv.includes('--keep')

// ── the guard ────────────────────────────────────────────────────────────
const localOnly = (url, label) => {
  if (!url) { console.error(`${label} is required.`); process.exit(2) }
  const ok = /^postgres(ql)?:\/\/[^/]*@(localhost|127\.0\.0\.1):\d+/i.test(url)
  if (!ok) {
    console.error(`REFUSING: ${label} does not point at a TCP localhost database.`)
    console.error(`  host: ${String(url).replace(/.*@([^:/?]+).*/, '$1')}`)
    console.error('  This script inserts tens of thousands of rows and then deletes')
    console.error('  a parish. Against production that is an incident, not a drill.')
    process.exit(2)
  }
}
localOnly(process.env.DATABASE_URL, 'DATABASE_URL')
localOnly(process.env.RESTORE_URL, 'RESTORE_URL')
if (process.env.RESTORE_URL === process.env.DATABASE_URL) {
  console.error('RESTORE_URL is the same database as DATABASE_URL. Refusing.')
  process.exit(2)
}

const ms = t => `${(t / 1000).toFixed(2)}s`
const started = Date.now()

// ── build a parish nobody has ────────────────────────────────────────────
// Proportions from a large, long-established parish rather than a round
// number: most members give occasionally, a minority give most weeks, and
// the register goes back further than the giving records do.
async function seed() {
  const slug = `scale-drill-${Date.now()}`
  const { rows: [org] } = await pool.query(
    `INSERT INTO ochr_organizations (name, slug, org_type, tradition)
     VALUES ('[Scale drill] Cathedral of St Anne', $1, 'parish', 'episcopal') RETURNING id`, [slug])
  const id = org.id

  await pool.query(
    `INSERT INTO ochr_funds (organization_id, name)
     SELECT $1, 'Fund ' || g FROM generate_series(1, 24) g`, [id])

  await pool.query(
    `INSERT INTO ochr_clients (organization_id, name, email, status)
     SELECT $1,
            'Member ' || g || ' ' || (ARRAY['Gómez','O''Brien','Nguyễn','Okafor','Смирнов'])[1 + (g % 5)],
            'member' || g || '@example.org',
            (ARRAY['active','active','active','inactive'])[1 + (g % 4)]
       FROM generate_series(1, $2) g`, [id, MEMBERS])

  // Eight years of giving. A third of the parish gives regularly; the
  // rest appear a handful of times. That ratio is what makes the
  // donations table the biggest thing in the artifact, which is the
  // thing scale actually tests.
  await pool.query(
    `INSERT INTO ochr_donations (organization_id, donor_name, amount, date, fund_id, method)
     SELECT $1,
            c.name,
            round((10 + random() * 240)::numeric, 2),
            (CURRENT_DATE - ((random() * 2920)::int)),
            f.id,
            (ARRAY['cash','check','card','online'])[1 + (floor(random()*4))::int]
       FROM ochr_clients c
       JOIN LATERAL generate_series(1, CASE WHEN c.id % 3 = 0 THEN 12 ELSE 2 END) s ON true
       JOIN LATERAL (SELECT id FROM ochr_funds WHERE organization_id = $1 ORDER BY random() LIMIT 1) f ON true
      WHERE c.organization_id = $1`, [id])

  await pool.query(
    `INSERT INTO ochr_calendar_events (organization_id, title, date, start_time, end_time, type)
     SELECT $1, 'Service ' || g, CURRENT_DATE - (g % 900), '10:00', '11:30', 'service'
       FROM generate_series(1, 900) g`, [id])

  await pool.query(
    `INSERT INTO ochr_groups (organization_id, name, category)
     SELECT $1, 'Ministry ' || g, 'ministry' FROM generate_series(1, 60) g`, [id])

  await pool.query(
    `INSERT INTO ochr_sacramental_records (organization_id, type, member_name, date, minister, place)
     SELECT $1, (ARRAY['baptism','confirmation','marriage'])[1 + (g % 3)],
            'Register Person ' || g, CURRENT_DATE - (g * 11),
            'The Revd Canon Example', 'The Cathedral'
       FROM generate_series(1, 1200) g`, [id])

  return id
}

let orgId
try {
  console.log(`seeding a parish of ${MEMBERS.toLocaleString()} members…`)
  const tSeed = Date.now()
  orgId = await seed()
  const seedMs = Date.now() - tSeed

  const { rows: counts } = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM ochr_clients WHERE organization_id = $1) AS members,
       (SELECT COUNT(*)::int FROM ochr_donations WHERE organization_id = $1) AS gifts,
       (SELECT COUNT(*)::int FROM ochr_calendar_events WHERE organization_id = $1) AS events,
       (SELECT COUNT(*)::int FROM ochr_sacramental_records WHERE organization_id = $1) AS register`,
    [orgId])
  const c = counts[0]
  const totalRows = c.members + c.gifts + c.events + c.register
  console.log(`seeded in ${ms(seedMs)}: ${c.members.toLocaleString()} members, ${c.gifts.toLocaleString()} gifts, ${c.events} events, ${c.register.toLocaleString()} register entries`)

  // ── run the REAL drill against it ──────────────────────────────────────
  //
  // Not a reimplementation. The first version of this script had its own
  // restore loop, and it measured the wrong thing twice over: it inserted
  // in the artifact's order and died on foreign keys, and even fixed it
  // would have been timing MY batched INSERT rather than the procedure a
  // person actually runs at 9pm. offsite-restore-drill.mjs IS that
  // procedure — including the fact that it inserts one row at a time and
  // makes two passes to settle the dependency graph. If that is slow at
  // scale, slow is the finding.
  console.log(`\nrunning scripts/offsite-restore-drill.mjs against org ${orgId}…\n`)
  const tDrill = Date.now()
  const drill = spawnSync(process.execPath, ['scripts/offsite-restore-drill.mjs', '--org', String(orgId)], {
    env: { ...process.env },
    encoding: 'utf8',
    timeout: 30 * 60 * 1000,
  })
  const drillMs = Date.now() - tDrill
  process.stdout.write(drill.stdout || '')
  if (drill.stderr) process.stderr.write(drill.stderr)

  const ok = drill.status === 0
  console.log(`\n── RTO at scale, measured ──`)
  console.log(`  parish size       ${totalRows.toLocaleString()} records (${(totalRows / 321).toFixed(0)}× the 321-record drill)`)
  console.log(`  seeded in         ${ms(seedMs)}`)
  console.log(`  DRILL END TO END  ${ms(drillMs)}   (export + restore + verify)`)
  console.log(`  result            ${ok ? 'PASS' : 'FAIL'}`)
  if (!ok) process.exitCode = 1

} catch (err) {
  console.error('drill failed:', err.message)
  process.exitCode = 1
} finally {
  if (orgId && !KEEP) {
    await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [orgId])
    console.log(`\nseeded parish removed (id ${orgId}).`)
  }
  console.log(`total ${ms(Date.now() - started)}`)
  await pool.end()
}
