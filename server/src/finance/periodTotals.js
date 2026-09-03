// Period totals (DIO.2) — the one computation both sides of the
// submission workflow share. The parish's live /api/finance/summary and
// the frozen totals_json inside a submission are produced by this same
// function, so "what the parish sees" and "what the diocese approves"
// can never be computed two different ways.

import pool from '../db.js'
import { EFFECTIVE_COA } from './effectiveCoa.js'


// → { groups, accounts, totals } — all amounts as fixed-2 strings.
export async function computePeriodTotals(orgId, start, end) {
  // LEFT JOIN, not INNER — a ledger row whose account_code is not in the
  // parish's CURRENT effective chart must never be dropped from the money.
  // The import validates codes against the chart AT IMPORT TIME, but a code
  // can stop being effective afterwards: the diocese that defined it removes
  // or renames it, or the parish leaves the diocese entirely and the whole
  // diocesan layer of EFFECTIVE_COA disappears. Under the old INNER JOIN the
  // ledger rows on that code silently vanished — revenue, net and the
  // assessable base all fell, with no line, no error and no total to notice.
  // A parish's own books quietly lost real money, and the diocese billed on
  // a base it could not see was short.
  //
  // Such rows are now bucketed as 'unmapped': surfaced with their dollar
  // total (in `totals.unmapped` and their own account lines) so nothing
  // disappears, but deliberately NOT folded into revenue/expense or the
  // assessable base — without a chart row we cannot assert an unmapped code
  // is revenue rather than expense, or that it is assessable. Whether such
  // money is assessable, and to whom it belongs once an affiliation ends, is
  // a policy decision for the parish and chancery to make by MAPPING the
  // code; this function's job is only to stop the loss being silent.
  const { rows: accounts } = await pool.query(
    `SELECT l.account_code                       AS code,
            c.name                               AS name,
            COALESCE(c.acct_type, 'unmapped')    AS acct_type,
            COALESCE(c.rollup_group, 'unmapped') AS rollup_group,
            COALESCE(c.assessable, FALSE)        AS assessable,
            (c.code IS NULL)                     AS unmapped,
            SUM(l.amount)::NUMERIC(12,2)         AS total,
            COUNT(*)::INT                        AS entries
       FROM ochr_parish_ledger l
       LEFT JOIN (${EFFECTIVE_COA}) c ON c.code = l.account_code
      WHERE l.organization_id = $1
        AND l.entry_date >= $2 AND l.entry_date <= $3
      GROUP BY l.account_code, c.name, c.acct_type, c.rollup_group, c.assessable, (c.code IS NULL)
      ORDER BY l.account_code`,
    [orgId, start, end]
  )

  const groupMap = new Map()
  for (const a of accounts) {
    const key = `${a.acct_type}|${a.rollup_group}|${a.assessable}`
    const g = groupMap.get(key) ?? {
      acct_type: a.acct_type, rollup_group: a.rollup_group,
      assessable: a.assessable, total: 0, entries: 0,
    }
    g.total += Number(a.total) || 0
    g.entries += a.entries
    groupMap.set(key, g)
  }
  const groups = [...groupMap.values()]
    .sort((x, y) => x.acct_type.localeCompare(y.acct_type) || x.rollup_group.localeCompare(y.rollup_group))
    .map(g => ({ ...g, total: g.total.toFixed(2) }))

  const num = v => Number(v) || 0
  const revenue = accounts.filter(a => a.acct_type === 'revenue').reduce((s, a) => s + num(a.total), 0)
  const expense = accounts.filter(a => a.acct_type === 'expense').reduce((s, a) => s + num(a.total), 0)
  const assessableBase = accounts
    .filter(a => a.acct_type === 'revenue' && a.assessable)
    .reduce((s, a) => s + num(a.total), 0)
  // Money on a code the chart can no longer classify. Zero on a healthy
  // parish; non-zero is the visible signal that some entries need a code.
  const unmapped = accounts.filter(a => a.unmapped).reduce((s, a) => s + num(a.total), 0)

  return {
    groups,
    accounts: accounts.map(a => ({
      code: a.code, name: a.name ?? `Unmapped account (${a.code})`, acct_type: a.acct_type,
      assessable: a.assessable, unmapped: a.unmapped, total: Number(a.total).toFixed(2),
    })),
    totals: {
      revenue: revenue.toFixed(2),
      expense: expense.toFixed(2),
      net: (revenue - expense).toFixed(2),
      assessable_base: assessableBase.toFixed(2),
      unmapped: unmapped.toFixed(2),
    },
  }
}
