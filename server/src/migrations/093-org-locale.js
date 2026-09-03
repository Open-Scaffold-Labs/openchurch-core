// A parish can be Spanish. Until now only a browser could be.
//
// `ochr_clients.preferred_language` has existed since migration 001 — the
// commit calls it "bilingual-first-class" — and 1031 UI strings, 17
// notification templates, 56 server messages and all 8 certificate types are
// fully translated. None of it could be switched on for an organization,
// because the organization had nowhere to say so.
//
// The client resolved `override || user?.organization?.locale || 'en'`, and
// the middle term was permanently null: no column existed, and
// routes/auth.js:71 read `org.locale ?? null` — a line whose own comment
// said locale "is the parish default the i18n spine has always read for and
// never received." So the whole capability ran off a per-device localStorage
// key. A new secretary, a new device, a private window: English, until that
// person found the picker. The screen where you pick your language is itself
// untranslated, so the person who needs it most reads English to find it.
//
// 'en' is the DEFAULT rather than NULL. A nullable locale would make every
// reader decide what null means, and the readers would disagree — which is
// the shape of most of the bugs found in this codebase this month. Every
// organization has a language; for existing rows it is the one they have
// been getting.
//
// The CHECK is deliberately narrow. STRINGS ships 'en' and 'es'; a third
// locale is a real piece of work (templates, certificates, seeded account
// names) and should cost a migration rather than arriving as a typo in a
// settings form that silently renders English.

import pool from '../db.js'

export const SUPPORTED_LOCALES = ['en', 'es']

export async function up() {
  await pool.query(`
    ALTER TABLE ochr_organizations
      ADD COLUMN IF NOT EXISTS locale TEXT NOT NULL DEFAULT 'en'
  `)

  // Separate from ADD COLUMN so a re-run over a database that already has
  // the column still installs the constraint. IF NOT EXISTS is not available
  // for constraints, hence the catalogue check.
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ochr_organizations_locale_check'
      ) THEN
        ALTER TABLE ochr_organizations
          ADD CONSTRAINT ochr_organizations_locale_check
          CHECK (locale IN ('en', 'es'));
      END IF;
    END $$
  `)

  // Self-assertion, the same posture as 090: a migration that half-applies is
  // how a schema and its schema file come to disagree, and the disagreement
  // is invisible until something reads the column and gets nothing.
  const { rows } = await pool.query(`
    SELECT column_name, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_name = 'ochr_organizations' AND column_name = 'locale'
  `)
  if (!rows.length) throw new Error('093: ochr_organizations.locale is absent after ADD COLUMN')
  if (rows[0].is_nullable !== 'NO') throw new Error('093: locale is nullable — every reader would have to invent a meaning for null')
  if (!String(rows[0].column_default).includes("'en'")) throw new Error('093: locale lost its default')

  console.log('Migration 093: org-locale — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
