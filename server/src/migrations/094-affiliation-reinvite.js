// A parish that has left can be invited back.
//
// Until now it could not, and the reason was one constraint doing two jobs.
// Migration 058 created BOTH:
//
//   UNIQUE (diocese_org_id, parish_org_id)          -- unconditional
//   uq_affiliation_one_live_diocese
//     ON (parish_org_id) WHERE status IN ('invited','active','suspended')
//
// The second one is the real rule and it is correct: a parish belongs to at
// most one diocese at a time, invitations counted, so two dioceses cannot
// race an invitation to the same parish. It excludes 'ended' deliberately —
// a parish that has left is free.
//
// The first one is what blocked re-invitation. Reproduced 2026-08-25:
//
//   affiliation active → parish leaves (status='ended')
//   re-invite by the SAME diocese      → 23505 on
//                 ochr_diocese_affiliations_diocese_org_id_parish_org_id_key
//   invite by a DIFFERENT diocese      → succeeds
//
// So a parish could leave and be taken in by anyone EXCEPT the diocese it
// had been with — which is the likeliest reconciliation there is.
//
// Worse, routes/diocese.js maps every 23505 on this table to "That parish
// already has a diocese affiliation or pending invitation", and the cohort
// path to "Invited by someone else a moment ago". Both are false in this
// case, and the second one names a different diocese as the cause.
//
// WHY DROPPING IT IS SAFE. Every reader of this table that resolves a single
// affiliation already filters by status — checked one by one before writing
// this: routes/diocese.js:122/:449, routes/dioceseCare.js:71,
// routes/finance.js:337, and the ACTIVE_AFF / LIVE_AFFILIATION fragments.
// That discipline came out of the affiliation-covenant work in August, and
// it is what makes history rows harmless now. Nothing depended on the pair
// being globally unique: there is no ON CONFLICT on it anywhere.
//
// The replacement keeps the pair rule where it actually matters — one LIVE
// affiliation per (diocese, parish) — and lets the ended ones accumulate as
// what they are: the record that this parish and this diocese have been
// together before. Nothing is deleted or rewritten to make room.

import pool from '../db.js'

export async function up() {
  await pool.query(`
    ALTER TABLE ochr_diocese_affiliations
      DROP CONSTRAINT IF EXISTS ochr_diocese_affiliations_diocese_org_id_parish_org_id_key
  `)

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_affiliation_one_live_pair
      ON ochr_diocese_affiliations(diocese_org_id, parish_org_id)
      WHERE status IN ('invited', 'active', 'suspended')
  `)

  // Self-assertion. A migration that half-applies leaves the schema and the
  // schema file disagreeing, and here the disagreement would be invisible
  // until somebody tried to reconcile with a parish and was told a lie about
  // why they could not.
  const { rows: stillThere } = await pool.query(`
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ochr_diocese_affiliations_diocese_org_id_parish_org_id_key'
  `)
  if (stillThere.length) throw new Error('094: the unconditional pair UNIQUE survived the drop')

  const { rows: idx } = await pool.query(`
    SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_affiliation_one_live_pair'
  `)
  if (!idx.length) throw new Error('094: uq_affiliation_one_live_pair was not created')
  if (!/WHERE .*status/i.test(idx[0].indexdef)) {
    throw new Error('094: the replacement index is not partial — it would block re-invitation exactly as before')
  }

  console.log('Migration 094: affiliation-reinvite — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
