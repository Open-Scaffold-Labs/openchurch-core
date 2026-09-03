// Repair the tenant guards that 073 and 074 only ever gave to NEW databases.
//
// THE BUG THIS EXISTS FOR IS A CLASS OF BUG, NOT A TYPO.
//
// Migrations 073 and 074 create their tables with `CREATE TABLE IF NOT
// EXISTS`. Both shipped, briefly, with single-column foreign keys; both were
// corrected to composite (tenant-scoped) keys the same day. On a database
// built from zero, the corrected version runs and everything is right —
// which is exactly what CI does, so CI has been green throughout.
//
// On a database that had already run the ORIGINAL version, `IF NOT EXISTS`
// finds the table, does nothing, and the weak constraint stays forever. The
// correction can never reach it. Re-running migrations does not help; it is
// a no-op by design.
//
// This was found by running the tenant-FK gate against a dev database and
// getting three findings, then running it against a database built from
// zero migrations and getting none. The gap between those two numbers is
// the bug. A gate that only ever sees a fresh database cannot see it at
// all — same shape as every other defect this project keeps catching:
// something green that is not looking at the thing.
//
// What each of these prevents, concretely: a single-column FK to
// ochr_users lets a row in parish A name a user from parish B. The
// application layer never does that, so nothing breaks in testing; the
// database simply stops being the thing that makes it impossible.
//
// Idempotent, and safe to run on a database that is already correct — each
// step checks for the composite constraint by name and returns if it is
// there.

import pool from '../db.js'

// Each entry: the table, the correct constraint's name, the old
// single-column constraint to drop, and the exact definition to add.
// Definitions are copied from what 073/074 produce on a fresh database, so
// a repaired database is byte-identical to a newly built one.
// A composite FK needs a matching UNIQUE on the parent, and those were
// missed by the same `IF NOT EXISTS` gap one level up. Repair the parents
// first or every ADD CONSTRAINT below fails with "no unique constraint
// matching given keys".
const PARENT_UNIQUES = [
  ['ochr_diocese_regions',    'ochr_diocese_regions_id_dio_uniq',    '(id, diocese_org_id)'],
  ['ochr_report_submissions', 'ochr_report_submissions_id_dio_uniq', '(id, diocese_org_id)'],
  ['ochr_users',              'ochr_users_id_org_uniq',              '(id, organization_id)'],
]

const REPAIRS = [
  {
    table: 'ochr_diocese_affiliations',
    want: 'ochr_affiliation_region_fk',
    drop: 'ochr_diocese_affiliations_region_id_fkey',
    // PG15 column-scoped SET NULL: only region_id is cleared, so losing a
    // region never quietly unpicks the parish's diocese.
    def: `FOREIGN KEY (region_id, diocese_org_id)
            REFERENCES ochr_diocese_regions(id, diocese_org_id)
            ON DELETE SET NULL (region_id)`,
  },
  {
    table: 'ochr_report_review_notes',
    want: 'ochr_review_note_submission_fk',
    drop: 'ochr_report_review_notes_submission_id_fkey',
    def: `FOREIGN KEY (submission_id, diocese_org_id)
            REFERENCES ochr_report_submissions(id, diocese_org_id)
            ON DELETE CASCADE`,
  },
  {
    table: 'ochr_sacrament_amendments',
    want: 'ochr_sacrament_amendments_actor_fk',
    drop: 'ochr_sacrament_amendments_amended_by_fkey',
    // A register amendment must never be able to name a user from another
    // parish as its author. Authorship of a canonical record is the whole
    // point of 073.
    def: `FOREIGN KEY (amended_by, organization_id)
            REFERENCES ochr_users(id, organization_id)
            ON DELETE SET NULL (amended_by)`,
  },
]

const has = async (table, constraint) => {
  const { rows } = await pool.query(
    `SELECT 1 FROM pg_constraint
      WHERE conname = $2 AND conrelid = to_regclass($1)`,
    [table, constraint]
  )
  return rows.length > 0
}

const tableExists = async (table) => {
  const { rows } = await pool.query(`SELECT to_regclass($1) AS t`, [table])
  return rows[0]?.t != null
}

export async function up() {
  console.log('Migration 075: tenant FK repair — applying...')

  for (const [table, name, cols] of PARENT_UNIQUES) {
    if (!(await tableExists(table))) continue
    if (await has(table, name)) continue
    await pool.query(`ALTER TABLE ${table} ADD CONSTRAINT ${name} UNIQUE ${cols}`)
    console.log(`  ↻ ${table} gained ${name}`)
  }

  for (const r of REPAIRS) {
    if (!(await tableExists(r.table))) {
      // 073/074 have not run here yet, so they will create the table with
      // the correct constraint themselves. Nothing to repair.
      console.log(`  · ${r.table} does not exist yet — skipping`)
      continue
    }
    if (await has(r.table, r.want)) {
      console.log(`  ✓ ${r.table} already tenant-scoped`)
      continue
    }

    // Drop by name if the original is still there, then add the composite.
    // Both are guarded so a half-applied run can be resumed.
    if (await has(r.table, r.drop)) {
      await pool.query(`ALTER TABLE ${r.table} DROP CONSTRAINT ${r.drop}`)
    }
    await pool.query(`ALTER TABLE ${r.table} ADD CONSTRAINT ${r.want} ${r.def}`)
    console.log(`  ↻ ${r.table} repaired — ${r.drop} → ${r.want}`)
  }

  console.log('Migration 075: tenant FK repair — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
