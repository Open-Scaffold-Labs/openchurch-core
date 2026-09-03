// A pastoral-leadership permission, and the two columns the care workflow
// was missing (CARE.3).
//
// WHY NOT JUST USE 'admin'
//
// Internal diocesan notes were gated on `role === 'admin'`. That is the
// organisation's *ownership* role — the person who pays the bill, manages
// billing, and adds users. In a chancery that is frequently an operations
// or IT person, and it is just as frequently NOT the canon who conducts
// visitations.
//
// Using org-admin as a proxy for pastoral leadership gets it wrong in both
// directions at once: it hands a parish's confidences to whoever
// administers the account, and it withholds them from the person whose job
// is actually to care for that parish. Neither error is visible in testing,
// because in a small test org the same human is both.
//
// So: the smallest clear permission that says what it means. One boolean,
// granted by an admin, meaning "this person may read what the office keeps
// to itself about a parish". It is not a role — a canon can be `staff` and
// still be pastoral leadership; an admin can be neither.
//
// BACKFILL. Existing diocese admins are granted it, because that is exactly
// who could see internal notes yesterday and silently revoking access
// during an upgrade would be a worse failure than the one being fixed. New
// diocese accounts grant it to the founding user, who would otherwise
// create a chancery nobody can conduct pastoral work in.
//
// REVIEWED-TOGETHER, NOT APPROVED
//
// `ochr_report_submissions.status` stays exactly as it is. 'approved' gates
// the assessment roll-up, so renaming or overloading it would be a money
// change dressed as a vocabulary change (the same reasoning that kept the
// stored states alone in 074). "We sat down and read this together" is a
// different fact from "this is accepted for assessment", so it gets its own
// column and implies no judgement about the parish.

import pool from '../db.js'

export async function up() {
  console.log('Migration 076: pastoral lead + care workflow columns — applying...')

  // ── The permission ───────────────────────────────────────────────────
  await pool.query(`
    ALTER TABLE ochr_users
      ADD COLUMN IF NOT EXISTS pastoral_lead BOOLEAN NOT NULL DEFAULT FALSE
  `)
  // Grandfather exactly the people who had this access a moment ago.
  const { rowCount } = await pool.query(`
    UPDATE ochr_users u
       SET pastoral_lead = TRUE
      FROM ochr_organizations o
     WHERE o.id = u.organization_id
       AND o.org_type = 'diocese'
       AND u.role = 'admin'
       AND u.pastoral_lead = FALSE
  `)
  console.log(`  ✓ pastoral_lead granted to ${rowCount} existing diocese admin(s)`)

  // ── Reviewed together ────────────────────────────────────────────────
  await pool.query(`
    ALTER TABLE ochr_report_submissions
      ADD COLUMN IF NOT EXISTS reviewed_together_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS reviewed_together_by INTEGER,
      -- Snapshot, like 073/074: a canon who leaves does not take the fact
      -- that he sat down with a parish along with him.
      ADD COLUMN IF NOT EXISTS reviewed_together_name TEXT
  `)
  // Composite tenant FK: the reviewer is a DIOCESE user, so the pair is
  // (reviewed_together_by, diocese_org_id). A single-column FK here would
  // let one chancery's submission name another chancery's canon.
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'ochr_submission_reviewer_fk'
           AND conrelid = 'ochr_report_submissions'::regclass
      ) THEN
        ALTER TABLE ochr_report_submissions
          ADD CONSTRAINT ochr_submission_reviewer_fk
          FOREIGN KEY (reviewed_together_by, diocese_org_id)
          REFERENCES ochr_users(id, organization_id)
          ON DELETE SET NULL (reviewed_together_by);
      END IF;
    END $$;
  `)

  // ── Letting a follow-up go, with a reason ────────────────────────────
  //
  // "Let it go" already existed as a state. What was missing was room to
  // say why — and a resolution nobody can explain later is the kind of
  // thing that makes an office distrust its own records.
  await pool.query(`
    ALTER TABLE ochr_parish_followups
      ADD COLUMN IF NOT EXISTS let_go_reason TEXT,
      ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS settled_by_name TEXT,
      -- When a follow-up came out of reading a report together, say so, so
      -- the brief can put the action next to the conversation that caused it.
      ADD COLUMN IF NOT EXISTS from_submission_id BIGINT
  `)
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'ochr_followup_submission_fk'
           AND conrelid = 'ochr_parish_followups'::regclass
      ) THEN
        ALTER TABLE ochr_parish_followups
          ADD CONSTRAINT ochr_followup_submission_fk
          FOREIGN KEY (from_submission_id, diocese_org_id)
          REFERENCES ochr_report_submissions(id, diocese_org_id)
          ON DELETE SET NULL (from_submission_id);
      END IF;
    END $$;
  `)

  console.log('Migration 076: pastoral lead + care workflow columns — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
