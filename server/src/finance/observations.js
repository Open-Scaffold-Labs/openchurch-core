// Financial observations (DIO.4, re-worded for CARE.1) — simple,
// explainable rules over approved submissions. No ML, no scores: each
// observation names its rule and shows the numbers behind it, because a
// chancery acting on one needs to be able to say WHY out loud. Thresholds
// live here in one place so a later per-diocese settings surface has a
// single seam to attach to.
//
// THIS FILE USED TO BE CALLED distress.js AND SPOKE A DIFFERENT LANGUAGE.
//
// The mechanism was always compliant with the Parish Care doctrine —
// explainable, computed at read time, never stored as a verdict on a
// parish's record. The words were not: `computeDistress`, `stale_submission`,
// `deficit_streak`, and a route called /health. Two vocabularies for one
// product is how a "quiet view of where a parish may need attention"
// quietly becomes a health score, so there is now one.
//
// An observation is a NOTICING, not a conclusion. "Revenue is lower than
// the previous period" is a fact about two numbers. Whether that means a
// parish is struggling, or sold a building, or corrected an error, is a
// question for a person — which is why every observation carries its
// numbers and none carries a judgement.

import pool from '../db.js'

export const THRESHOLDS = {
  // Latest approved period ended more than this many days ago → stale.
  staleDays: 75,
  // Revenue below this fraction of the prior period → decline flag.
  declineRatio: 0.85,
  // This many most-recent consecutive periods with net < 0 → deficit flag.
  deficitStreak: 2,
}

// → [{ parish_org_id, parish_name, flags: [{ code, detail }] }]
// Only parishes with at least one observation are returned.
export async function financialObservations(dioceseOrgId) {
  const { rows } = await pool.query(
    `SELECT s.organization_id, p.name AS parish_name,
            to_char(s.period_end, 'YYYY-MM-DD') AS period_end,
            (s.totals_json->'totals'->>'revenue')::NUMERIC AS revenue,
            (s.totals_json->'totals'->>'net')::NUMERIC     AS net
       FROM ochr_report_submissions s
       JOIN ochr_organizations p ON p.id = s.organization_id
       JOIN ochr_diocese_affiliations a
         ON a.parish_org_id = s.organization_id
        AND a.diocese_org_id = s.diocese_org_id
        AND a.status IN ('active', 'suspended')
      WHERE s.diocese_org_id = $1 AND s.status = 'approved'
      ORDER BY s.organization_id, s.period_end ASC`,
    [dioceseOrgId]
  )

  const byParish = new Map()
  for (const r of rows) {
    const p = byParish.get(r.organization_id) ?? { parish_name: r.parish_name, periods: [] }
    p.periods.push(r)
    byParish.set(r.organization_id, p)
  }

  const out = []
  const now = Date.now()
  for (const [parishOrgId, { parish_name, periods }] of byParish) {
    const flags = []
    const latest = periods[periods.length - 1]

    // 1 — stale: nothing approved recently.
    const ageDays = Math.floor((now - Date.parse(latest.period_end)) / 86400000)
    if (ageDays > THRESHOLDS.staleDays) {
      flags.push({ code: 'quiet_period', detail: `The most recent approved period ended ${latest.period_end}, about ${ageDays} days ago.` })
    }

    // 2 — revenue decline vs the prior period.
    if (periods.length >= 2) {
      const prev = periods[periods.length - 2]
      const prevRev = Number(prev.revenue) || 0
      const curRev = Number(latest.revenue) || 0
      if (prevRev > 0 && curRev < prevRev * THRESHOLDS.declineRatio) {
        const pct = Math.round((1 - curRev / prevRev) * 100)
        flags.push({ code: 'revenue_lower', detail: `Revenue is ${pct}% lower than the previous period (${prev.period_end}: ${prevRev.toFixed(2)} → ${latest.period_end}: ${curRev.toFixed(2)}).` })
      }
    }

    // 3 — running a deficit: the most recent N periods all net-negative.
    if (periods.length >= THRESHOLDS.deficitStreak) {
      const recent = periods.slice(-THRESHOLDS.deficitStreak)
      if (recent.every(p => Number(p.net) < 0)) {
        flags.push({ code: 'spending_exceeds_income', detail: `Spending has exceeded income for ${THRESHOLDS.deficitStreak} periods running (latest net ${Number(latest.net).toFixed(2)}).` })
      }
    }

    if (flags.length) out.push({ parish_org_id: parishOrgId, parish_name, flags })
  }
  return out
}
