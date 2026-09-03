// Can old code survive a newer schema?
//
// Split out of release-rollback.mjs so it can be tested without opening a
// database connection — the tool imports server/src/db.js, and a pure
// classifier that needs Postgres to answer a question about a string is a
// classifier nobody exercises.
//
// The refusal is the valuable half of a rollback tool, so this is the
// half the suite drives directly, against real DDL for each hazard.

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
export const MIGRATIONS_DIR = join(HERE, '..', 'server', 'src', 'migrations')

// The five things that break old code, and nothing else. Deliberately
// crude and deliberately noisy in the safe direction: refusing a rollback
// that would have worked costs a conversation; waving through one that
// takes the site down costs a Sunday. Each carries the sentence it will
// print, because a refusal nobody understands is a refusal somebody
// overrides.
const BLOCKING = [
  { re: /\bDROP\s+TABLE\b/i,                why: 'drops a table old code still reads' },
  { re: /\bDROP\s+COLUMN\b/i,               why: 'drops a column old code still selects' },
  { re: /\bALTER\s+COLUMN\s+\w+\s+TYPE\b/i, why: 'changes a column type old code still writes' },
  { re: /\bRENAME\s+(TO|COLUMN)\b/i,        why: 'renames something old code addresses by its old name' },
  { re: /\bSET\s+NOT\s+NULL\b/i,            why: 'makes an existing column required; old INSERTs omit it' },
]

// A CHECK or a NOT NULL is only a hazard on a table that ALREADY EXISTED.
// The same words inside a CREATE TABLE describe a table old code has
// never heard of and cannot write to.
//
// And a constraint DROPPED then re-ADDED under the same name is a
// REPLACEMENT, not a new restriction. This distinction is not academic:
// the first real target this tool was pointed at was refused because of
// migration 086, which drops ochr_coa_mappings_source_type_check and adds
// it back with 'fund' included — a WIDENING, which old code satisfies
// trivially. A wrong answer on its first real question is the fastest
// possible way to teach somebody to ignore the tool.
//
// A regex cannot tell widening from narrowing, so a replacement is
// reported as "read this one" rather than decided.
// Words that appear inside a CHECK expression and are not column names.
// Kept deliberately small: anything unrecognised is treated AS a column,
// so the failure mode of this list being incomplete is the classifier
// blocking something safe — never letting something dangerous through.
const CHECK_NOISE = new Set([
  'in', 'and', 'or', 'not', 'null', 'is', 'between', 'like', 'any', 'all',
  'true', 'false', 'char_length', 'length', 'lower', 'upper', 'trim',
  'array', 'text', 'integer', 'numeric', 'boolean', 'check',
])

// Which columns does a CHECK expression actually constrain?
// Identifiers only, with string literals stripped first — otherwise
// CHECK (locale IN ('en','es')) reads 'en' and 'es' as column names.
function checkColumns(expr) {
  const withoutLiterals = expr.replace(/'[^']*'/g, ' ')
  return [...withoutLiterals.matchAll(/\b[a-z_][a-z0-9_]*\b/gi)]
    .map(m => m[0].toLowerCase())
    .filter(w => !CHECK_NOISE.has(w))
}

// Every CHECK expression in the file, read with BALANCED PARENTHESES from
// the original source rather than from the per-statement slices below.
//
// This matters and it is not tidiness. The statement slicer deliberately
// terminates on a quote, so `CHECK (locale IN ('en','es'))` is cut at the
// first `'` and arrives here as `CHECK (locale IN (`. Reading columns off
// that fragment would see `locale`, miss anything after the cut, and call a
// constraint safe on the strength of the half it happened to get — which is
// the same shape as every other bug this codebase has been removing: a
// confident answer derived from partial input.
//
// So: find `CHECK (`, then walk forward counting parens and skipping string
// literals. An expression whose parens never balance is returned as null and
// treated as UNKNOWN by the caller, which blocks.
function checkExpressions(sql) {
  const out = []
  const re = /CHECK\s*\(/gi
  let m
  while ((m = re.exec(sql)) !== null) {
    let depth = 1, i = m.index + m[0].length, inStr = false
    while (i < sql.length && depth > 0) {
      const ch = sql[i]
      if (inStr) { if (ch === "'") inStr = false }
      else if (ch === "'") inStr = true
      else if (ch === '(') depth++
      else if (ch === ')') depth--
      i++
    }
    out.push(depth === 0 ? sql.slice(m.index + m[0].length, i - 1) : null)
  }
  return out
}

function alterHazards(sql) {
  const blocking = [], reading = []
  const dropped = new Set(
    [...sql.matchAll(/DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?(\w+)/gi)].map(m => m[1].toLowerCase())
  )
  // Columns THIS migration adds. The header above already says a CHECK is
  // only a hazard on a table that already existed, because old code cannot
  // write a table it has never heard of. The same sentence is true one
  // level down: old code cannot write a COLUMN it has never heard of
  // either, so a CHECK confined to columns added right here constrains
  // nothing any older build can produce.
  //
  // This is the existing principle applied to columns, not an exception
  // carved for a particular migration — and it is deliberately narrow. If
  // the CHECK mentions even one pre-existing column, it blocks exactly as
  // before, because then old code CAN write a value it now rejects.
  const addedColumns = new Set(
    [...sql.matchAll(/ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi)].map(m => m[1].toLowerCase())
  )
  // Read from the WHOLE file, in order, so a truncated statement slice can
  // never be the basis of a safe verdict.
  const exprs = checkExpressions(sql)
  let checkIndex = 0
  const onlyNewColumns = () => {
    const expr = exprs[checkIndex++]
    if (expr == null) return false            // unbalanced / unreadable → block
    const cols = checkColumns(expr)
    return cols.length > 0 && cols.every(c => addedColumns.has(c))
  }
  // Terminate on a semicolon, a template backtick, a quote, OR the end of
  // the string. The first version required `;` or a backtick, so a
  // migration written as pool.query('ALTER TABLE … NOT NULL') — single
  // quotes, no trailing semicolon — was silently never analysed, and a
  // real hazard would have been reported as safe. A classifier that
  // quietly skips input is worse than one that is merely crude.
  const alters = sql.match(/ALTER\s+TABLE[\s\S]{0,400}?(?=;|`|'|"|$)/gi) || []
  for (const stmt of alters) {
    const named = stmt.match(/ADD\s+CONSTRAINT\s+(\w+)[\s\S]{0,200}?CHECK/i)
    if (named) {
      if (dropped.has(named[1].toLowerCase())) {
        reading.push(`replaces the CHECK ${named[1]} — widening is safe for old code, narrowing is not; read it`)
      } else if (onlyNewColumns()) {
        reading.push(`${named[1]} constrains only columns this migration adds — old code cannot write them`)
      } else {
        blocking.push('adds a new CHECK to an existing table; old code may write values it now rejects')
      }
    } else if (/ADD\s+CHECK/i.test(stmt)) {
      if (onlyNewColumns()) {
        reading.push('an unnamed CHECK constrains only columns this migration adds — old code cannot write them')
      } else {
        blocking.push('adds an unnamed CHECK to an existing table; old code may write values it now rejects')
      }
    }
    if (/ADD\s+COLUMN[\s\S]*?NOT\s+NULL/i.test(stmt) && !/DEFAULT/i.test(stmt)) {
      blocking.push('adds a NOT NULL column with no DEFAULT; old INSERTs omit it')
    }
  }
  return { blocking, reading }
}

export function classifySql(sql) {
  const reasons = []
  for (const { re, why } of BLOCKING) if (re.test(sql)) reasons.push(why)
  const alt = alterHazards(sql)
  reasons.push(...alt.blocking)
  const warnings = [...alt.reading]
  if (/CREATE\s+OR\s+REPLACE\s+VIEW|DROP\s+VIEW/i.test(sql)) {
    warnings.push('rewrites a view; old code reading it may get different columns')
  }
  return { reasons, warnings }
}

export function classifyFile(file) {
  return { file, ...classifySql(readFileSync(join(MIGRATIONS_DIR, file), 'utf8')) }
}

// Filenames are zero-padded and ordered, which is what makes "between"
// meaningful. Anything not matching that shape is not a migration.
export function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR).filter(f => /^\d{3}-.*\.js$/.test(f)).sort()
}

export function migrationsAfter(target, current) {
  const name = m => (m || '').replace(/\.js$/, '')
  return migrationFiles().filter(f => name(f) > name(target) && name(f) <= name(current))
}
