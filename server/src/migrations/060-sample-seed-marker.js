// 060 — Sample-seed marker: make "clear sample data" permanent.
//
// THE BUG THIS FIXES
//
// runAllMigrations() calls seedSampleData() for the demo org on every run,
// deliberately un-ledgered (see migrations/index.js) because the seed was
// believed to be self-guarding. Its guard was:
//
//   SELECT 1 FROM ochr_tasks WHERE organization_id = $1 AND title LIKE '[Sample]%'
//
// That guard asks "are sample TASKS present right now?" — not "has this org
// ever been seeded?". Two consequences, both of which land on production
// every time CI runs `node server/src/migrate-cli.js` after a push to main:
//
//   1. REVERT. An admin clears sample data (POST /api/onboarding/clear-samples
//      deletes every '[Sample]%' row). The next deploy sees no sample tasks,
//      decides the org is unseeded, and re-inserts all 12 sample members,
//      4 events, an 8-week recurring Sunday service, 9 donations, 2 payroll
//      staff and 5 tasks. The admin's cleanup is undone on every deploy.
//
//   2. DUPLICATION. If only the sample *tasks* are deleted (e.g. tidying the
//      Tasks page) while other sample rows remain, the guard also reads
//      "unseeded" — so the next deploy appends a SECOND full copy of the
//      members, donations and schedule. Deploy again, a third. Donation
//      totals and giving reports inflate with each deploy.
//
// THE FIX
//
// Move the guard from "is sample data present" to "has this org ever been
// seeded", recorded on the org itself. Clearing samples does not reset the
// marker, so cleared data stays cleared.
//
// BACKFILL — and why it must NOT run on a fresh database.
//
// On a database with history, every organization that already exists has had
// its one shot at seeding, via signup (routes/auth.js) or an earlier boot.
// Stamping them all as seeded is what actually stops the resurrection on the
// next deploy: leaving any of them NULL would let the old behavior fire
// exactly one more time. Note this has to happen here, in a ledgered
// migration — production already carries a migration ledger, so the
// "adopting an existing database" branch in migrations/index.js never fires
// there and can't be used to hang this off.
//
// On a FRESH database (CI, a new dev machine, a new tenant DB) the story
// inverts. The `base` migration creates the Demo Church org moments earlier
// in this same run, and the sample seed at the end of runAllMigrations() has
// not happened yet. A blanket backfill would stamp that brand-new demo org
// as "already seeded" and permanently suppress the sample data every fresh
// install is supposed to come with — the empty Dashboard the README promises
// won't be empty. So runAllMigrations() passes { freshDatabase } (derived
// from the same to_regclass probe it already runs) and we skip the backfill
// in that case; nothing exists yet that needs protecting.
//
// Idempotent: ADD COLUMN IF NOT EXISTS, and the backfill only touches rows
// still NULL.

import pool from '../db.js'

export async function up(ctx = {}) {
  console.log('Migration 060: sample-seed-marker — applying...')

  await pool.query(`
    ALTER TABLE ochr_organizations
      ADD COLUMN IF NOT EXISTS samples_seeded_at TIMESTAMPTZ
  `)

  if (ctx.freshDatabase) {
    console.log('Migration 060: fresh database — no backfill; the demo org still gets its sample data')
    console.log('Migration 060: sample-seed-marker — applied.')
    return
  }

  // Backfill: treat every pre-existing org as already seeded. created_at is
  // the honest timestamp for "this org's seeding window has closed" — it's
  // when signup ran, which is when the seed did (or didn't) happen.
  const { rowCount } = await pool.query(`
    UPDATE ochr_organizations
       SET samples_seeded_at = COALESCE(created_at, NOW())
     WHERE samples_seeded_at IS NULL
  `)
  console.log(`Migration 060: marked ${rowCount} existing org(s) as already seeded`)

  console.log('Migration 060: sample-seed-marker — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
