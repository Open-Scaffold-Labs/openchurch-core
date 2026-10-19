// Per-gift assessable facts at freeze (GIV-08-004).
//
// Frozen assessable_base is the sum of revenue on accounts marked
// assessable=true. A later refund's raw amount is not that figure: a
// restricted gift was never in the base. The mapping and the diocesan
// assessable flag can change after freeze, so the bill must not look
// them up again. This map is the historical source — written into
// totals_json in the same REPEATABLE READ snapshot as the totals, then
// copied onto the period adjustment as assessable_impact.
//
// A missing map, or a gift that is not in it, is UNKNOWN — not false.
// UNKNOWN cannot be COALESCE'd to a 0 impact. Live /api/finance/summary
// does not carry this map. It is freeze-only.

import pool from '../db.js'
import { EFFECTIVE_COA } from './effectiveCoa.js'

// Three-valued read of a freeze stamp. Does not look at live COA.
export function assessableImpactFromFreeze(map, donationId, amount) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    return { known: false, impact: null }
  }
  const entry = map[String(donationId)]
  if (!entry || typeof entry !== 'object' || typeof entry.assessable !== 'boolean') {
    return { known: false, impact: null }
  }
  const n = Number(amount)
  return { known: true, impact: entry.assessable === true ? n : 0 }
}

export async function giftAssessableAtFreeze(orgId, start, end, db = pool) {
  const { rows } = await db.query(
    `SELECT l.source_id                        AS donation_id,
            l.amount                           AS amount,
            l.account_code                     AS account_code,
            COALESCE(c.acct_type, 'unmapped')  AS acct_type,
            COALESCE(c.assessable, FALSE)      AS assessable
       FROM ochr_parish_ledger l
       LEFT JOIN (${EFFECTIVE_COA}) c ON c.code = l.account_code
      WHERE l.organization_id = $1
        AND l.entry_date >= $2 AND l.entry_date <= $3
        AND l.source_type = 'donation'`,
    [orgId, start, end]
  )
  const map = {}
  for (const r of rows) {
    map[String(r.donation_id)] = {
      amount: Number(r.amount).toFixed(2),
      account_code: r.account_code,
      assessable: r.acct_type === 'revenue' && r.assessable === true,
    }
  }
  return map
}
