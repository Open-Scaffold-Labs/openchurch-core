// Where a parish stands with its diocese (DIO.6) — the trickle-down.
//
// Everything in OpenDiocese flowed one way. A parish closed a period, froze
// its totals and submitted them; the chancery approved, assessed, recorded
// payments and wrote up visits. None of it came back. A parish could not
// see its own assessment, its own rate, a payment it had made, or a note
// the diocese had explicitly marked "shared with the parish" — the
// chancery UI has said those words since CARE.1 and no parish surface
// existed to make them true.
//
// That is the difference between a diocese being *attached to* a parish and
// a diocese being *done to* a parish.
//
// FOUR RULES, all of them about restraint:
//
// 1. A DRAFT ASSESSMENT IS INVISIBLE. Only published and closed years are
//    returned. A chancery moving a rate around in draft must be able to
//    think without every parish watching the number change.
//
// 2. ONLY WHAT WAS DELIBERATELY SHARED. Timeline entries and review notes
//    carry an explicit visibility column whose default is 'diocese'. This
//    reads 'shared' and nothing else. Somebody chose, per entry.
//
// 3. READ-ONLY. There is no write path here. A parish cannot dispute an
//    assessment through the software, because that conversation belongs to
//    two people talking, and a "dispute" button would replace it with a
//    ticket.
//
// 4. NOTHING IS PHRASED AS A DEMAND. "Waiting on" states a fact about the
//    relationship. No overdue, no red, no countdown. The parish knows what
//    a deadline is; it does not need software to be stern with it.

import pool from '../db.js'

// Money arrives from pg as strings. Parse once, at the edge, so nothing
// downstream does arithmetic on "1200.00" and gets a surprise.
const money = (v) => (v == null ? 0 : Number(v))

// DATE columns arrive as 'YYYY-MM-DD' (db.js, oid 1082). A timestamp is
// still a Date; its ISO day is the UTC day of that instant. Either form's
// first ten characters are the day this surface shows.
const day = (v) => (v == null ? null : String(v instanceof Date ? v.toISOString() : v).slice(0, 10))

// The parish's own assessment lines, for years the diocese has actually
// published. `balance` is derived here rather than stored, for the same
// reason care status is derived: a stored balance goes stale the moment a
// payment is recorded and then it is a second source of truth about money.
const ASSESSMENTS = `
  SELECT a.fiscal_year, a.status AS year_status, a.basis, a.notes AS diocese_notes,
         COALESCE(a.base_year, a.fiscal_year) AS base_year,
         l.base, l.rate_bps, l.assessed, l.paid, l.status, l.note, l.updated_at,
         l.breakdown
    FROM ochr_assessment_lines l
    JOIN ochr_assessments a ON a.id = l.assessment_id
   WHERE l.parish_org_id = $1
     AND a.diocese_org_id = $2
     AND a.status IN ('published', 'closed')
   ORDER BY a.fiscal_year DESC
`

// Only entries the diocese chose to share. `actor_name` is the snapshot
// taken at write time (073/074 pattern), so a canon who has since left the
// chancery is still named as the author of the visit he made.
const NOTICES = `
  SELECT occurred_on, kind, summary, detail, actor_name
    FROM ochr_parish_timeline
   WHERE parish_org_id = $1 AND diocese_org_id = $2 AND visibility = 'shared'
   ORDER BY occurred_on DESC, id DESC
   LIMIT 25
`

// Review notes on this parish's own submissions, again only the shared
// ones. The agreed next step matters more than the note: it is the thing
// both sides said out loud.
const REVIEW = `
  SELECT n.body, n.agreed_next_step, n.follow_up_on, n.author_name, n.created_at,
         s.period_start, s.period_end, s.status AS submission_status
    FROM ochr_report_review_notes n
    JOIN ochr_report_submissions s ON s.id = n.submission_id
   WHERE s.organization_id = $1 AND n.diocese_org_id = $2 AND n.visibility = 'shared'
   ORDER BY n.created_at DESC
   LIMIT 25
`

// A submission sent back to the parish is the one case where the ball is
// genuinely in the parish's court, and the parish has never been told.
const RETURNED = `
  SELECT id, period_start, period_end, status, reviewed_at, review_note
    FROM ochr_report_submissions
   WHERE organization_id = $1 AND diocese_org_id = $2 AND status = 'returned'
   ORDER BY period_end DESC
   LIMIT 10
`

// What the chancery is holding: submitted but not yet reviewed. Shown so a
// parish knows its report is not lost — the commonest anxiety about
// sending anything to a diocese is silence.
const WITH_DIOCESE = `
  SELECT id, period_start, period_end, submitted_at
    FROM ochr_report_submissions
   WHERE organization_id = $1 AND diocese_org_id = $2 AND status = 'submitted'
   ORDER BY period_end DESC
   LIMIT 10
`

// Rate as a sentence, not as basis points. Nobody outside a finance office
// reads "850 bps" and pictures 8.5%.
export function ratePhrase(rateBps, basis) {
  if (rateBps == null) return null
  // Trailing zeros read as false precision: 850 bps is "8.5%", not "8.50%".
  const pct = String(Number((rateBps / 100).toFixed(2)))
  const on = basis === 'assessable_revenue' ? 'assessable income' : String(basis).replaceAll('_', ' ')
  return `${pct}% of ${on}`
}

// One sentence per line, in the parish's own terms. Care language, not
// collections language: a balance is a balance, never a delinquency.
export function lineMeaning(line) {
  const balance = money(line.assessed) - money(line.paid)
  if (line.status === 'waived') return 'The diocese has waived this year.'
  if (line.status === 'paid' || balance <= 0) return 'Settled in full.'
  if (money(line.paid) > 0) {
    return `Part paid. ${balance.toFixed(2)} of ${money(line.assessed).toFixed(2)} remains.`
  }
  return `${money(line.assessed).toFixed(2)} assessed for the year. Nothing recorded as paid yet.`
}

export async function standingFor(parishOrgId, dioceseOrgId) {
  const [assessments, notices, review, returned, withDiocese] = await Promise.all([
    pool.query(ASSESSMENTS, [parishOrgId, dioceseOrgId]),
    pool.query(NOTICES, [parishOrgId, dioceseOrgId]),
    pool.query(REVIEW, [parishOrgId, dioceseOrgId]),
    pool.query(RETURNED, [parishOrgId, dioceseOrgId]),
    pool.query(WITH_DIOCESE, [parishOrgId, dioceseOrgId]),
  ])

  return {
    assessments: assessments.rows.map((l) => ({
      fiscal_year: l.fiscal_year,
      year_status: l.year_status,
      base: money(l.base),
      assessed: money(l.assessed),
      paid: money(l.paid),
      balance: Number((money(l.assessed) - money(l.paid)).toFixed(2)),
      status: l.status,
      rate: ratePhrase(l.rate_bps, l.basis),
      rate_bps: l.rate_bps,
      // Where the number came from. A parish that cannot see the basis of
      // its own assessment has to take the figure on trust, and an
      // assessment taken on trust is the one people resent.
      because: `Assessed on ${money(l.base).toFixed(2)} of ${
        l.basis === 'assessable_revenue' ? 'assessable income' : String(l.basis).replaceAll('_', ' ')
      } reported for ${l.base_year} (approved figures minus any recorded credits).`,
      // The slice-by-slice working, where the diocese uses a rate ladder.
      // A parish should be able to arrive at its own number with a pen
      // rather than take it on trust — an assessment taken on trust is
      // the one people resent. Null for a flat rate, which needs no
      // working, and null after a negotiated override, which is a flat
      // rate by definition.
      breakdown: Array.isArray(l.breakdown)
        ? l.breakdown.map(b => ({
            from: money(b.from),
            to: b.to === null || b.to === undefined ? null : money(b.to),
            amount_in_band: money(b.amount_in_band),
            rate: `${(b.rate_bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`,
            assessed: money(b.assessed),
          }))
        : null,
      meaning: lineMeaning(l),
      note: l.note ?? null,
      diocese_notes: l.diocese_notes ?? null,
      updated_at: l.updated_at,
    })),

    // Shared notes and shared timeline entries are one stream to the
    // parish — it does not care which chancery table a sentence lives in.
    notices: [
      ...notices.rows.map((n) => ({
        on: day(n.occurred_on), kind: n.kind, summary: n.summary,
        detail: n.detail ?? null, from: n.actor_name ?? null,
      })),
      ...review.rows.map((n) => ({
        on: day(n.created_at), kind: 'report',
        summary: n.body,
        detail: n.agreed_next_step
          ? `Agreed: ${n.agreed_next_step}${n.follow_up_on ? ` (by ${n.follow_up_on})` : ''}`
          : null,
        from: n.author_name ?? null,
        period: `${n.period_start} to ${n.period_end}`,
      })),
    ].sort((a, b) => String(b.on).localeCompare(String(a.on))),

    with_us: returned.rows.map((s) => ({
      id: s.id, period_start: s.period_start, period_end: s.period_end,
      // The chancery's own note on WHY it came back, if it left one. A
      // period returned with no reason is the thing that makes a parish
      // dread the next one.
      what: s.review_note
        ? `The diocese has sent this period back: ${s.review_note}`
        : 'The diocese has sent this period back for another look.',
      returned_on: day(s.reviewed_at),
    })),

    with_diocese: withDiocese.rows.map((s) => ({
      id: s.id, period_start: s.period_start, period_end: s.period_end,
      what: 'Submitted and waiting on a shared review. Nothing is needed from you.',
    })),
  }
}
