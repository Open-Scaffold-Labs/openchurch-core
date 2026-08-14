// ochr_organizations — public church-page content
//
// Anchor 5 / A5.1 — the editable public homepage at /p/:slug. We keep
// the content on the org row itself (one homepage per church, fixed
// section order) rather than a separate ochr_pages table: there's no
// many-pages-per-org or block-reordering requirement in v1, so a flat
// set of columns is the lighter model and keeps the admin settings
// form a plain PATCH.
//
// Columns:
//   page_published — gate. The public endpoint 404s until this is
//                    TRUE, so a half-written page never leaks.
//   tagline        — hero welcome line under the church name.
//   about          — longer welcome / mission section (multi-line).
//   service_times  — free text, one service per line (e.g.
//                    "Sundays · 9am & 11am"). Free text, not a
//                    structured table, because service schedules are
//                    irregular (seasonal, bilingual, feast days) and a
//                    rigid shape would fight the admin more than help.
//
// Location reuses the existing ochr_organizations.address column from
// migration 012 (letterhead) — same physical address, no duplication.

import pool from '../db.js'

export async function up() {
  console.log('Migration 023: church-page — applying...')

  await pool.query(`
    ALTER TABLE ochr_organizations
      ADD COLUMN IF NOT EXISTS page_published BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS tagline        TEXT,
      ADD COLUMN IF NOT EXISTS about          TEXT,
      ADD COLUMN IF NOT EXISTS service_times  TEXT
  `)

  console.log('Migration 023: church-page — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
