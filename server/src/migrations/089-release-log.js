// 089 — the release log, which writes itself.
//
// THE PROBLEM THIS SOLVES IS NOT "WHAT IS RUNNING". /health already
// answers that: commit, commit_short, environment and the highest applied
// migration. The problem is "what was running BEFORE", which is the only
// question that matters at the moment you need to go back — and nothing
// recorded it. A rollback whose target you have to reconstruct from
// memory, at 9pm, while a parish cannot take a payment, is not a rollback
// path. It is a guess with a deploy button.
//
// NO CI HOOK. The obvious design is for the deploy pipeline to POST a
// release record, and the obvious design is wrong here: it puts the
// record in the hands of the thing most likely to be broken, and it stops
// working the moment somebody deploys by hand or promotes a build from
// the Vercel dashboard. The app records ITSELF instead — on boot it says
// "I am commit X, running against migration Y, and I have been up since
// T". That is derived from the process actually serving traffic, so it
// cannot describe a deploy that never happened, and it keeps working no
// matter how the deploy was triggered.
//
// THE KEY IS (commit, environment, migration), NOT commit ALONE. Code and
// schema move independently: the same build runs before and after a
// migration lands, and those are two different states of the system. A
// rollback target is a PAIR — this code against that schema — because the
// pair is what was known to work. Recording only the commit would offer
// you a target that never actually ran in the shape you are rolling back
// to.
//
// NOT tenant-scoped, deliberately. A release is a fact about the
// deployment, not about any parish, and giving it an organization_id
// would invite a per-parish reading of something that is global.
// ochr_schema_migrations is global for the same reason.

import pool from '../db.js'

export async function up() {
  console.log('Migration 089: release log — applying...')

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_release_log (
      id            SERIAL PRIMARY KEY,
      commit        TEXT NOT NULL,
      commit_short  TEXT NOT NULL,
      environment   TEXT NOT NULL,
      migration     TEXT,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      boots         INTEGER NOT NULL DEFAULT 1,
      UNIQUE (commit, environment, migration)
    )
  `)

  // The tool reads "most recent first, for this environment". One index,
  // matching that.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ochr_release_log_recent
      ON ochr_release_log(environment, last_seen_at DESC)
  `)

  // RLS in the same up() that creates the table — the convention since
  // 041. The 080 sweep runs BEFORE this migration and cannot cover it.
  await pool.query(`ALTER TABLE ochr_release_log ENABLE ROW LEVEL SECURITY`)

  console.log('Migration 089: release log — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
