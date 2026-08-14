// Per-org AI usage counter. One row per successful AI call to either
// /api/ai/generate or /api/ai/enhance. Used to gate against the per-
// plan ai_generations_per_month limit declared in billing/plans.js.
//
// Rationale for a separate table (vs counting from ochr_ai_generations):
//   - ochr_ai_generations only logs /generate; we need /enhance too.
//   - quota semantics shouldn't ride on the history table — that table
//     could be truncated for privacy/storage without affecting billing.
//   - clean migration path if we ever add token-cost weighting per row.
//
// Idempotent — IF NOT EXISTS lets re-runs no-op on dev boots.

import pool from '../db.js'

export async function up() {
  console.log('Migration 006: ai-usage — applying...')

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_ai_usage (
      id              SERIAL PRIMARY KEY,
      organization_id INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      endpoint        TEXT NOT NULL,                                       -- 'generate' | 'enhance'
      type            TEXT,                                                -- generate type; null for enhance
      user_id         INTEGER REFERENCES ochr_users(id) ON DELETE SET NULL,
      provider        TEXT,
      model           TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `)

  // The hot path is "how many calls has this org made since
  // date_trunc('month', NOW())?" — DESC so the planner can stop early
  // for the count-since-X queries.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ai_usage_org_created
      ON ochr_ai_usage(organization_id, created_at DESC)
  `)

  console.log('Migration 006: ai-usage — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
