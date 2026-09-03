// Recording what is actually running, from the thing that is running it.
//
// Called from two places, on purpose:
//
//   index.js, after runAllMigrations() — the long-lived server. The table
//     is guaranteed to exist by then, which is why it is called there and
//     not at import time.
//
//   the health handler, once per process — Vercel's serverless path,
//     which never calls runAllMigrations(). A cold start that serves one
//     health check is still a release that ran, and it belongs in the log.
//
// EVERY FAILURE HERE IS SWALLOWED. This is bookkeeping about deploys; it
// must never be the reason a deploy does not boot or a health check
// answers 503. A release log that can take the site down is worse than no
// release log, and its failure mode would arrive at the worst moment: the
// first boot after a schema change, which is exactly when you need the
// site up.
//
// `recorded` is per-process, so a warm serverless container writes once
// rather than on every request. A new container writes again, which is
// correct — it bumps last_seen_at and the boot count on the same row.

import pool from '../db.js'
import { appliedMigration } from '../migrations/applied.js'

// How this build names itself. `commit` is whatever the platform put in
// the environment — Vercel sets VERCEL_GIT_COMMIT_SHA on every build.
// When nothing set it, this reports the string 'unknown' rather than
// omitting the field or inventing a value: a build that cannot say what
// it is must say so, and the rollback tool refuses an 'unknown' target
// rather than aiming at a commit nobody can name.
//
// Nothing here is a secret: the commit is public (the snapshot repo is
// public), the environment name is not sensitive, and the migration name
// is already in the repository.
export function releaseInfo() {
  const commit =
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.GIT_COMMIT_SHA ||
    process.env.SOURCE_COMMIT ||
    ''
  return {
    commit: commit ? commit.slice(0, 40) : 'unknown',
    commit_short: commit ? commit.slice(0, 7) : 'unknown',
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'unknown',
  }
}

let recorded = false

export function _resetForTests() { recorded = false }

// What this build believes is applied. Delegates to the one reader in
// migrations/applied.js — see that file for why the query is bounded.
//
// This used to be `WHERE name ~ '^[0-9]' ORDER BY name DESC LIMIT 1`, which
// production's `999-race-sim` row matched and outranked. That value was
// stamped into the (commit, environment, migration) key of every release row
// written while the row sat there, and scripts/release-rollback.mjs reads it
// to name what production is running. The health endpoint's copy of this bug
// was fixed on its own; this one was not, because the fix went where the bug
// was found rather than where the class lived.
export async function currentMigration() {
  return appliedMigration()
}

export async function recordRelease(info, { force = false } = {}) {
  if (recorded && !force) return { skipped: true }
  recorded = true
  try {
    const migration = await currentMigration()
    // ON CONFLICT on the (commit, environment, migration) triple: the same
    // code against the same schema is ONE release however many times it
    // boots. A new migration under the same commit is a NEW row, because
    // it is a different state of the system and therefore a different
    // thing to roll back to.
    const { rows } = await pool.query(
      `INSERT INTO ochr_release_log (commit, commit_short, environment, migration)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (commit, environment, migration)
       DO UPDATE SET last_seen_at = NOW(), boots = ochr_release_log.boots + 1
       RETURNING id, commit_short, migration, first_seen_at, boots`,
      [info.commit, info.commit_short, info.environment, migration]
    )
    return { recorded: rows[0] }
  } catch (err) {
    // Deliberately not monitor.error: on the very first boot after this
    // migration ships, the table may not exist for a few hundred
    // milliseconds, and paging somebody about that would be noise.
    return { failed: String(err?.message ?? err) }
  }
}

// What the rollback tool reads. Newest first, and only for ONE
// environment — a preview release is not a rollback target for
// production, and putting them in the same list is how somebody picks the
// wrong one at speed.
export async function releaseHistory(environment, limit = 20) {
  const { rows } = await pool.query(
    `SELECT commit, commit_short, environment, migration,
            first_seen_at, last_seen_at, boots
       FROM ochr_release_log
      WHERE environment = $1
      ORDER BY last_seen_at DESC
      LIMIT $2`,
    [environment, limit]
  )
  return rows
}
