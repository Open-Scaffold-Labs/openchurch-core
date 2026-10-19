// Shared SELECT/JOIN fragments for OPEN vs APPLIED period adjustments.
//
// totals_json on a submission is the approved archival gross. OPEN
// adjustments are unresolved conditions (099). APPLIED credits are the
// M4 economic effect (106). payable_base subtracts freeze-time
// assessable_impact (107), not the raw refund. A list that ships
// frozen totals without these columns lets every renderer imply the
// figures already net later refunds. They do not.

export const PERIOD_ADJUSTMENT_LIST_COLS = `
              COALESCE(adj.open_count, 0)     AS open_adjustment_count,
              COALESCE(adj.open_amount, 0)    AS open_adjustment_amount,
              COALESCE(cred.applied_count, 0) AS applied_credit_count,
              COALESCE(cred.applied_amount, 0) AS applied_credit_amount,
              GREATEST(
                COALESCE((s.totals_json->'totals'->>'assessable_base')::NUMERIC, 0)
                - COALESCE(cred.applied_assessable, 0),
                0
              ) AS payable_base`

export const PERIOD_ADJUSTMENT_LIST_JOINS = `
         LEFT JOIN (
                SELECT submission_id,
                       count(*) FILTER (WHERE resolved_at IS NULL) AS open_count,
                       COALESCE(sum(amount) FILTER (WHERE resolved_at IS NULL), 0) AS open_amount
                  FROM ochr_period_adjustments
                 GROUP BY submission_id
              ) adj ON adj.submission_id = s.id
         LEFT JOIN (
                SELECT submission_id, organization_id,
                       count(*) AS applied_count,
                       COALESCE(sum(amount), 0) AS applied_amount,
                       COALESCE(sum(assessable_impact), 0) AS applied_assessable
                  FROM ochr_period_adjustment_credits
                 GROUP BY submission_id, organization_id
              ) cred ON cred.submission_id = s.id
                    AND cred.organization_id = s.organization_id`
