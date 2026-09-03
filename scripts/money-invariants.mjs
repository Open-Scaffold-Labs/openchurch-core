#!/usr/bin/env node
// Every SQL statement that AGGREGATES ochr_donations must exclude refunded
// gifts, or say in one line why it doesn't.
//
// This exists because of how the refund bug actually happened. Nobody was
// careless. The predicate was added each time somebody noticed it missing, in
// the query they happened to be looking at — nine times correctly. It was
// missing from five, and the five included both documents that leave the
// building: the donor's year-end tax statement and the diocesan assessable
// base. A parish was assessed on money it had given back.
//
// A sweep finds instances. This finds the CLASS: any new aggregate over
// donations has to make a decision about refunds before it can be committed.
//
// Deliberate exceptions go in EXPECTED below WITH A REASON. That is the
// point — an exception is a sentence somebody had to write, not a silent gap.
//
// Usage:  node scripts/money-invariants.mjs [--list]

import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOTS = ['server/src']
// Migrations are excluded from the AGGREGATE scan (they create tables and
// backfill; they do not report money) — with one exception handled separately
// below, because excluding them wholesale left the scanner blind to the exact
// number its own header calls out.
const SKIP_DIRS = new Set(['migrations'])

// The assessable base does not read ochr_donations at all. It sums
// ochr_parish_ledger (finance/periodTotals.js), and that view's donation
// branch lives in a migration — so BOTH ends of that path fell outside the
// scan: the reader has no `ochr_donations` to match on, and the view has no
// SUM. A parish being assessed on money it gave back was one of the two
// findings that caused this file to exist, and the first version of it could
// not have caught that finding. This check closes it: whatever migration
// currently defines the view must carry the predicate.
const LEDGER_VIEW_SOURCES = [
  'server/src/migrations/090-ledger-excludes-refunds.js',
]
const PREDICATE = /payment_status\s+IS\s+DISTINCT\s+FROM\s+'refunded'/i
const AGGREGATE = /\b(SUM|COUNT|AVG|MAX|MIN)\s*\(/i

// Selecting `amount` and adding it up in JavaScript is the same money
// question asked without a SQL aggregate — and until 27 Aug this scanner
// could not see it.
//
// An auditor removed the refund predicate from GET /api/giving-statements/
// donor — the route that prints the year-end letter a donor files with a tax
// return — and BOTH guards stayed green: this scanner found no SUM/COUNT to
// match, and the behavioural test asserted /preview rather than /donor. A
// refunded gift would have printed at full value. That is the exact defect
// migration 090 exists to prevent, in the one document where it matters most.
//
// So: any statement that pulls `amount` off ochr_donations is a money
// statement, aggregate or not.
const AMOUNT_SELECT = /\bSELECT\b[\s\S]*?\bamount\b[\s\S]*?\bFROM\s+ochr_donations\b/i

// Queries that legitimately count refunded gifts, each with the reason.
// A new entry here is a claim somebody is making on the record.
// Each exception is matched against the SQL ITSELF, not against nearby
// comments — an exception that depends on a comment staying put next to a
// query is an exception that silently widens when somebody reorders a file.
const EXPECTED = [
  {
    file: 'server/src/routes/donations.js',
    // Surfaced 27 Aug by the widened matcher.
    match: /SELECT\s+id,\s*source,\s*amount,\s*payment_ref,\s*payment_status[\s\S]*?FROM\s+ochr_donations\b/i,
    why: 'This is the refund handler reading the gift it is about to refund. '
       + 'It MUST see refunded rows — that read is how "already refunded" is '
       + 'detected and turned into a 409. Excluding them would make a double '
       + 'refund look like a missing gift.',
  },
  {
    file: 'server/src/routes/imports.js',
    // Surfaced 27 Aug by the widened matcher.
    match: /SELECT\s+d\.donor_name[\s\S]*?FROM\s+ochr_donations\s+d[\s\S]*?unnest/i,
    why: 'Import duplicate detection: "does a gift with this donor, date and '
       + 'amount already exist?" A refunded gift still EXISTS as a record, so '
       + 'hiding it here would let the same gift be imported a second time. '
       + 'This asks whether a row is present, not how much was given.',
  },
  {
    file: 'server/src/routes/search.js',
    // Surfaced 27 Aug when the scanner learned to see JS-side amount reads.
    match: /SELECT\s+id,\s*donor_name,\s*amount[\s\S]*?FROM\s+ochr_donations\b[\s\S]*?search_vec/i,
    why: 'Global search is a LOOKUP, not a total. Nothing sums these rows — '
       + 'GlobalSearchPalette groups them by type for display. Excluding '
       + 'refunded gifts here would make a refunded gift unfindable, which is '
       + 'worse than showing it: the person searching is usually looking for '
       + 'the refund. If this ever feeds a total, the exception must go.',
  },
  {
    file: 'server/src/routes/onboarding.js',
    // Anchored: COUNT(*) must be the ONLY aggregate in the statement. The
    // first version used [\s\S]* between the tokens, so adding SUM(amount)
    // to this very query would still have matched — a money aggregate riding
    // an exception whose written reason is "it asks whether rows EXIST".
    match: /^\s*SELECT\s+COUNT\(\*\)::int\s+AS\s+n\s+FROM\s+ochr_donations\b[^()]*notes\s+LIKE/i,
    why: 'Counts rows carrying the sample-data prefix to answer "does this org '
       + 'still have demo data on it". It asks whether rows EXIST, not how much '
       + 'was given. A refunded sample gift is still sample data — excluding it '
       + 'would hide the cleanup banner while the demo rows are still there.',
  },
  {
    file: 'server/src/routes/funds.js',
    // Surfaced 1 Sep by the fund-delete guard. Anchored the same way as the
    // onboarding entry: COUNT(*) must be the only aggregate, and the WHERE
    // must be the fund reference and nothing else.
    match: /^\s*SELECT\s+COUNT\(\*\)::int\s+AS\s+n\s+FROM\s+ochr_donations\s+WHERE\s+fund_id\s*=\s*\$1\s+AND\s+organization_id\s*=\s*\$2\s*$/i,
    why: 'The guard that refuses DELETE /api/funds/:id while gifts still point '
       + 'at the fund (ON DELETE SET NULL would re-bucket them into the '
       + 'assessable default account). It asks whether rows REFERENCE the '
       + 'fund, not how much was given, and a refunded gift still references '
       + 'it — its row is the trace of the refund and carries the designation. '
       + 'Excluding refunds would let a fund with only refunded gifts be '
       + 'deleted and strip the designation from those traces.',
  },
]

// A floor, not the count. This exists
// so a matcher that stops working reports loudly instead of reporting green.
// Set below the true count on purpose — pinned exactly to it, deleting a
// single legitimate aggregate fires "the matcher is broken", which trains
// people to ignore it.
const MIN_EXPECTED_AGGREGATES = 6

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) { if (!SKIP_DIRS.has(e)) walk(p, out) }
    else if (p.endsWith('.js')) out.push(p)
  }
  return out
}

// Pull SQL out of a source file. Every query in this codebase is a template
// literal today; the quoted-string matchers are here for the day one is not,
// and they currently match nothing. That is worth stating rather than
// implying: an earlier version of this comment claimed they had recovered
// twenty-two missed aggregates, which was wrong — I had assumed a gap rather
// than measuring one. The count below is measured.
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

const findings = []
let scanned = 0

for (const root of ROOTS) {
  for (const file of walk(root)) {
    const src = readFileSync(file, 'utf8')
    if (!src.includes('ochr_donations')) continue
    for (const { body, line } of sqlBlocks(src)) {
      if (!/ochr_donations/i.test(body)) continue
      const isAggregate = AGGREGATE.test(body)
      const isAmountRead = AMOUNT_SELECT.test(body)
      if (!isAggregate && !isAmountRead) continue
      scanned++
      if (PREDICATE.test(body)) continue
      // An exception covers one query shape in one file. A NEW aggregate in
      // the same file is not covered by an old exception.
      if (EXPECTED.some(e => e.file === file && e.match.test(body))) continue
      findings.push({ file, line, sql: body.replace(/\s+/g, ' ').trim().slice(0, 110) })
    }
  }
}

// A scan that finds nothing to check is not a passing scan.
if (scanned < MIN_EXPECTED_AGGREGATES) {
  console.error(`money-invariants: only ${scanned} donation aggregates found, expected at least ${MIN_EXPECTED_AGGREGATES} — the matcher is broken, or aggregates were removed.`)
  process.exit(2)
}

// The ledger view, checked by name rather than by aggregate shape.
for (const file of LEDGER_VIEW_SOURCES) {
  let src
  try { src = readFileSync(file, 'utf8') }
  catch { findings.push({ file, line: 0, sql: 'MISSING — the ledger view source named here does not exist' }); continue }
  // Test the VIEW BODY, not the file. The first version of this check tested
  // the whole source and always passed, because 090 mentions the predicate in
  // its own header comment and again in its self-assertion — so deleting the
  // predicate from the actual SQL left the scanner green. A check that its
  // own subject can satisfy by talking about itself is not a check.
  const view = src.match(/CREATE\s+OR\s+REPLACE\s+VIEW\s+ochr_parish_ledger\b[\s\S]*?`/i)
  if (!view) {
    findings.push({ file, line: 0, sql: 'does not define ochr_parish_ledger — has the view moved to a later migration?' })
    continue
  }
  // The donation branch specifically: from ochr_donations to the next UNION.
  const branch = view[0].match(/FROM\s+ochr_donations\b[\s\S]*?(?=UNION\s+ALL|$)/i)
  if (!branch || !PREDICATE.test(branch[0])) {
    findings.push({ file, line: 0, sql: "ochr_parish_ledger's donation branch counts refunded gifts — this feeds the diocesan assessable base" })
  }
}

if (process.argv.includes('--list')) {
  console.log(`${scanned} donation aggregates scanned.`)
}

if (findings.length) {
  console.error(`\nmoney-invariants: ${findings.length} donation aggregate(s) count refunded gifts.\n`)
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}`)
    console.error(`    ${f.sql}\n`)
  }
  console.error(`Add   AND payment_status IS DISTINCT FROM 'refunded'`)
  console.error(`or, if it genuinely should count refunds, add it to EXPECTED in`)
  console.error(`scripts/money-invariants.mjs with the reason.\n`)
  process.exit(1)
}

console.log(`money-invariants: ${scanned} donation aggregates, all exclude refunded gifts.`)
