// How a reporting period relates to a date range — in one place, with names.
//
// WHY THIS FILE EXISTS
//
// On 27 Aug a July–June parish read $0.00 on the chancery's default screen
// and was billed $2,420.57 for the same year, from the same approved
// submission. Reproduced before it was touched:
//
//   GET /api/diocese/financials?start=2027-01-01&end=2027-12-31
//     → submission_count 0, assessable_base 0.00
//   assessment base year 2027
//     → 2420.57
//
// The cause was not a typo. Two surfaces were quietly answering two
// different questions with two different predicates, and neither said so.
// GET /financials documented itself as "submissions whose period OVERLAPS
// the range" and implemented CONTAINMENT.
//
// THE TWO QUESTIONS ARE BOTH LEGITIMATE. They are not merged here, because
// merging them would be wrong:
//
//   OVERLAPS_RANGE — "which periods are RELEVANT to the window I am
//     looking at?" This is a browse. A July–June period is relevant to
//     calendar 2027 because half of it happened in 2027. Containment
//     answers a different and much narrower question — "which periods fit
//     ENTIRELY inside my window" — and for any parish whose fiscal year is
//     not the calendar year the answer is almost always "none", which the
//     chancery reads as "this parish filed nothing".
//
//   ENDS_IN_YEAR — "which single billing year OWNS this period?" This is
//     an assignment, and it must be a partition: every approved period
//     belongs to exactly one assessment year or a parish is billed twice
//     or not at all. Anchoring on period_end (the year the period closes)
//     is what makes it a partition. Overlap here would double-bill any
//     period that straddles a year boundary.
//
// So: a browse overlaps, an assignment partitions. What is NOT acceptable
// is a third, unnamed semantic appearing because somebody typed a
// comparison inline. Import from here, or write down why you did not.

// Period [period_start, period_end] intersects range [$start, $end].
// Two intervals overlap iff each starts on or before the other ends.
export const overlapsRange = (startParam, endParam) =>
  `s.period_start <= ${endParam} AND s.period_end >= ${startParam}`

// Period is assigned to the calendar year it CLOSES in.
export const endsInYear = (yearParam) =>
  `s.period_end >= (${yearParam} || '-01-01')::date
   AND s.period_end <= (${yearParam} || '-12-31')::date`

// THE PARTITION HAS TO BE ENFORCED, NOT JUST DESCRIBED.
//
// ENDS_IN_YEAR above only partitions if the parish's own periods do not
// overlap each other — and until 1 Sep nothing made that so. The table's
// UNIQUE is on the exact (period_start, period_end) pair, so a parish that
// submitted its fiscal year, then its second half, then its first quarter
// had all three accepted; once approved, computeBases() and the roll-up
// SUMMED them. Reproduced: a 30,000 base billed as 60,000.
//
// This finds the live submission (submitted or approved) for the same
// parish and diocese whose period intersects the one offered, EXCLUDING
// the identical period — that one is the resubmit path and ON CONFLICT
// owns it. A 'returned' period does not block: the chancery has already
// said "not this one", and the way to fix an overlap is to return one.
// Which of two overlapping periods is the right one is the parish's and
// chancery's call, never this function's.
//
// `excludeId`: when checking an EXISTING row (the chancery's approve), the
// row must not collide with itself.
export async function findOverlappingSubmission(pool, {
  organizationId, dioceseOrgId, periodStart, periodEnd, statuses = ['submitted', 'approved'], excludeId = null,
}) {
  const { rows } = await pool.query(
    `SELECT s.id, s.status,
            to_char(s.period_start, 'YYYY-MM-DD') AS period_start,
            to_char(s.period_end, 'YYYY-MM-DD') AS period_end
       FROM ochr_report_submissions s
      WHERE s.organization_id = $1 AND s.diocese_org_id = $2
        AND s.status = ANY($3)
        AND ${overlapsRange('$4', '$5')}
        AND NOT (s.period_start = $4::date AND s.period_end = $5::date)
        AND ($6::bigint IS NULL OR s.id <> $6::bigint)
      ORDER BY s.period_start
      LIMIT 1`,
    [organizationId, dioceseOrgId, statuses, periodStart, periodEnd, excludeId]
  )
  return rows[0] ?? null
}

// One sentence for both refusals, so the parish and the chancery read the
// same words about the same row.
export const overlapMessage = (other, remedy) =>
  `This period overlaps an already submitted period (${other.period_start} – ${other.period_end}, ${other.status}). ` +
  `A parish's periods must not overlap; ${remedy}`
