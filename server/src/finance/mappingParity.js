// Compare two ledger snapshots. The migration aborts when they differ.
// Rows are keyed by org, month (when given), and account, so a move from
// one month to another is a difference even when the account total is the
// same. Amounts stay strings so a cent is not lost to a float.

export function ledgerTotalsDiffer(before, after) {
  const key = row => `${row.organization_id}|${row.month ?? ''}|${row.account_code ?? ''}`
  const prior = new Map(before.map(row => [key(row), String(row.total)]))
  const seen = new Set()
  for (const row of after) {
    const id = key(row)
    seen.add(id)
    if (!prior.has(id) || prior.get(id) !== String(row.total)) return true
  }
  for (const id of prior.keys()) if (!seen.has(id)) return true
  return false
}
