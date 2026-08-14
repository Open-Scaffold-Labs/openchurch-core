// ochr_feedback_ledger.status (FB.2) — the workbench state column.
//
// Manual 4 promises every Inner Circle note a human reply inside 48
// hours; the workbench needs to know which notes are still waiting.
// Two states only — a feedback note is either open or replied. Any
// richer lifecycle (triage lanes, priorities) is exactly the kind of
// internal-tool gold-plating the freeze exists to prevent.

import pool from '../db.js'

export async function up() {
  console.log('Migration 053: feedback-status — applying...')

  await pool.query(`
    ALTER TABLE ochr_feedback_ledger
      ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'replied'))
  `)

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_feedback_status
      ON ochr_feedback_ledger(status) WHERE status = 'open'
  `)

  console.log('Migration 053: feedback-status — applied.')
}
