// R348-2: a durable revision on every Mass-intention update.
//
// The mark-said undo used to compare a digest of the current column
// values. A correction and its reverse put those values back, so the
// digest matched and undo cleared protection a later fact had added.
// book_revision increments on every UPDATE, including one that only
// restores a previous value. Undo compares the revision it stored.

import pool from '../db.js'

export async function up() {
  console.log('Migration 122: mass-intention-book-revision — applying...')

  await pool.query(`
    ALTER TABLE ochr_mass_intentions
      ADD COLUMN IF NOT EXISTS book_revision BIGINT NOT NULL DEFAULT 1
  `)
  await pool.query(`
    ALTER TABLE ochr_mass_intention_mark_items
      ADD COLUMN IF NOT EXISTS after_book_revision BIGINT
  `)

  await pool.query(`
    CREATE OR REPLACE FUNCTION ochr_mass_intention_book_revision() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'UPDATE' THEN
        NEW.book_revision := OLD.book_revision + 1;
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql
  `)
  await pool.query('DROP TRIGGER IF EXISTS ochr_mass_intention_book_revision ON ochr_mass_intentions')
  await pool.query(`
    CREATE TRIGGER ochr_mass_intention_book_revision
      BEFORE UPDATE ON ochr_mass_intentions
      FOR EACH ROW EXECUTE FUNCTION ochr_mass_intention_book_revision()
  `)

  const { rows } = await pool.query(
    `SELECT 1 FROM pg_trigger
      WHERE tgrelid = 'ochr_mass_intentions'::regclass
        AND tgname = 'ochr_mass_intention_book_revision'`
  )
  if (rows.length !== 1) throw new Error('122: book revision trigger missing')
  console.log('Migration 122: mass-intention-book-revision — done.')
}
