// Period totals (DIO.2) — the one computation both sides of the
// submission workflow share. The parish's live /api/finance/summary and
// the frozen totals_json inside a submission are produced by this same
// function, so "what the parish sees" and "what the diocese approves"
// can never be computed two different ways.

import pool from '../db.js'
import { EFFECTIVE_COA } from './effectiveCoa.js'


// → { groups, accounts, totals } — all amounts as fixed-2 strings.
export async function computePeriodTotals(orgId, start, end) {
  const { rows: accounts } = await pool.query(
    `SELECT c.code, c.name, c.acct_type, c.rollup_group, c.assessable,
            SUM(l.amount)::NUMERIC(12,2) AS total,
            COUNT(*)::INT AS entries
       FROM ochr_parish_ledger l
       JOIN (${EFFECTIVE_COA}) c ON c.code = l.account_code
      WHERE l.organization_id = $1
        AND l.entry_date >= $2 AND l.entry_date <= $3
      GROUP BY c.code, c.name, c.acct_type, c.rollup_group, c.assessable
      ORDER BY c.code`,
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

  return {
    groups,
    accounts: accounts.map(a => ({
      code: a.code, name: a.name, acct_type: a.acct_type,
      assessable: a.assessable, total: Number(a.total).toFixed(2),
    })),
    totals: {
      revenue: revenue.toFixed(2),
      expense: expense.toFixed(2),
      net: (revenue - expense).toFixed(2),
      assessable_base: assessableBase.toFixed(2),
    },
  }
}
