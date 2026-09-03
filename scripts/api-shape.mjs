// api-shape — a database row is not an API response.
//
// THE INVARIANT: no route may return `*` from a table that carries a column
// the API does not mean to publish.
//
// WHY. On 27 Aug `POST /api/donations` returned `search_vec` — the GENERATED
// tsvector, i.e. the stemmed tokens of donor_name, category and NOTES, which
// is pastoral free text. The route used `RETURNING *`. Twelve lines above it,
// the same file declared DONATION_PUBLIC_COLUMNS and the list endpoint used
// it correctly. The contract existed; the write paths bypassed it. Create
// returned 18 fields, list returned 17, and both claimed to describe a
// donation.
//
// Nothing was "wrong" when those queries were written — ochr_donations had no
// internal columns then. A later migration added the tsvector and every
// `RETURNING *` in the codebase silently started shipping it. That is the
// failure mode this guards: not a bad line, but a line that becomes bad.
//
// WHAT IT FLAGS, and why it is narrow: `SELECT *` / `RETURNING *` against a
// table the migrations show has a GENERATED column or a tsvector. Tables with
// no internal columns are NOT flagged — ochr_pledges uses `RETURNING *` and
// leaks nothing, and turning that into a style rule would spend attention
// without buying safety. The moment such a table gains a generated column,
// this gate starts failing on it, which is exactly when it should.
//
// This is defence in depth. The primary protection is the behavioural test
// in smoke.test.js that pins the response keys exactly.
//
// Runs in CI with no database. Exit 1 on any violation.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOTS = ['server/src/routes']
const MIGRATIONS = 'server/src/migrations'
const BASE = 'server/src/migrate.js'

// Tables with a column the API should never publish by accident.
function tablesWithInternalColumns() {
  const out = new Map()   // table -> [column, ...]
  let src = readFileSync(BASE, 'utf8')
  for (const f of readdirSync(MIGRATIONS).filter(f => f.endsWith('.js'))) {
    src += '\n' + readFileSync(join(MIGRATIONS, f), 'utf8')
  }
  // ALTER TABLE x ADD COLUMN y tsvector / GENERATED ALWAYS
  for (const m of src.matchAll(
    /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(ochr_\w+)\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+([^,;)]*)/gi)) {
    const [, table, col, rest] = m
    if (/\btsvector\b|GENERATED\s+ALWAYS/i.test(rest)) {
      out.set(table.toLowerCase(), [...(out.get(table.toLowerCase()) ?? []), col])
    }
  }
  // CREATE TABLE x ( ... y tsvector ... )
  for (const m of src.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(ochr_\w+)\s*\(([\s\S]*?)\n\s*\)/gi)) {
    for (const c of m[2].matchAll(/^\s*(\w+)\s+[^,\n]*(?:\btsvector\b|GENERATED\s+ALWAYS)/gim)) {
      out.set(m[1].toLowerCase(), [...(out.get(m[1].toLowerCase()) ?? []), c[1]])
    }
  }
  return out
}

const INTERNAL = tablesWithInternalColumns()
// A derivation that finds nothing is broken, not clean. ochr_donations is the
// table this gate was written for; if it stops being found, say so loudly.
if (!INTERNAL.has('ochr_donations')) {
  console.error('\napi-shape: could not derive ochr_donations as carrying an internal column.')
  console.error('The migration matcher is broken. Refusing to report a clean scan.\n')
  process.exit(1)
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.js')) out.push(p)
  }
  return out
}

const findings = []
const unresolved = []
let scanned = 0

// Whole SQL BLOCKS, not a line window. The first version looked three lines
// ahead of the star for a table name and therefore missed every
// `RETURNING *` at the end of a multi-line INSERT — five real leaks in
// tasks.js and events.js. That is the same line-window mistake the tenancy
// gate was rebuilt to remove; repeating it here would have been careless.
function sqlBlocks(src) {
  const out = []
  const push = (body, index) => {
    if (!/\bFROM\b|\bINTO\b|\bUPDATE\b/i.test(body)) return
    out.push({ body, line: src.slice(0, index).split('\n').length })
  }
  for (const m of src.matchAll(/`([^`]*)`/g)) push(m[1], m.index)
  for (const m of src.matchAll(/'((?:[^'\\\n]|\\.){20,})'/g)) push(m[1], m.index)
  for (const m of src.matchAll(/"((?:[^"\\\n]|\\.){20,})"/g)) push(m[1], m.index)
  return out
}

// `SELECT *`, `RETURNING *`, and the aliased form `SELECT t.*` — which is how
// GET /api/tasks shipped the tsvector while reading as a tidy join.
const STAR = /\b(SELECT|RETURNING)\s+(?:\w+\.)?\*/i

// WHICH TABLE DOES THE STAR BELONG TO?
//
// v1 did not ask. It reported a finding for every internal-column table
// MENTIONED anywhere in a block containing a star — so a join that selects
// `p.*, c.name` from ochr_pledges was filed under ochr_clients, because
// ochr_clients appears in the LEFT JOIN. Five of the thirteen baselined
// sites were that mistake, and the baseline comment even excused it
// ("several are joins where the star belongs to a different table") rather
// than fixing it. A gate whose known set is mostly noise is a gate people
// learn to scroll past.
//
// Now the star names its own owner:
//   RETURNING *        → the table in INSERT INTO / UPDATE
//   SELECT *  FROM x   → x
//   SELECT t.* FROM x t / JOIN y t → whichever table carries alias t
//
// Returns null when it genuinely cannot tell — a CTE, a set-returning
// function, a subquery — and a null owner is reported as UNRESOLVED rather
// than pinned on a table that happens to be nearby. UNKNOWN is not EMPTY.
function starOwner(body) {
  const m = body.match(STAR)
  if (!m) return null
  const alias = (body.slice(m.index).match(/\b(?:SELECT|RETURNING)\s+(\w+)\.\*/i) ?? [])[1]

  if (alias) {
    // FROM ochr_x alias | JOIN ochr_x alias | FROM ochr_x AS alias
    const byAlias = new RegExp(`\\b(?:FROM|JOIN)\\s+(ochr_\\w+)\\s+(?:AS\\s+)?${alias}\\b`, 'i')
    const hit = body.match(byAlias)
    return hit ? hit[1].toLowerCase() : null
  }
  if (/\bRETURNING\s+\*/i.test(body)) {
    const w = body.match(/\b(?:INSERT\s+INTO|UPDATE)\s+(ochr_\w+)/i)
    return w ? w[1].toLowerCase() : null
  }
  // Bare `SELECT * FROM x` — only when x is a real table, not a CTE or unnest().
  const from = body.slice(m.index).match(/\bFROM\s+(\w+)/i)
  return from && /^ochr_/i.test(from[1]) ? from[1].toLowerCase() : null
}

for (const root of ROOTS) {
  for (const file of walk(root)) {
    const src = readFileSync(file, 'utf8')
    for (const { body, line } of sqlBlocks(src)) {
      if (!STAR.test(body)) continue
      scanned++
      if (/api-shape:\s*\S/i.test(body)) continue   // documented exception
      const owner = starOwner(body)
      const code  = body.replace(/\s+/g, ' ').trim().slice(0, 110)
      if (owner === null) {
        // Cannot tell what the star reads. Not clean — unresolved.
        if ([...INTERNAL.keys()].some(t => new RegExp(`\\b${t}\\b`, 'i').test(body))) {
          unresolved.push({ file, line, code })
        }
        continue
      }
      if (!INTERNAL.has(owner)) continue
      findings.push({ file, line, table: owner, cols: INTERNAL.get(owner), code })
    }
  }
}

// A RATCHET, like lint:honest and lint:operator.
//
// Thirteen sites remain after the three resources with PROVEN client-facing
// exposure were fixed (donations, events, tasks). Those thirteen are
// RECORDED, NOT REVIEWED — several are joins where the star belongs to a
// different table, and some may never reach a client at all. Blocking the
// build on a thirteen-site cleanup would get this gate switched off; letting
// a NEW one appear silently is what created the problem. So: the known set
// is pinned, and only a new one fails.
//
// Keyed on the SQL, not the line number, so an unrelated edit above a known
// site is not a new finding.
const BASELINE = 'scripts/api-shape-baseline.json'
const key = f => `${relative('.', f.file)} :: ${f.table} :: ${f.code}`

if (process.argv.includes('--baseline')) {
  writeFileSync(BASELINE, JSON.stringify(findings.map(key).sort(), null, 2) + '\n')
  console.log(`api-shape: baseline written — ${findings.length} known site(s).`)
  process.exit(0)
}

let baseline = []
try { baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) } catch { /* first run */ }
const known = new Set(baseline)
const fresh = findings.filter(f => !known.has(key(f)))

if (fresh.length) {
  console.error(`\napi-shape: ${fresh.length} NEW query/queries return * from a table with internal columns\n`)
  for (const f of fresh) {
    console.error(`  ${relative('.', f.file)}:${f.line}  ${f.table} carries ${f.cols.join(', ')}`)
    console.error(`    ${f.code}\n`)
  }
  console.error(`A database row is not an API response. Name the columns the API`)
  console.error(`means — there is already a *_PUBLIC_COLUMNS constant for this.\n`)
  process.exit(1)
}

console.log(`api-shape: ${INTERNAL.size} table(s) carry internal columns; `
  + `${scanned} star-queries checked, ${findings.length} known, no new drift.`)
console.log(`           The known set is RECORDED, not reviewed — see ${BASELINE}.`)

// The gate's own blind spot, stated out loud. These are stars whose owning
// table could not be resolved (a CTE, unnest(), a subquery) in a block that
// also names a table with internal columns. They are NOT cleared — they are
// unexamined, and saying so is the difference between a clean scan and a
// quiet one.
if (unresolved.length) {
  console.log(`           ${unresolved.length} star(s) NOT CHECKED — owner unresolved:`)
  for (const u of unresolved) console.log(`             ${relative('.', u.file)}:${u.line}  ${u.code.slice(0, 80)}`)
}
process.exit(0)
