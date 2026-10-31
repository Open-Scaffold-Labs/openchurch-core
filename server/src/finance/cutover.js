// Cutover scoreboard (Restaurant-deck pattern, José 2026-10-25). Builds on
// the #413 side-by-side check: an old system's trial balance (account_code,
// amount — balances AS OF a date) against OpenChurch's live balances on the
// same date, on five lines a parish accountant reads every week.
//
// Honesty rules (UNKNOWN is never $0.00):
//  - any unreadable CSV row → every line is 'incomplete' with variance null,
//    because the skipped row could belong to any line;
//  - a line is 'missing' (variance null) unless EVERY active chart account
//    on it — zero-balance ones included — is listed in the old file. A
//    parish with no receivables lists 1210 at 0.00 to prove it;
//  - a line is 'match' only when EVERY account on it differs by 0 cents —
//    a signed sum that nets to zero is still a mismatch;
//  - cutover_ready only when all five lines are 'match'.
// READ-ONLY: nothing here writes the ledger.

import pool from '../db.js'
import { parseCSVToObjects, guardFormula } from '../utils/csv.js'
import { computePeriodTotals } from './periodTotals.js'
import { EFFECTIVE_COA } from './effectiveCoa.js'

const AMOUNT_RE = /^-?\d{1,9}(\.\d{1,2})?$/
const CODE_RE = /^\d{4}$/

export function toCents(v) {
  const t = String(v ?? '').trim().replace(/,/g, '')
  if (!AMOUNT_RE.test(t)) return null
  const neg = t.startsWith('-')
  const [w, f = ''] = t.replace('-', '').split('.')
  const c = Number(w) * 100 + Number((f + '00').slice(0, 2))
  return neg ? -c : c
}

// → { headerError } | { old: Map<code, cents>, errors: [{line, error}] }
export function parseOldTrialBalance(csv, { maxRows = 2000 } = {}) {
  const { headers, rows } = parseCSVToObjects(csv)
  for (const required of ['account_code', 'amount']) {
    if (!headers.includes(required)) return { headerError: `CSV must include a "${required}" column` }
  }
  if (rows.length > maxRows) return { headerError: `Checks are capped at ${maxRows} rows per file` }
  const old = new Map()
  const errors = []
  rows.forEach((row, i) => {
    const code = (row.account_code ?? '').trim()
    const cents = toCents(row.amount)
    if (!CODE_RE.test(code)) return errors.push({ line: i + 2, error: `Invalid account code "${code}"` })
    if (cents === null) return errors.push({ line: i + 2, error: `Invalid amount "${row.amount}" (use dollars with at most 2 decimals)` })
    old.set(code, (old.get(code) ?? 0) + cents)
  })
  return { old, errors }
}

// Per-account comparison of old vs live totals between start and end.
// A live total that does not parse is openchurch_cents: null (unreadable),
// never $0.00 (Atlas P2-2); any line holding one is 'incomplete'.
export async function compareAccounts(orgId, old, start, end, db = pool) {
  const live = await computePeriodTotals(orgId, start, end, db)
  const ours = new Map(live.accounts.map(a => [a.code, { name: a.name, cents: toCents(a.total) }]))
  const codes = [...new Set([...ours.keys(), ...old.keys()])].sort()
  return codes.map(code => {
    const oc = ours.has(code) ? ours.get(code).cents : 0
    const os = old.get(code) ?? 0
    return { code, name: ours.get(code)?.name ?? null, openchurch_cents: oc,
      old_system_cents: os, in_old_file: old.has(code), variance_cents: oc === null ? null : oc - os }
  })
}

// The Deposits line reads the Deferred rollup. That rollup holds 2210
// Deferred Revenue and, since migration 130, 2300 Deposits Held. Sign-offs
// snapshot the lines they scored, so changing this constant later does not
// rewrite a sign-off already recorded.
export const DEPOSITS_ROLLUP = 'Deferred'

export const SCOREBOARD_LINES = [
  { key: 'cash',          rollup: 'Cash & Bank' },
  { key: 'receivables',   rollup: 'Receivables' },
  { key: 'deposits',      rollup: DEPOSITS_ROLLUP },
  { key: 'payables',      rollup: 'Payables' },
  { key: 'trial_balance', rollup: null },          // every account
]

// Pure scoring (R414-2). `chart` is the effective chart [{code, rollup_group,
// active}]. A line EXPECTS every active chart account in its rollup (zero
// balance included) plus any account carrying a live balance; each must be
// listed explicitly in the old file or the line is 'missing' — an omitted
// account is never read as 0.00.
export function scoreLines(accounts, chart, errors) {
  const byCode = new Map(accounts.map(a => [a.code, a]))
  for (const c of chart) {
    if (c.active !== false && !byCode.has(c.code)) {
      const row = { code: c.code, name: c.name ?? null, openchurch_cents: 0, old_system_cents: 0, in_old_file: false, variance_cents: 0 }
      accounts.push(row); byCode.set(c.code, row)
    }
  }
  accounts.sort((x, y) => x.code.localeCompare(y.code))
  const chartOf = new Map(chart.map(c => [c.code, c]))
  for (const a of accounts) a.rollup_group = chartOf.get(a.code)?.rollup_group ?? null
  const expected = a => (chartOf.get(a.code) && chartOf.get(a.code).active !== false) || a.openchurch_cents !== 0

  const complete = errors.length === 0
  const lines = SCOREBOARD_LINES.map(({ key, rollup }) => {
    const on = rollup ? accounts.filter(a => a.rollup_group === rollup) : accounts
    const unreadable = on.some(a => a.openchurch_cents === null)
    const notInFile = on.filter(a => expected(a) && !a.in_old_file).map(a => a.code)
    const mismatched = on.filter(a => a.variance_cents !== 0).length
    let status
    if (!complete || unreadable) status = 'incomplete'
    else if (on.length === 0 || notInFile.length) status = 'missing'
    else status = mismatched === 0 ? 'match' : 'mismatch'
    const known = status === 'match' || status === 'mismatch'
    const sum = f => on.reduce((s, a) => s + a[f], 0)
    return {
      key, status, accounts: on.map(a => a.code), not_in_file: notInFile,
      mismatched_accounts: known ? mismatched : null,
      openchurch_cents: unreadable ? null : sum('openchurch_cents'),
      old_system_cents: known ? sum('old_system_cents') : null,
      variance_cents: known ? sum('variance_cents') : null,
    }
  })
  return { complete: complete && !accounts.some(a => a.openchurch_cents === null), lines }
}

export async function buildScoreboard(orgId, csv, asOf, db = pool) {
  const parsed = parseOldTrialBalance(csv)
  if (parsed.headerError) return { headerError: parsed.headerError }
  const { old, errors } = parsed
  const accounts = await compareAccounts(orgId, old, '1900-01-01', asOf, db)
  const { rows: chart } = await db.query(`SELECT code, name, rollup_group, active FROM (${EFFECTIVE_COA}) c`, [orgId])
  const { complete, lines } = scoreLines(accounts, chart, errors)
  return {
    as_of: asOf, basis: 'live', complete,
    cutover_ready: lines.every(l => l.status === 'match'),
    lines, accounts, errors,
  }
}

// Every active chart account, at 0.00, for the Day-1 template.
export async function templateCsv(orgId, db = pool) {
  const { rows } = await db.query(
    `SELECT code FROM (${EFFECTIVE_COA}) c WHERE c.active IS NOT FALSE ORDER BY code`, [orgId])
  return 'account_code,amount\r\n' + rows.map(r => `${r.code},0.00`).join('\r\n') + '\r\n'
}

const dollars = c => (c === null || c === undefined) ? 'UNKNOWN'
  : `${c < 0 ? '-' : ''}${Math.floor(Math.abs(c) / 100)}.${String(Math.abs(c) % 100).padStart(2, '0')}`
const cell = (v, num = false) => `"${guardFormula(v, { allowNumbers: num }).replace(/"/g, '""')}"`

// Accountant export: scoreboard then trial balance, one CSV. UNKNOWN, never 0.00.
export function scoreboardCsv(sb, { orgName = '' } = {}) {
  const out = []
  out.push(['OpenChurch cutover scoreboard', orgName].map(v => cell(v)).join(','))
  out.push(['as_of', sb.as_of].map(v => cell(v)).join(','))
  out.push(['complete', sb.complete ? 'yes' : 'no'].map(v => cell(v)).join(','))
  out.push(['cutover_ready', sb.cutover_ready ? 'yes' : 'no'].map(v => cell(v)).join(','))
  out.push('')
  out.push(['line', 'status', 'openchurch', 'old_system', 'variance', 'mismatched_accounts'].map(v => cell(v)).join(','))
  for (const l of sb.lines) {
    out.push([cell(l.key), cell(l.status), cell(dollars(l.openchurch_cents), true),
      cell(dollars(l.old_system_cents), true), cell(dollars(l.variance_cents), true),
      cell(l.mismatched_accounts === null ? 'UNKNOWN' : String(l.mismatched_accounts), true)].join(','))
  }
  out.push('')
  out.push(['account_code', 'name', 'rollup_group', 'openchurch', 'old_system', 'variance', 'in_old_file'].map(v => cell(v)).join(','))
  for (const a of sb.accounts) {
    const known = sb.complete
    out.push([cell(a.code), cell(a.name ?? ''), cell(a.rollup_group ?? 'not in chart'),
      cell(dollars(a.openchurch_cents), true),
      cell(known && a.in_old_file ? dollars(a.old_system_cents) : 'UNKNOWN', true),
      cell(known && a.in_old_file ? dollars(a.variance_cents) : 'UNKNOWN', true),
      cell(a.in_old_file ? 'yes' : 'no')].join(','))
  }
  if (sb.errors.length) {
    out.push('')
    out.push(['unreadable_line', 'error'].map(v => cell(v)).join(','))
    for (const e of sb.errors) out.push([cell(String(e.line), true), cell(e.error)].join(','))
  }
  return out.join('\r\n') + '\r\n'
}
