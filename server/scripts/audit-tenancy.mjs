#!/usr/bin/env node
// Tenancy gate — what it proves, and what it does not.
//
// ── THE INVARIANT ────────────────────────────────────────────────────────
// Every SQL statement in src/routes/** that touches an org-scoped table must
// constrain that statement to one organization.
//
// ── WHAT THIS CAN AND CANNOT PROVE ───────────────────────────────────────
// It CANNOT prove tenant isolation. No static analysis can: whether
// `organization_id = $1` carries the CALLER'S org is a runtime fact. This
// gate proves a strictly weaker, still useful property — that the constraint
// is SYNTACTICALLY PRESENT in the statement, or in the handler that builds
// it. Isolation itself is evidenced elsewhere: ~200 auth/tenancy probes,
// token_version rejection in requireAuth, and 78/78 composite foreign keys.
// Those are separate claims. Do not merge them into this one.
//
// ── WHY IT WAS REWRITTEN (27 Aug) ────────────────────────────────────────
// The previous version scanned raw text and accepted `organization_id`
// appearing anywhere within CONTEXT_LINES = 30 of the query. In a real route
// file every query has a neighbour within thirty lines, so the check passed
// on almost anything. Demonstrated: a genuinely unscoped
// `SELECT ... FROM ochr_clients WHERE name ILIKE $1`, added as an ordinary
// route, exited GREEN; the identical query padded with 40 blank lines exited
// RED. It could not catch the one mistake its own header said it existed to
// catch. Its table list was also frozen "as of migration 064" and missed 20
// of the 68 org-scoped tables then in the schema.
//
// Two changes follow from that:
//   1. Tables are DERIVED from the migrations, not typed into an array, so a
//      new org-scoped table is covered on the commit that creates it.
//   2. Scope is the SQL text, then the ENCLOSING HANDLER — never a line
//      window. A handler is a real boundary; ±30 lines is not.
//
// ── ESCAPE HATCH ─────────────────────────────────────────────────────────
// A SQL comment containing `tenancy: <reason>` inside the query. Rare, and
// each use is a claim somebody is making on the record.
//
// Runs in CI with no database. Exit 1 on any violation.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER = join(HERE, '..')
const ROUTES_DIR = join(SERVER, 'src', 'routes')
const MIGRATIONS_DIR = join(SERVER, 'src', 'migrations')

// Parsing is not optional. A missing parser must fail, not silently skip —
// a gate that cannot run is not a gate that passes.
const require = createRequire(join(SERVER, '/'))
let parse
try { ({ parse } = require('@babel/parser')) } catch {
  console.error('\naudit-tenancy: @babel/parser not resolvable from server/node_modules.')
  console.error('This gate parses real source and will not run without it.')
  console.error('Refusing to pass by default.\n')
  process.exit(1)
}

// ── 1. Derive the org-scoped table set from the migrations ───────────────
function orgScopedTables() {
  const tables = new Set()
  const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.js'))
  const all = files.map(f => readFileSync(join(MIGRATIONS_DIR, f), 'utf8')).join('\n')
  const base = readFileSync(join(SERVER, 'src', 'migrate.js'), 'utf8')
  const src = all + '\n' + base

  // CREATE TABLE ochr_x ( ... organization_id ... )
  for (const m of src.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(ochr_\w+)\s*\(([\s\S]*?)\n\s*\)/gi)) {
    if (/\borganization_id\b|\bdiocese_org_id\b|\bparish_org_id\b/i.test(m[2])) tables.add(m[1].toLowerCase())
  }
  // ALTER TABLE ochr_x ADD COLUMN organization_id — the column being ADDED
  // must be the org column. The first version allowed 200 characters of
  // anything between the table name and the column, which let a nearby
  // statement's organization_id be attributed to the wrong table:
  // ochr_organizations itself was pulled in that way, producing 14 false
  // findings on its own primary key.
  for (const m of src.matchAll(/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(ochr_\w+)\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(organization_id|diocese_org_id|parish_org_id)\b/gi)) {
    tables.add(m[1].toLowerCase())
  }
  // migrate.js adds organization_id to the ORIGINAL pre-auth tables by
  // looping over a TENANT_TABLES array, so those tables never appear in a
  // literal `ALTER TABLE ochr_x ADD COLUMN organization_id`. Reading the
  // regexes alone missed ochr_clients, ochr_donations, ochr_calendar_events
  // and ochr_tasks — the four most-queried tables in the app. Caught on 27
  // Aug only because the adversarial probes came back green when they should
  // have been red. The array is the codebase's own declaration; use it.
  const tenantArray = base.match(/const\s+TENANT_TABLES\s*=\s*\[([\s\S]*?)\]/)
  if (tenantArray) {
    for (const m of tenantArray[1].matchAll(/'(ochr_\w+)'/g)) tables.add(m[1].toLowerCase())
  }

  // The tenant ROOT is not org-scoped by a column — it IS the organization.
  // A query against it is scoped by its own primary key.
  tables.delete('ochr_organizations')
  return tables
}

const ORG_TABLES = orgScopedTables()
// A derivation that finds almost nothing is broken, and must say so rather
// than reporting a clean scan. The floor is set below the true count on
// purpose: pinned exactly, deleting one legitimate table would fire this.
const MIN_TABLES = 40
// A derivation can be large and still be missing the tables that matter.
// These four are the most-queried org-scoped tables in the app; if the
// matcher stops finding them the gate is not covering the app's hot path,
// whatever its total count says.
const MUST_COVER = ['ochr_clients', 'ochr_donations', 'ochr_calendar_events', 'ochr_tasks']
const uncovered = MUST_COVER.filter(t => !ORG_TABLES.has(t))
if (uncovered.length) {
  console.error(`\naudit-tenancy: derivation is missing core tables: ${uncovered.join(', ')}`)
  console.error('The gate would pass while ignoring the app\'s busiest tables. Refusing.\n')
  process.exit(1)
}

if (ORG_TABLES.size < MIN_TABLES) {
  console.error(`\naudit-tenancy: derived only ${ORG_TABLES.size} org-scoped tables, expected at least ${MIN_TABLES}.`)
  console.error('The migration matcher is broken. Refusing to report a clean scan.\n')
  process.exit(1)
}

// ── 2. Pull every .query() call out of the AST, with its handler ─────────
function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.js')) out.push(p)
  }
  return out
}

// Reconstruct a template literal, marking interpolations so we can tell a
// fully-literal statement from an assembled one.
function templateText(node) {
  if (node.type === 'StringLiteral') return { text: node.value, dynamic: false }
  if (node.type !== 'TemplateLiteral') return null
  let text = ''
  node.quasis.forEach((q, i) => {
    text += q.value.cooked ?? q.value.raw
    if (i < node.expressions.length) text += ' ${…} '
  })
  return { text, dynamic: node.expressions.length > 0 }
}

const findings = []
let scanned = 0, literalPass = 0, handlerPass = 0, exempt = 0

for (const file of walk(ROUTES_DIR)) {
  const src = readFileSync(file, 'utf8')
  let ast
  try { ast = parse(src, { sourceType: 'module', plugins: ['jsx'] }) }
  catch (err) { findings.push({ file, line: 0, sql: `could not be parsed — ${err.message}` }); continue }

  // Every function node, so a query can be attributed to its handler.
  const fns = []
  const collect = (node, parent) => {
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') return
    if (/Function(Declaration|Expression)|ArrowFunctionExpression|ObjectMethod|ClassMethod/.test(node.type)) {
      fns.push(node)
    }
    for (const k of Object.keys(node)) {
      if (k === 'loc') continue
      const v = node[k]
      if (Array.isArray(v)) v.forEach(c => collect(c, node))
      else if (v && typeof v.type === 'string') collect(v, node)
    }
  }
  collect(ast.program, null)

  // Innermost function containing an offset.
  const handlerFor = (start, end) => {
    let best = null
    for (const f of fns) {
      if (f.start <= start && f.end >= end) {
        if (!best || (f.end - f.start) < (best.end - best.start)) best = f
      }
    }
    return best
  }

  const visit = (node) => {
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') return
    const isQuery =
      node.type === 'CallExpression' &&
      (node.callee?.type === 'MemberExpression' || node.callee?.type === 'OptionalMemberExpression') &&
      node.callee.property?.name === 'query'
    if (isQuery && node.arguments.length) {
      const tpl = templateText(node.arguments[0])
      if (tpl) {
        const sql = tpl.text
        const touched = [...ORG_TABLES].filter(t => new RegExp(`\\b${t}\\b`, 'i').test(sql))
        if (touched.length) {
          scanned++
          const line = node.loc.start.line
          if (/tenancy:\s*\S/i.test(sql)) { exempt++ }
          else if (/\borganization_id\b|\bdiocese_org_id\b|\bparish_org_id\b/i.test(sql)) { literalPass++ }
          else {
            // Assembled statement: the constraint may live in the builder.
            // The HANDLER is the boundary — not a line window.
            const h = handlerFor(node.start, node.end)
            const hSrc = h ? src.slice(h.start, h.end) : ''
            if (tpl.dynamic && /\borganization_id\b|\bdiocese_org_id\b|\bparish_org_id\b/i.test(hSrc)) {
              handlerPass++
            } else {
              findings.push({ file, line,
                sql: sql.replace(/\s+/g, ' ').trim().slice(0, 120),
                tables: touched.join(', '),
                why: tpl.dynamic
                  ? 'assembled statement, and the handler that builds it never mentions organization_id'
                  : 'literal statement with no organization_id and no tenancy: exemption' })
            }
          }
        }
      }
    }
    for (const k of Object.keys(node)) {
      if (k === 'loc') continue
      const v = node[k]
      if (Array.isArray(v)) v.forEach(visit)
      else if (v && typeof v.type === 'string') visit(v)
    }
  }
  visit(ast.program)
}

if (findings.length) {
  console.error(`\naudit-tenancy: ${findings.length} statement(s) touch an org-scoped table without visible scoping\n`)
  for (const f of findings) {
    console.error(`  ${relative(SERVER, f.file)}:${f.line}  [${f.tables ?? ''}]`)
    console.error(`    ${f.sql}`)
    console.error(`    → ${f.why ?? ''}\n`)
  }
  console.error(`Add organization_id to the statement, or — if it is genuinely`)
  console.error(`cross-tenant by design — put a  tenancy: <reason>  SQL comment`)
  console.error(`inside the query saying why.\n`)
  process.exit(1)
}

console.log(`audit-tenancy: ${ORG_TABLES.size} org-scoped tables derived from migrations; `
  + `${scanned} statements touch one.`)
console.log(`               ${literalPass} scoped in the SQL itself, ${handlerPass} in the building handler, ${exempt} exempted.`)
console.log(`               This proves the constraint is PRESENT. It does not prove isolation — see the header.`)
