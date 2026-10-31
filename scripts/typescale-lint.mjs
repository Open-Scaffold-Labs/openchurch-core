#!/usr/bin/env node
//
// Type-scale lint — hard ban on the hand-set sizes Jarvis flagged as
// unfinished (quiet craft #4). Small labels are 11px minimum; body is
// 14–16px. Odd half-pixels and sub-11px sizes are retired.
//
//   node scripts/typescale-lint.mjs         # fail on any hit
//   node scripts/typescale-lint.mjs --list  # show hits, never fail
//
// Scope: UI code only (client/src, client-diocese/src), same as operator-lint.
// Wire into prepush next to lint:operator. CI should also run this next to
// lint:operator in .github/workflows/ci.yml — that edit is intentionally
// left for a follow-up (this PR does not touch workflow files).

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOTS = ['client/src', 'client-diocese/src']
const EXT = /\.(jsx?|tsx?|css)$/
const listMode = process.argv.includes('--list')

// Exact hand-set sizes to retire. text-[10px] is also under the 11px floor
// and is banned here so it cannot re-enter as a "slightly larger" dodge.
const BANNED = /\btext-\[(?:8|9|10|11\.5|12\.5|13\.5)px\]/g

function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'dist' || name === 'coverage') continue
      walk(p, out)
    } else if (EXT.test(name)) {
      out.push(p)
    }
  }
  return out
}

const files = ROOTS.flatMap((r) => walk(r))
const hits = []
for (const file of files) {
  const rel = relative(process.cwd(), file)
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, i) => {
    const t = line.trim()
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return
    BANNED.lastIndex = 0
    let m
    while ((m = BANNED.exec(line))) {
      hits.push({ rel, line: i + 1, hit: m[0], text: t.slice(0, 120) })
    }
  })
}

if (listMode) {
  if (!hits.length) {
    console.log('Type-scale lint: no banned sizes.')
  } else {
    console.error(`Type-scale lint: ${hits.length} banned size(s):\n`)
    for (const h of hits) {
      console.error(`  ${h.rel}:${h.line}  ${h.hit}   ${h.text}`)
    }
  }
  process.exit(0)
}

if (!hits.length) {
  console.log(`Type-scale lint: clean — scanned ${files.length} UI files.`)
  process.exit(0)
}

console.error(`\nType-scale lint: ${hits.length} banned hand-set size(s).\n`)
console.error('Retire 8/9/10/11.5/12.5/13.5px. Labels ≥11px; body 14–16px (text-sm / text-base).\n')
for (const h of hits) {
  console.error(`  ${h.rel}:${h.line}  ${h.hit}   ${h.text}`)
}
process.exit(1)
