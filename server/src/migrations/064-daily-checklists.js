// 064 — Daily operational checklists (OPS.1).
//
// "Opening the church", "Sunday sacristy prep", "Lock-up" — the routine
// lists a parish runs every day, modeled the way sacristans actually use
// them: a TEMPLATE (what the routine is) and a RUN (today's copy, ticked
// off item by item). Runs snapshot the template's title and items, so
// editing a template never rewrites history — yesterday's completed
// checklist stays exactly as it was completed.
//
//   items (template) — JSONB array of strings.
//   items (run)      — JSONB array of { text, done }.
//   UNIQUE(template_id, run_date) — one run per template per day; the
//     lazy creator (GET /api/checklists/today) upserts with DO NOTHING
//     so concurrent morning page-loads can't double-create.

import pool from '../db.js'

export async function up() {
  console.log('Migration 064: daily-checklists — applying...')

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_checklist_templates (
      id               BIGSERIAL PRIMARY KEY,
      organization_id  INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      title            TEXT NOT NULL,
      items            JSONB NOT NULL DEFAULT '[]',
      active           BOOLEAN NOT NULL DEFAULT true,
      sort_order       INTEGER NOT NULL DEFAULT 0,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_checklist_templates_org ON ochr_checklist_templates(organization_id, active)`)
  await pool.query(`ALTER TABLE ochr_checklist_templates ENABLE ROW LEVEL SECURITY`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_checklist_runs (
      id               BIGSERIAL PRIMARY KEY,
      organization_id  INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      template_id      BIGINT NOT NULL REFERENCES ochr_checklist_templates(id) ON DELETE CASCADE,
      run_date         DATE NOT NULL,
      title            TEXT NOT NULL,
      items            JSONB NOT NULL DEFAULT '[]',
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (template_id, run_date)
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_checklist_runs_org_date ON ochr_checklist_runs(organization_id, run_date DESC)`)
  await pool.query(`ALTER TABLE ochr_checklist_runs ENABLE ROW LEVEL SECURITY`)

  console.log('Migration 064: daily-checklists — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up().then(() => process.exit(0)).catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
