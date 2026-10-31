// Cutover sign-off ↔ finance writer coordination (R414-1, Atlas P1-3/P2-7).
//
// Two advisory-lock namespaces, transaction-scoped only:
//   FINANCE_LOCK_NS (org)    — an org's own finance data (ledger, donations,
//                              refunds, COA mappings, its own COA rows,
//                              payroll, its diocese affiliation).
//                              Writers SHARED · sign-off EXCLUSIVE.
//   CHART_LOCK_NS   (owner)  — a chart layer another parish inherits:
//                              owner 0 = global template, owner D = the
//                              diocese's chart rows.
//                              Chart writers EXCLUSIVE · sign-off SHARED.
//
// Deadlock freedom (why no PG lock-wait cycle can form):
//  1. Nobody enters Postgres' advisory lock queue. Every acquisition is
//     pg_try_advisory_xact_lock*; waiting is a bounded poll (writers: the
//     session lock_timeout, else 10 s; sign-off: SIGNOFF_LOCK_BUDGET_MS),
//     ending in SQLSTATE 55P03 — never an unbounded wait.
//  2. The sign-off is all-or-nothing: it takes its keys in one sorted order
//     inside a SAVEPOINT and, if any key is busy, rolls back to the
//     savepoint (releasing every key it got) before sleeping. It therefore
//     never holds a key while waiting, so it can never be the middle of a
//     cycle; a writer waiting on it waits only for its recompute+INSERT.
//  3. Data writers only ever take SHARED keys, which are mutually
//     compatible, so data writers never wait on each other here. Only chart
//     writers (template / diocesan COA rows: rare admin edits) take an
//     EXCLUSIVE key; they wait only on sign-offs or another chart edit of
//     the same layer, both bounded by (1).
//  3a. R414-3: a COA row takes exactly one key by owner — template →
//     (CHART, 0) excl; diocese D → (CHART, D) excl; parish P → (FINANCE, P)
//     shared. A diocesan chart writer therefore holds no FINANCE key at all,
//     so a parish sign-off (FINANCE P excl + CHART 0/D/P shared) and a
//     diocesan edit can only meet on (CHART, D), where neither waits while
//     holding: the sign-off backs off fully (2), the writer polls bounded (1).
//     Row locks the writer already holds cannot close a cycle because the
//     sign-off takes no row locks (it only reads, MVCC) before its INSERT.
//  4. A writer that touches several keys in one row (org move, payroll
//     shift) takes them in ascending (ns, key) order (trigger helper).
//
// Nothing here moves money or writes the ledger.

export const FINANCE_LOCK_NS = 41429
export const CHART_LOCK_NS = 41430
export const TEMPLATE_CHART_OWNER = 0
export const SIGNOFF_LOCK_BUDGET_MS = 2000

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function activeDiocese(client, orgId) {
  const { rows: [r] } = await client.query(
    `SELECT diocese_org_id FROM ochr_diocese_affiliations
      WHERE parish_org_id = $1 AND status = 'active' LIMIT 1`, [orgId])
  return r?.diocese_org_id ?? null
}

// Sorted key list a sign-off for orgId needs, given its active diocese.
export function signoffKeys(orgId, dioceseOrgId) {
  const keys = [
    { ns: FINANCE_LOCK_NS, key: orgId, exclusive: true },
    { ns: CHART_LOCK_NS, key: TEMPLATE_CHART_OWNER, exclusive: false },
    // R414-3: its own chart layer too, so a diocese's own sign-off excludes
    // edits of the diocesan chart (which take only (CHART, D)). Harmless for a
    // parish: parish COA rows take (FINANCE, P), never (CHART, P).
    { ns: CHART_LOCK_NS, key: orgId, exclusive: false },
  ]
  if (dioceseOrgId != null && dioceseOrgId !== orgId) keys.push({ ns: CHART_LOCK_NS, key: dioceseOrgId, exclusive: false })
  return keys.sort((a, b) => a.ns - b.ns || a.key - b.key)
}

// Inside an open transaction on `client`. Returns { ok: true, keys,
// dioceseOrgId } holding every key, or { ok: false } having released all of
// them (budget exhausted). Re-reads the affiliation under the lock so a
// diocese change between the first read and the lock is never missed.
export async function acquireSignoffLocks(client, orgId, { budgetMs = SIGNOFF_LOCK_BUDGET_MS } = {}) {
  const deadline = Date.now() + budgetMs
  for (let attempt = 0; ; attempt++) {
    const diocese = await activeDiocese(client, orgId)
    const keys = signoffKeys(orgId, diocese)
    await client.query('SAVEPOINT cutover_locks')
    let all = true
    for (const k of keys) {
      const fn = k.exclusive ? 'pg_try_advisory_xact_lock' : 'pg_try_advisory_xact_lock_shared'
      const { rows: [r] } = await client.query(`SELECT ${fn}($1, $2) AS ok`, [k.ns, k.key])
      if (!r.ok) { all = false; break }
    }
    // FINANCE_LOCK_NS(org) is held exclusively now, so the affiliation (whose
    // writers take it SHARED) cannot change until we commit.
    if (all && (await activeDiocese(client, orgId)) === diocese) {
      await client.query('RELEASE SAVEPOINT cutover_locks')
      return { ok: true, keys, dioceseOrgId: diocese, attempts: attempt + 1 }
    }
    await client.query('ROLLBACK TO SAVEPOINT cutover_locks')   // drops every key taken above
    await client.query('RELEASE SAVEPOINT cutover_locks')
    if (Date.now() >= deadline) return { ok: false, attempts: attempt + 1 }
    await sleep(Math.min(25 * 2 ** Math.min(attempt, 3), 200))
  }
}
