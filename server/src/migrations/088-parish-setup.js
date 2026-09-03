// 088 — Getting settled: per-person dismissal, and what a parish chose.
//
// TWO SMALL TABLES, AND MOST OF THE FEATURE USES NEITHER.
//
// Almost everything the setup page shows is DERIVED — the workspace's
// own created_at, whether the organisation row carries a location and a
// tradition, how many people hold each role, the most recent import
// batch and the follow-up count already on its receipt. Deriving is the
// house rule (status is derived, not stored, for the same reason a
// balance is), and it matters more than usual here: a stored "setup
// complete" flag is a second source of truth that goes stale the moment
// somebody edits the parish address, and a page that congratulates a
// parish for something no longer true is worse than a page that says
// nothing.
//
// So these tables hold only the two things that CANNOT be derived,
// because they are decisions rather than facts.
//
// ochr_setup_dismissals — "come back to this later", PER PERSON.
//   Not per parish. The treasurer who is invited in March is exactly
//   the person the orientation was written for, and hiding it because
//   the rector dismissed it in January is the software deciding that
//   one person's readiness settles everyone's. One row per user per
//   organisation; deleting the row is how "show me this again" works,
//   so revisiting costs nothing and leaves no residue.
//
// ochr_setup_marks — "we have decided to leave this for later".
//   A parish that has consciously deferred inviting anyone is in a
//   different position from one that has not got to it, and the
//   printable record has to be able to tell the truth about the
//   difference. Without this, "deferred" would be indistinguishable
//   from "not done", and the record would quietly imply the second.
//   Org-scoped, with the actor snapshotted by name (073/074 pattern) so
//   a decision keeps its author after they leave.
//
// What is deliberately NOT here: no score column, no completed_count, no
// percentage, no "required" flag. There is nothing to store for those
// because there is nothing to compute them from — the record has no
// denominator by design.

import pool from '../db.js'

export async function up() {
  console.log('Migration 088: parish setup — applying...')

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_setup_dismissals (
      id              SERIAL PRIMARY KEY,
      organization_id INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      user_id         INTEGER NOT NULL,
      dismissed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (organization_id, user_id)
    )
  `)

  // Composite tenant key per migration 071: the user must belong to the
  // same organisation as the dismissal. CASCADE rather than SET NULL —
  // a dismissal is only meaningful for a person who still exists, and a
  // tenantless one would be a row nobody can ever clear.
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                      WHERE conname = 'ochr_setup_dismissals_user_org_fkey') THEN
        ALTER TABLE ochr_setup_dismissals
          ADD CONSTRAINT ochr_setup_dismissals_user_org_fkey
          FOREIGN KEY (user_id, organization_id)
          REFERENCES ochr_users(id, organization_id)
          ON DELETE CASCADE;
      END IF;
    END $$;
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_setup_marks (
      id              SERIAL PRIMARY KEY,
      organization_id INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      item_key        TEXT NOT NULL,
      state           TEXT NOT NULL CHECK (state IN ('later')),
      noted_by        INTEGER,
      noted_by_name   TEXT,
      noted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (organization_id, item_key)
    )
  `)

  // 'later' is the only state, and the CHECK says so rather than leaving
  // room for a 'done' that would compete with the derived truth. If a
  // thing is done, the parish's own data says so; a mark claiming it
  // would be the stale second source this migration exists to avoid.
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                      WHERE conname = 'ochr_setup_marks_noted_by_org_fkey') THEN
        ALTER TABLE ochr_setup_marks
          ADD CONSTRAINT ochr_setup_marks_noted_by_org_fkey
          FOREIGN KEY (noted_by, organization_id)
          REFERENCES ochr_users(id, organization_id)
          ON DELETE SET NULL (noted_by);
      END IF;
    END $$;
  `)

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ochr_setup_marks_org
      ON ochr_setup_marks(organization_id)
  `)

  // RLS, in the same up() that creates the table — the convention since
  // 041, restated by the 080 sweep. 080 runs BEFORE this migration, so a
  // table created here and left uncovered is not caught by anything: a
  // database built from migrations (the restore drill, a staging tenant,
  // the smoke suite's throwaway Postgres) would come up with both tables
  // RLS-off on the PostgREST path, silently, with nothing in the boot log
  // saying so. Enabling it here is the whole fix; the server connects as
  // the owner and is unaffected.
  await pool.query(`ALTER TABLE ochr_setup_dismissals ENABLE ROW LEVEL SECURITY`)
  await pool.query(`ALTER TABLE ochr_setup_marks      ENABLE ROW LEVEL SECURITY`)

  console.log('Migration 088: parish setup — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
