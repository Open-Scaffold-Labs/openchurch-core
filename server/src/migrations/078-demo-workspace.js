// A demo workspace says so (PILOT.4).
//
// Demo orgs were marked by having "(Demo)" in their name. That is a naming
// convention, not a flag: it is invisible in a screenshot that crops the
// header, it disappears the moment somebody renames the org to a real
// parish for a demonstration — which the run-sheet explicitly tells them to
// do — and nothing in the API can act on it.
//
// The risk is not embarrassment. It is fictional pastoral notes about
// fictional parishes being mistaken for real ones, or worse, real ones
// being taken for demo data and treated carelessly.
//
// One boolean, set by the seed and by nothing else. Production onboarding
// never sets it, so the default is the safe answer.

import pool from '../db.js'

export async function up() {
  console.log('Migration 078: demo workspace flag — applying...')

  await pool.query(`
    ALTER TABLE ochr_organizations
      ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE
  `)

  // Backfill the existing convention exactly once, so demo orgs created
  // before the flag existed are still labelled. Matching on the name is
  // precisely the fragile thing this replaces — it is acceptable as a
  // one-off migration and nowhere else.
  const { rowCount } = await pool.query(`
    UPDATE ochr_organizations SET is_demo = TRUE
     WHERE is_demo = FALSE
       AND (name ILIKE '%(demo)%' OR slug LIKE '%-demo' OR slug LIKE 'demo-%')
  `)
  console.log(`  ✓ ${rowCount} existing demo workspace(s) flagged`)

  console.log('Migration 078: demo workspace flag — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
