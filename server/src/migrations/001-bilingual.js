// Bilingual schema migration — makes language a first-class concept in OpenChurch
// per Dale's "OpenChurch should be bilingual from the beginning" directive.
//
// Adds:
//   - clients.preferred_language            (en | es | both)
//   - events.language                       (en | es | both)
//   - schedule.language                     (en | es | both)
//   - calendar_events.language              (en | es | both)
//   - notifications.language                (en | es | both)
//   - ai_generations.output_language        (en | es | both)
//   - translations (side table for parallel content, e.g. one event with
//     both English and Spanish descriptions, indexed by entity_type/entity_id)
//
// Design notes:
//   - All additions are ADD COLUMN IF NOT EXISTS so the migration is idempotent
//   - Default is 'en' so existing rows remain valid; the Documentation Architect
//     (or a one-time sweep) updates known-Spanish rows afterwards
//   - 'both' means the record has parallel translations and should be surfaced
//     in both language filters
//   - The translations side table is the canonical place for bilingual content
//     that lives alongside a primary-language record (e.g. an event's name in
//     English stays on events.title, the Spanish version lives in translations)
//
// Usage:
//   import { up } from './migrations/001-bilingual.js'
//   await up()
//
// Designed to be safe to re-run; all statements are idempotent.

import pool from '../db.js'

export async function up() {
  console.log('Migration 001: bilingual-first-class — applying...')

  // 1. Per-row language fields on user-facing entities
  await pool.query(`
    ALTER TABLE ochr_clients
      ADD COLUMN IF NOT EXISTS preferred_language TEXT DEFAULT 'en'
        CHECK (preferred_language IN ('en', 'es', 'both'))
  `)
  await pool.query(`
    ALTER TABLE ochr_events
      ADD COLUMN IF NOT EXISTS language TEXT DEFAULT 'en'
        CHECK (language IN ('en', 'es', 'both'))
  `)
  await pool.query(`
    ALTER TABLE ochr_schedule
      ADD COLUMN IF NOT EXISTS language TEXT DEFAULT 'en'
        CHECK (language IN ('en', 'es', 'both'))
  `)
  await pool.query(`
    ALTER TABLE ochr_calendar_events
      ADD COLUMN IF NOT EXISTS language TEXT DEFAULT 'en'
        CHECK (language IN ('en', 'es', 'both'))
  `)
  await pool.query(`
    ALTER TABLE ochr_notifications
      ADD COLUMN IF NOT EXISTS language TEXT DEFAULT 'en'
        CHECK (language IN ('en', 'es', 'both'))
  `)
  await pool.query(`
    ALTER TABLE ochr_ai_generations
      ADD COLUMN IF NOT EXISTS output_language TEXT DEFAULT 'en'
        CHECK (output_language IN ('en', 'es', 'both'))
  `)

  // 2. Translations side-table for parallel content
  //
  //   entity_type   — the table the translation refers to (e.g. 'ochr_events')
  //   entity_id     — the row's primary key in that table
  //   language      — the language of the translated content ('es' typically)
  //   field_name    — which field is translated (e.g. 'title', 'description')
  //   translated_value — the translated text
  //
  //   A single row in ochr_events with language='both' can have many rows in
  //   translations (one per language per field). The base record is the
  //   primary language (usually 'en'); the translations table stores the
  //   parallel versions.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_translations (
      id               SERIAL PRIMARY KEY,
      entity_type      TEXT NOT NULL,
      entity_id        INTEGER NOT NULL,
      language         TEXT NOT NULL
                         CHECK (language IN ('en', 'es', 'pt', 'vi', 'tl', 'ko', 'pl')),
      field_name       TEXT NOT NULL,
      translated_value TEXT NOT NULL,
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      updated_at       TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (entity_type, entity_id, language, field_name)
    )
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ochr_translations_entity
      ON ochr_translations (entity_type, entity_id)
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ochr_translations_language
      ON ochr_translations (language)
  `)

  // 3. Backfill: mark Ministerios-related existing rows as Spanish
  //    This is conservative — we only tag rows whose title clearly signals
  //    Spanish (Misa en Espa\u00f1ol, Coro en Espa\u00f1ol, Ministerios, Guadalupe,
  //    Quincea\u00f1era). Everything else stays 'en' as the default.
  await pool.query(`
    UPDATE ochr_schedule
       SET language = 'es'
     WHERE title ILIKE '%Espa\u00f1ol%'
        OR title ILIKE '%Ministerios%'
        OR title ILIKE '%Coro en Espa\u00f1ol%'
        OR title = 'Misa en Espa\u00f1ol'
  `)
  await pool.query(`
    UPDATE ochr_events
       SET language = 'es'
     WHERE title ILIKE '%Ministerios%'
        OR title ILIKE '%Guadalupe%'
        OR title ILIKE '%Quincea\u00f1era%'
  `)
  await pool.query(`
    UPDATE ochr_calendar_events
       SET language = 'es'
     WHERE title ILIKE '%Espa\u00f1ol%'
        OR title ILIKE '%Ministerios%'
  `)
  await pool.query(`
    UPDATE ochr_notifications
       SET language = 'es'
     WHERE message ILIKE '%Espa\u00f1ol%'
        OR message ILIKE '%Ministerios%'
        OR message ILIKE '%Guadalupe%'
        OR message ~ '[\u00e1\u00e9\u00ed\u00f3\u00fa\u00f1\u00bf\u00a1]'
  `)

  // 4. Tag Hispanic-ministry-facing members (those with 'bilingual' or
  //    'ministerios' in their tags) as preferring Spanish
  await pool.query(`
    UPDATE ochr_clients
       SET preferred_language = 'es'
     WHERE tags ILIKE '%bilingual%' OR tags ILIKE '%ministerios%'
  `)

  console.log('Migration 001: bilingual-first-class — applied.')
}

// Down migration is deliberately not provided. Removing the language columns
// would be destructive; if the rollback is needed, restore from a DB snapshot.

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
