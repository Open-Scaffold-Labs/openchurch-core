#!/usr/bin/env node
// GIV-06 Atlas OPTION A — live money invariants.
//
// CLAIM. A refund is a new linked financial fact. $100 gift + $30 refund ≠
// $70 gift. Live contribution is gift.amount − Σ(posted refunds). The gift
// stays in the books, including when that net is 0. gift.amount is never
// rewritten. ochr_period_adjustments kind=refund is the freeze sidecar only
// — it must never be added into live net.
//
// This used to require every aggregate to omit payment_status='refunded'.
// That predicate is now the defect: it hides the gift and cannot represent
// a partial. A new aggregate over donations has to make an Option A
// decision before it can be committed.
//
// Deliberate exceptions go in EXPECTED below WITH A REASON. That is the
// point — an exception is a sentence somebody had to write, not a silent gap.
//
// Usage:  node scripts/money-invariants.mjs [--list]

import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOTS = ['server/src']
const SKIP_DIRS = new Set(['migrations'])

// The assessable base sums ochr_parish_ledger (finance/periodTotals.js).
// The view's donation + refund branches live in a migration, so BOTH ends
// of that path would otherwise fall outside the scan. Whatever migration
// currently defines the view must keep the gift and subtract posted refunds.
const LEDGER_VIEW_SOURCES = [
  'server/src/migrations/104-donation-refund-facts.js',
]

const OMIT = /payment_status\s+IS\s+DISTINCT\s+FROM\s+'refunded'/i
const AGGREGATE = /\b(SUM|COUNT|AVG|MAX|MIN)\s*\(/i
const AMOUNT_SELECT = /\bSELECT\b[\s\S]*?\bamount\b[\s\S]*?\bFROM\s+ochr_donations\b/i
const LIVE_NET = /\blive_amount\b|ochr_donation_live|ochr_donation_refunds|ochr_posted_refunds/i
const PERIOD_ADJUSTMENTS_IN_LIVE = /ochr_period_adjustments/i

// Queries that legitimately read ochr_donations without computing live net,
// each with the reason. Matched against the SQL itself.
const EXPECTED = [
  {
    file: 'server/src/routes/donations.js',
    match: /SELECT\s+id,\s*source,\s*amount,\s*payment_ref,\s*payment_status[\s\S]*?FROM\s+ochr_donations\b/i,
    why: 'Refund handler peeking the gift it is about to refund. It MUST see '
       + 'refunded rows — that read is how a missing gift becomes 404 and how '
       + 'the remaining balance is computed. It is not a live total.',
  },
  {
    file: 'server/src/finance/donationRefunds.js',
    match: /SELECT\s+id,\s*source,\s*amount[\s\S]*?FROM\s+ochr_donations[\s\S]*?FOR UPDATE/i,
    why: 'Write-path lock of the gift being refunded. Reads gift.amount as the '
       + 'cap, not as a contribution total.',
  },
  {
    file: 'server/src/routes/imports.js',
    match: /SELECT\s+d\.donor_name[\s\S]*?FROM\s+ochr_donations\s+d[\s\S]*?unnest/i,
    why: 'Import duplicate detection: "does a gift with this donor, date and '
       + 'amount already exist?" A refunded gift still EXISTS as a record, so '
       + 'hiding it here would let the same gift be imported a second time. '
       + 'This asks whether a row is present, not how much was given.',
  },
  {
    file: 'server/src/routes/search.js',
    match: /SELECT\s+id,\s*donor_name,\s*amount[\s\S]*?FROM\s+ochr_donations\b[\s\S]*?search_vec/i,
    why: 'Global search is a LOOKUP, not a total. Nothing sums these rows. '
       + 'Excluding refunded gifts here would make a refunded gift unfindable.',
  },
  {
    file: 'server/src/routes/onboarding.js',
    match: /^\s*SELECT\s+COUNT\(\*\)::int\s+AS\s+n\s+FROM\s+ochr_donations\b[^()]*notes\s+LIKE/i,
    why: 'Counts rows carrying the sample-data prefix to answer "does this org '
       + 'still have demo data on it". It asks whether rows EXIST, not how much '
       + 'was given.',
  },
  {
    file: 'server/src/routes/funds.js',
    match: /^\s*SELECT\s+COUNT\(\*\)::int\s+AS\s+n\s+FROM\s+ochr_donations\s+WHERE\s+fund_id\s*=\s*\$1\s+AND\s+organization_id\s*=\s*\$2\s*$/i,
    why: 'The guard that refuses DELETE /api/funds/:id while gifts still point '
       + 'at the fund. It asks whether rows REFERENCE the fund, not how much '
       + 'was given, and a refunded gift still references it.',
  },
  {
    file: 'server/src/routes/donations.js',
    match: /SELECT\s+payment_ref,\s*payment_status\s+FROM\s+ochr_donations/i,
    why: 'Charged-gift delete guard. Reads whether a provider charge exists, '
       + 'not a contribution total.',
  },
]

const MIN_EXPECTED_AGGREGATES = 6

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) { if (!SKIP_DIRS.has(e)) walk(p, out) }
    else if (p.endsWith('.js')) out.push(p)
  }
  return out
}

function sqlBlocks(src) {
  const out = []
  const push = (body, index) => {
    if (!/\bFROM\b|\bJOIN\b/i.test(body)) return
    out.push({ body, line: src.slice(0, index).split('\n').length })
  }
  for (const m of src.matchAll(/`([^`]*)`/g))        push(m[1], m.index)
  for (const m of src.matchAll(/'((?:[^'\\\n]|\\.){20,})'/g)) push(m[1], m.index)
  for (const m of src.matchAll(/"((?:[^"\\\n]|\\.){20,})"/g)) push(m[1], m.index)
  return out
}

function isExpected(file, body) {
  return EXPECTED.some(e => e.file === file && e.match.test(body))
}

const findings = []
let scanned = 0

for (const root of ROOTS) {
  for (const file of walk(root)) {
    const src = readFileSync(file, 'utf8')
    if (!src.includes('ochr_donations') && !src.includes('ochr_donation_live')) continue
    for (const { body, line } of sqlBlocks(src)) {
      const touchesDonations = /ochr_donations|ochr_donation_live/i.test(body)
      if (!touchesDonations) continue
      const isAggregate = AGGREGATE.test(body)
      const isAmountRead = AMOUNT_SELECT.test(body)
      if (!isAggregate && !isAmountRead) continue
      scanned++
      if (isExpected(file, body)) continue

      if (PERIOD_ADJUSTMENTS_IN_LIVE.test(body) && /ochr_donation/i.test(body) && isAggregate) {
        findings.push({
          file, line,
          sql: body.replace(/\s+/g, ' ').trim().slice(0, 110),
          why: 'period adjustments folded into a live donation aggregate — they are the freeze sidecar only',
        })
        continue
      }

      if (OMIT.test(body)) {
        findings.push({
          file, line,
          sql: body.replace(/\s+/g, ' ').trim().slice(0, 110),
          why: "omits payment_status='refunded' — Option A keeps the gift and subtracts posted refunds",
        })
        continue
      }

      // Live money must use the dual-read view / live_amount, or explicitly
      // subtract posted refunds. A raw SUM(amount) FROM ochr_donations is
      // the $100+$30=$70 collapse.
      const readsGrossFromDonations = /ochr_donations/i.test(body) && !LIVE_NET.test(body)
      if (readsGrossFromDonations && isAggregate && /\bSUM\s*\(\s*(?:d\.)?amount\s*\)/i.test(body)) {
        findings.push({
          file, line,
          sql: body.replace(/\s+/g, ' ').trim().slice(0, 110),
          why: 'SUM(amount) over ochr_donations without subtracting posted refunds',
        })
      }
    }
  }
}

if (scanned < MIN_EXPECTED_AGGREGATES) {
  console.error(`money-invariants: only ${scanned} donation aggregates found, expected at least ${MIN_EXPECTED_AGGREGATES} — the matcher is broken, or aggregates were removed.`)
  process.exit(2)
}

for (const file of LEDGER_VIEW_SOURCES) {
  let src
  try { src = readFileSync(file, 'utf8') }
  catch { findings.push({ file, line: 0, sql: 'MISSING — the ledger view source named here does not exist', why: 'view source missing' }); continue }
  const view = src.match(/CREATE\s+OR\s+REPLACE\s+VIEW\s+ochr_parish_ledger\b[\s\S]*?`/i)
  if (!view) {
    findings.push({ file, line: 0, sql: 'does not define ochr_parish_ledger — has the view moved to a later migration?', why: 'view missing' })
    continue
  }
  if (/payment_status\s+IS\s+DISTINCT\s+FROM\s+'refunded'/i.test(view[0])) {
    findings.push({ file, line: 0, sql: "ochr_parish_ledger still omits stamped refunds", why: 'omit predicate in live ledger' })
  }
  if (!/donation_refund/.test(view[0]) || !/ochr_donation_refunds/.test(view[0])) {
    findings.push({ file, line: 0, sql: "ochr_parish_ledger is missing the posted-refund fact branch", why: 'refund facts absent from ledger' })
  }
  if (/ochr_period_adjustments/.test(view[0])) {
    findings.push({ file, line: 0, sql: 'ochr_parish_ledger folds period adjustments into live net', why: 'sidecar in live books' })
  }
}

if (process.argv.includes('--list')) {
  console.log(`${scanned} donation aggregates scanned.`)
}

if (findings.length) {
  console.error(`\nmoney-invariants: ${findings.length} Option A violation(s).\n`)
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}`)
    console.error(`    ${f.sql}`)
    console.error(`    ${f.why}\n`)
  }
  console.error(`Live contribution is gift.amount − Σ(posted refunds).`)
  console.error(`Use ochr_donation_live.live_amount, or add the query to EXPECTED with the reason.\n`)
  process.exit(1)
}

console.log(`money-invariants: ${scanned} donation aggregates, Option A (gift − Σ posted refunds).`)
