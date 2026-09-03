// A parish's live reporting periods must not overlap — enforced by the
// database, not only by the two routes that remember to ask.
//
// WHAT WENT WRONG. ochr_report_submissions' UNIQUE is on the exact
// (organization_id, diocese_org_id, period_start, period_end) tuple, so a
// parish that submitted its fiscal year, then its second half, then its
// first quarter had all three accepted as distinct rows. Once approved,
// computeBases() SUMS them: a 30,000 assessable base billed as 60,000. The
// diocesan assessment is derived from these rows, so an overlap is not a
// display bug — it is a parish being invoiced for money it does not owe.
//
// 66cd968 closed the two application routes (findOverlappingSubmission, in
// finance/fiscalPeriod.js). Both are check-then-write: a SELECT on one
// pooled connection, a write on another, no transaction and no lock. Two
// concurrent chancery approvals of two overlapping SUBMITTED periods each
// read "no approved overlap" and both land. The application guard is the
// good error message; this is the guarantee.
//
// WHY PARTIAL ON STATUS. 'returned' must be allowed to overlap. The
// chancery's remedy for a bad period is to return it, and the parish's
// remedy is to submit a corrected one — which will usually overlap the
// returned original. An unpartitioned constraint would forbid exactly the
// fix the 409 messages tell people to make. Draft periods do not exist as
// rows, so submitted+approved is the whole live set.
//
// WHY THE RESUBMIT PATH STILL WORKS. finance.js resubmits with
// ON CONFLICT (organization_id, diocese_org_id, period_start, period_end)
// DO UPDATE. The arbiter is that unique index; an exclusion constraint is
// never an ON CONFLICT arbiter and does not become one here. The DO UPDATE
// keeps the same range on the same row, and a row is not range-compared
// against its own previous version, so the identical-period resubmit does
// not collide with itself.
//
// INCLUSIVE BOUNDS. '[]' — period_end is the last day IN the period, which
// is how every other query in this codebase reads it (overlapsRange,
// endsInYear). With '[)' a period ending 2027-06-30 and one starting
// 2027-06-30 would be treated as disjoint, and they are not.

import pool from '../db.js'

const CONSTRAINT = 'uq_submission_no_overlap'

export async function up() {
  console.log('Migration 098: submission-no-overlap — applying...')

  // FAIL LOUDLY ON UNSAFE DATA, AND SAY WHOSE.
  //
  // ADD CONSTRAINT would fail on its own, with a Postgres message naming an
  // index and a tuple. That is not enough to act on: which parish, which
  // two periods, and which of them is the right one are questions only the
  // parish and its chancery can answer. Exclusion constraints have no
  // NOT VALID form, so there is no "add it and clean up later" — and this
  // migration must never resolve an overlap itself. Deleting or rewriting a
  // historical financial period to make a constraint apply would be the
  // migration silently deciding which of two submissions a parish really
  // meant, in a table the diocese bills from.
  const { rows: overlaps } = await pool.query(`
    SELECT a.organization_id, a.diocese_org_id,
           a.id AS id_a, a.status AS status_a, a.period_start AS start_a, a.period_end AS end_a,
           b.id AS id_b, b.status AS status_b, b.period_start AS start_b, b.period_end AS end_b
      FROM ochr_report_submissions a
      JOIN ochr_report_submissions b
        ON a.organization_id = b.organization_id
       AND a.diocese_org_id  = b.diocese_org_id
       AND a.id < b.id
       AND a.status IN ('submitted','approved')
       AND b.status IN ('submitted','approved')
       AND a.period_start <= b.period_end
       AND a.period_end   >= b.period_start
     ORDER BY a.organization_id, a.period_start
     LIMIT 50
  `)

  if (overlaps.length) {
    const lines = overlaps.map(o =>
      `  org ${o.organization_id} / diocese ${o.diocese_org_id}: ` +
      `#${o.id_a} ${o.start_a.toISOString?.().slice(0, 10) ?? o.start_a}–${o.end_a.toISOString?.().slice(0, 10) ?? o.end_a} (${o.status_a}) ` +
      `overlaps #${o.id_b} ${o.start_b.toISOString?.().slice(0, 10) ?? o.start_b}–${o.end_b.toISOString?.().slice(0, 10) ?? o.end_b} (${o.status_b})`
    ).join('\n')
    throw new Error(
      `098: refusing to apply — ${overlaps.length} overlapping live reporting period(s) already exist.\n` +
      `${lines}\n` +
      `Each pair must be resolved first, by the chancery returning whichever period is wrong ` +
      `(a 'returned' period is allowed to overlap). This migration will not choose for them, ` +
      `because the assessable base is billed from these rows.`
    )
  }

  // btree_gist gives gist the integer = operator. daterange && is native.
  await pool.query('CREATE EXTENSION IF NOT EXISTS btree_gist')

  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${CONSTRAINT}') THEN
        ALTER TABLE ochr_report_submissions
          ADD CONSTRAINT ${CONSTRAINT}
          EXCLUDE USING gist (
            organization_id WITH =,
            diocese_org_id  WITH =,
            daterange(period_start, period_end, '[]') WITH &&
          ) WHERE (status IN ('submitted', 'approved'));
      END IF;
    END $$
  `)

  // Self-assertion. A half-applied migration leaves the schema and the file
  // disagreeing, and the disagreement here is invisible until a parish is
  // billed twice.
  const { rows: check } = await pool.query(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`,
    [CONSTRAINT]
  )
  if (!check.length) throw new Error(`098: ${CONSTRAINT} was not created`)
  if (!/WHERE .*status/i.test(check[0].def)) {
    throw new Error(`098: ${CONSTRAINT} is not partial — a returned period could not be replaced by a corrected one`)
  }
  if (!/daterange/i.test(check[0].def)) {
    throw new Error(`098: ${CONSTRAINT} is not a range exclusion — it would not detect an overlap`)
  }

  console.log('Migration 098: submission-no-overlap — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
