// 072 — Tradition: the column the product has been missing.
//
// THE DEFECT THIS CLOSES
//
// OpenChurch ships two liturgical engines that speak two different
// traditions, and prints both on the same sheet:
//
//   routes/liturgical.js  → Roman/Lutheran. Returns season 'Ordinary Time';
//                           names 1 January 'Mary, Mother of God'.
//   services/lectionary.js → Episcopal/RCL. Returns "Fourteenth Sunday
//                           after Pentecost · Proper 17"; names the same
//                           1 January 'The Holy Name (New Year's Day)'.
//
// SundayPacket.jsx composes a line from each and renders them stacked, so
// every parish of every tradition gets Episcopal designations above Roman
// season names. The two engines disagree about the same date in the same
// product, and nothing decides between them because there was nothing to
// decide with.
//
// THE SHAPE OF THE FIX
//
// One column, read by a static registry (server/src/traditions/). Not a
// feature-flag system, not per-tradition tables, not a second codebase.
// Adding a tradition is adding an object to a registry.
//
// 'general' is deliberately a first-class value rather than a hole. A
// congregation whose tradition we have not modelled must get a coherent
// product — generic season names and NO lectionary line — rather than a
// confidently wrong one. Printing nothing is honest; printing another
// tradition's Sunday name is not.
//
// EXISTING ROWS DEFAULT TO 'general', NOT 'catholic'.
//
// That is the conservative choice and it is deliberate. We do not know
// what tradition an existing org belongs to, and guessing wrong is worse
// than asking: a Catholic parish silently switched to Episcopal Propers
// would be a defect we introduced. Onboarding will ask (Stage 5); until
// then existing orgs keep neutral vocabulary and lose the contradictory
// lectionary line, which is strictly better than today.

import pool from '../db.js'

export const TRADITION_VALUES = ['catholic', 'episcopal', 'lutheran', 'anglican', 'general']

export async function up() {
  await pool.query(`
    ALTER TABLE ochr_organizations
      ADD COLUMN IF NOT EXISTS tradition TEXT NOT NULL DEFAULT 'general'
  `)

  // Idempotent CHECK — same pattern as 070's sacrament-type replace, so
  // adding a tradition later is a constraint swap rather than a type
  // migration.
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'ochr_organizations_tradition_check'
      ) THEN
        ALTER TABLE ochr_organizations DROP CONSTRAINT ochr_organizations_tradition_check;
      END IF;
      ALTER TABLE ochr_organizations
        ADD CONSTRAINT ochr_organizations_tradition_check
        CHECK (tradition IN ('catholic', 'episcopal', 'lutheran', 'anglican', 'general'));
    END $$;
  `)

  // The demo parish is explicitly Episcopal — stBrigids.js:214 says so in
  // as many words ("Rector, Deacon, Senior/Junior Warden, Vestry, Verger,
  // Altar Guild"), and its own seeded events were nonetheless stamped with
  // Roman season labels. Naming its tradition is what makes the demo stop
  // contradicting itself.
  await pool.query(`
    UPDATE ochr_organizations
       SET tradition = 'episcopal'
     WHERE slug = 'st-brigids' AND tradition = 'general'
  `)

  console.log('Migration 072: org tradition — applied.')
}
