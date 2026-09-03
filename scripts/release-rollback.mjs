#!/usr/bin/env node
// The way back.
//
// There was no rollback path. If a deploy broke a parish on a Sunday
// morning, the only move was a forward fix written under pressure by
// whoever was awake — which is how a small bug becomes a long outage.
//
// WHAT A ROLLBACK ACTUALLY IS HERE. On Vercel it is a code-only
// operation: promote a previous deployment. The database does not go
// back, and it must not — reversing migrations on live parish data is a
// far more dangerous act than the bug you are running from. So the real
// question this tool answers is not "can I promote that build", which is
// always yes. It is:
//
//     CAN THAT OLD CODE SURVIVE TODAY'S SCHEMA?
//
// Usually yes, because every migration in this repository is additive.
// That is not luck and it is not permanent, which is why this checks
// rather than assumes. Old code meets a newer schema and breaks on
// exactly five things:
//
//   a dropped table or column       — old code SELECTs something gone
//   a renamed table or column       — same, wearing a disguise
//   a changed column type           — old writes no longer fit
//   a new NOT NULL without DEFAULT  — old INSERTs omit it and fail
//   a new CHECK on an existing table— old writes are now rejected
//
// Everything else — new tables, new nullable columns, new indexes, new
// constraints on tables created in the same migration — is invisible to
// old code. So the check scans the migrations that landed between the
// target and now, classifies them, and REFUSES when it finds one of the
// five. A tool that always says yes is a tool nobody should trust at 9pm.
//
//   node --env-file=server/.env scripts/release-rollback.mjs
//   node --env-file=server/.env scripts/release-rollback.mjs --to <commit>
//
// It never deploys anything. It tells you what is safe and prints the
// command; a human runs it. Rolling a live parish back is not something
// a script should do because it was invoked.

import pool from '../server/src/db.js'
import { releaseHistory, currentMigration, releaseInfo } from '../server/src/release/log.js'
import { classifyFile, migrationsAfter } from './rollback-classify.mjs'

const bold = s => `\x1b[1m${s}\x1b[0m`
const red = s => `\x1b[31m${s}\x1b[0m`
const yellow = s => `\x1b[33m${s}\x1b[0m`
const green = s => `\x1b[32m${s}\x1b[0m`

// ── report ───────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2)
  const wanted = args.includes('--to') ? args[args.indexOf('--to') + 1] : null
  const env = process.env.VERCEL_ENV || process.env.NODE_ENV || 'unknown'

  const now = releaseInfo()
  const migration = await currentMigration()
  console.log(bold('\nRunning now'))
  console.log(`  commit     ${now.commit_short}`)
  console.log(`  schema     ${migration ?? 'unknown'}`)
  console.log(`  environment ${env}`)

  const history = await releaseHistory(env, 20)
  const candidates = history.filter(r => r.commit !== now.commit && r.commit !== 'unknown')

  if (!candidates.length) {
    console.log(yellow(`\nNo previous release recorded for "${env}".`))
    console.log(`The log fills itself as the app boots, so this is expected until a
second release has run. Until then there is no verified target, and this
tool will not invent one — check Vercel's deployment list by hand and read
docs/RELEASE-ROLLBACK.md before promoting anything.`)
    return 0
  }

  const target = wanted
    ? candidates.find(r => r.commit.startsWith(wanted) || r.commit_short === wanted)
    : candidates[0]

  if (!target) {
    console.log(red(`\nNo recorded release matches "${wanted}" in "${env}".`))
    console.log('Recorded:', candidates.map(c => c.commit_short).join(', '))
    return 1
  }

  console.log(bold('\nRolling back to'))
  console.log(`  commit     ${target.commit_short}  (${target.commit})`)
  console.log(`  ran        ${new Date(target.first_seen_at).toISOString().slice(0, 16).replace('T', ' ')} → ${new Date(target.last_seen_at).toISOString().slice(0, 16).replace('T', ' ')} UTC, ${target.boots} boot(s)`)
  console.log(`  its schema ${target.migration ?? 'unknown'}`)

  const between = migrationsAfter(target.migration, migration)
  console.log(bold(`\nSchema changes since (${between.length})`))
  if (!between.length) console.log('  none — the schema has not moved')

  const blocked = [], warned = []
  for (const f of between) {
    const c = classifyFile(f)
    if (c.reasons.length) blocked.push(c)
    else if (c.warnings.length) warned.push(c)
    const mark = c.reasons.length ? red('BLOCKS') : c.warnings.length ? yellow('check ') : green('safe  ')
    console.log(`  ${mark} ${f}`)
    for (const r of c.reasons)  console.log(`         ${red('↳ ' + r)}`)
    for (const w of c.warnings) console.log(`         ${yellow('↳ ' + w)}`)
  }

  if (blocked.length) {
    console.log(red(bold('\nREFUSING: this rollback would put old code against a schema it cannot read.')))
    console.log(`
${blocked.length} migration(s) changed the shape of data that already existed.
Promoting ${target.commit_short} would not restore the old behaviour; it would
produce a NEW failure, on top of the one you are running from, in code
nobody is looking at.

What to do instead is in docs/RELEASE-ROLLBACK.md — in short: roll forward
with a targeted fix, or pick a target AFTER the blocking migration.`)
    return 2
  }

  if (warned.length) {
    console.log(yellow(bold('\nProbably safe, with something to read first.')))
    console.log('The migrations marked "check" did something a regex cannot decide —')
    console.log('rewrote a view, or replaced a constraint. Open those files and confirm')
    console.log('the change is a widening before you promote. It usually is.')
  } else {
    console.log(green(bold('\nSafe: every schema change since is additive.')))
    console.log('Old code cannot see a new table, a new nullable column or a new index,')
    console.log('so promoting this build restores the previous behaviour exactly.')
  }

  console.log(bold('\nRun this yourself'))
  console.log(`  vercel promote ${target.commit_short}    # or promote the matching deployment in the dashboard`)
  console.log(`\nThen confirm what is actually serving:`)
  console.log(`  curl -s https://<your-domain>/api/health | jq '{commit_short, migration, status}'`)
  console.log(`\nExpect commit_short ${target.commit_short} and schema ${migration}. If health still`)
  console.log(`reports ${now.commit_short}, the promotion did not take effect — do not assume it did.\n`)
  return 0
}

main()
  .then(code => pool.end().then(() => process.exit(code)))
  .catch(err => { console.error(err); pool.end().then(() => process.exit(1)) })
