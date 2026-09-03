// Which migration is actually applied — asked in exactly one place.
//
// There are two callers with two different jobs, and until now they had two
// different implementations. /api/health REPORTS the applied migration;
// release/log.js DECIDES with it — it stamps every release row and the
// rollback tool reads that stamp to choose what to roll back to.
//
// The reporting one was fixed when production turned out to be carrying a
// `999-race-sim` row that no commit contains. The deciding one was not, and
// kept answering '999-race-sim' — so the tool that exists to recover from a
// bad deploy was reading a sentinel as production's schema. Two copies of a
// bounded query would have left the same gap open for the next reader, so
// there is now one function and no copies.
//
// The bound is the list of names THIS BUILD ships:
//
//   - An unknown row is not a candidate, so nothing outside the chain can
//     outrank the head however it sorts.
//   - 'base' is excluded from the candidate list, and array_position would
//     rank it lowest anyway — it is first in the chain. Belt and braces, so
//     a future move away from zero-padded three-digit names cannot silently
//     reorder the series.
//
// Leaf-ish on purpose: this imports names.js and the pool, never
// migrations/index.js, which pulls in ninety-odd modules. app.js is what the
// Vercel serverless entry loads, and a health check must not drag the whole
// chain into every cold start.

import pool from '../db.js'
import { NUMBERED_MIGRATION_NAMES } from './names.js'

// The applied head of the chain, or null if none of this build's migrations
// are in the ledger. Throws only if the query itself fails — callers decide
// whether that is fatal (the health handler reports a degraded db) or
// swallowed (the release log is bookkeeping and must never break a boot).
export async function appliedMigration() {
  const { rows } = await pool.query(
    `SELECT name FROM ochr_schema_migrations
      WHERE name = ANY($1::text[])
      ORDER BY array_position($1::text[], name) DESC
      LIMIT 1`,
    [NUMBERED_MIGRATION_NAMES]
  )
  return rows[0]?.name ?? null
}
