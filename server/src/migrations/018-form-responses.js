// Form responses (Sprint Forms / F.1).
//
// One row per submission against a form. answers is a JSONB map
// keyed by field.id — the route layer validates it against the
// form's stored fields[] at write time, so by the time a row lands
// here it's already shape-checked against the form definition that
// was live when the parishioner hit submit.
//
// respondent_name + respondent_email are first-class columns (not
// pulled from answers JSONB) because they're the two universal
// "who submitted this" handles every form has, and the response
// inbox sorts/filters on them. Pulling them out means no JSONB
// expression index for the common case.
//
// ip_address + user_agent are the abuse-investigation surface.
// Stored on every submit so an admin can spot a bot wave or a
// single bad actor without retroactively backfilling.
//
// ON DELETE CASCADE from form_id — deleting a form takes its
// responses with it. organization_id is also a hard reference for
// query convenience (response inbox filters by tenant without
// joining ochr_forms).

import pool from '../db.js'

export async function up() {
  console.log('Migration 018: form responses — applying...')

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_form_responses (
      id               SERIAL PRIMARY KEY,
      form_id          INTEGER NOT NULL REFERENCES ochr_forms(id)         ON DELETE CASCADE,
      organization_id  INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      answers          JSONB   NOT NULL DEFAULT '{}'::jsonb,
      respondent_name  TEXT,
      respondent_email TEXT,
      ip_address       TEXT,
      user_agent       TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  // Response inbox: list a form's responses newest-first. The
  // (form_id, created_at DESC) order matches the dominant query
  // and lets paginated reads use the index for ordering.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ochr_form_responses_form
      ON ochr_form_responses (form_id, created_at DESC)
  `)

  // Cross-form admin views (e.g., "all responses this week across
  // every form") — small but cheap.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ochr_form_responses_org
      ON ochr_form_responses (organization_id, created_at DESC)
  `)

  console.log('Migration 018: form responses — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
