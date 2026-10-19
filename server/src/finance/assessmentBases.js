// Per-parish assessable base for a calendar year (M4).
//
// The archival figure is the SUM of assessable_base on APPROVED
// submissions whose period_end falls in the BASE year. The payable
// figure — what computeBases returns as `base` — subtracts the
// freeze-time assessable_impact of APPLIED credits, not the raw
// refund amount. OPEN adjustments do not move the bill. totals_json
// is not rewritten.
//
// `db` is the pool or an open-transaction client — publish passes its
// client so the bases it checks are read under the lock it holds.

import pool from '../db.js'
import { endsInYear } from './fiscalPeriod.js'

const money = v => (Math.round(Number(v) * 100) / 100).toFixed(2)

export async function computeBases(dioceseOrgId, year, db = pool) {
  const { rows } = await db.query(
    `SELECT s.organization_id AS parish_org_id,
            GREATEST(
              COALESCE(SUM((s.totals_json->'totals'->>'assessable_base')::NUMERIC), 0)
              - COALESCE(SUM(cred.applied), 0),
              0
            )::NUMERIC(12,2) AS base,
            COALESCE(SUM((s.totals_json->'totals'->>'assessable_base')::NUMERIC), 0)
              ::NUMERIC(12,2) AS approved_gross,
            COALESCE(SUM(cred.applied), 0)::NUMERIC(12,2) AS applied_credits
       FROM ochr_report_submissions s
       JOIN ochr_diocese_affiliations a
         ON a.parish_org_id = s.organization_id
        AND a.diocese_org_id = s.diocese_org_id
        AND a.status IN ('active', 'suspended')
       LEFT JOIN (
         SELECT c.submission_id, c.organization_id,
                SUM(c.assessable_impact) AS applied
           FROM ochr_period_adjustment_credits c
          GROUP BY c.submission_id, c.organization_id
       ) cred ON cred.submission_id = s.id
             AND cred.organization_id = s.organization_id
      WHERE s.diocese_org_id = $1 AND s.status = 'approved'
        AND ${endsInYear('$2')}
      GROUP BY s.organization_id`,
    [dioceseOrgId, year]
  )
  return rows
}

export function payableFromApproved(approvedGross, appliedCredits) {
  const gross = Number(approvedGross) || 0
  const credits = Number(appliedCredits) || 0
  return money(Math.max(gross - credits, 0))
}
