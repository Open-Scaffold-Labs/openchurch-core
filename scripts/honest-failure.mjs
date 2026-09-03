#!/usr/bin/env node
// A screen may not invent a fact it did not receive.
//
// Three ways this codebase kept breaking that rule, all of them in the same
// shape — code that treats "the request failed" as "the answer is nothing":
//
//   1. DISCARDED WRITE.   `await fetch(url, { method: 'POST' })` with nobody
//      reading the response, followed by clearing the form / closing the
//      panel / ticking the box. A 500 then looks EXACTLY like a save.
//   2. UNCHECKED PARSE.   `.then(r => r.json())` with no `r.ok`. An error
//      body — `{ error: '…' }` — is parsed and rendered as if it were data.
//   3. EMPTY ON ERROR.    `.catch(() => setRows([]))`. Every list page in
//      this app renders an empty array as its first-run welcome state, so a
//      dropped connection told a diocese of forty parishes to invite its
//      first one.
//
// The diocese app had all three on nearly every page, because it was written
// after the parish app and copied the pattern before the pattern was fixed.
// Fixing the instances is not enough — the next page anyone writes will copy
// whatever is next to it. So this runs in CI.
//
// What makes each of these serious is not the error. It is that the person
// looking at the screen has no way to tell. A canon who types a pastoral
// note, watches the box empty, and walks away has been told the record was
// written. It was not.
//
// Usage:  node scripts/honest-failure.mjs [--list] [--baseline]

import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOTS = ['client/src', 'client-diocese/src']
const BASELINE = 'scripts/honest-failure-baseline.json'

const RULES = [
  {
    id: 'discarded-write',
    // `await fetch(` where the response goes nowhere. Assignment
    // (`const res = await fetch`), `return await fetch`, and
    // `await (await fetch(...)).json()` are all reading it.
    test(line) {
      const i = line.indexOf('await fetch(')
      if (i < 0) return false
      const before = line.slice(0, i)
      return !/[=(]\s*$|\breturn\s+$/.test(before)
    },
    say: 'the response is thrown away — a failed write is indistinguishable from a save',
  },
  {
    id: 'unchecked-parse',
    test: line => /\.then\(\s*(\w+)\s*=>\s*\1\.json\(\)\s*\)/.test(line),
    say: 'parses the body without checking the status — an error body renders as data',
  },
  {
    id: 'empty-on-error',
    // Widened 27 Aug: the setter no longer has to sit immediately after the
    // arrow. `.catch(() => { if (!cancelled) setRows([]) })` is the same
    // defect wearing a guard, and there were 10 of them.
    test: line => /catch\(\s*\(?\s*\w*\s*\)?\s*=>\s*\{?[^;{}]*\bset[A-Z]\w*\(\s*(\[\s*\]|\{\}|''|"")\s*\)/.test(line),
    say: 'substitutes an empty result on failure — the page then renders its "nothing here yet" state',
  },
  // The two shapes below were added 27 Aug. An audit found that this script
  // had certified four files as clean while they still carried the defect,
  // purely because they wrote it differently. The baseline going 16 -> 1 was
  // therefore a claim about the shapes this script recognises, not about the
  // codebase — which is a much weaker sentence than the one that got said.
  {
    id: 'ternary-empty',
    // `r.ok ? r.json() : []` — a failure silently becomes an empty result.
    // Observed shipping in App.jsx's 30-second notification poll, where one
    // transient 500 dropped the unread badge to zero.
    // Widened 27 Aug. The first version required the identifier IMMEDIATELY
    // after `?` and only recognised [] / {} as the empty branch, so it missed
    // 12 `r.ok ? await r.json() : []`, 14 `... : null`, and shapes like
    // `: { lines: [], total: 0 }` — 27 real instances of the same defect,
    // sitting in files the baseline had certified clean. One of them was two
    // lines below a site this rule DID flag.
    test: line => /\?\s*(?:await\s+)?[\w$.]+\.json\(\)\s*:\s*(\[\s*\]|\{[^}]*\}|null|undefined|''|""|`\s*`)/.test(line),
    say: 'turns a failed response into an empty one — "none" and "we could not tell" become the same screen',
  },
  {
    id: 'awaited-parse',
    // `await res.json()` with no `.ok` anywhere in the same function. This is
    // the shape that put an error BODY into a state variable in Events.jsx,
    // so `events.map` threw and the page died into the error boundary.
    // Function-scoped rather than line-scoped, hence the different signature.
    scope: 'function',
    test(fnText) {
      if (!/await\s+\w+\.json\(\)/.test(fnText)) return false
      return !/\.ok\b/.test(fnText) && !/\.status\b/.test(fnText)
    },
    say: 'awaits .json() without ever checking .ok — an error body is assigned as if it were data',
  },
]

// Blank out comments and string bodies before matching.
//
// The line-start-only strip this replaces produced four false positives in a
// six-line probe: a line inside a /* */ block, a trailing
// `// was: r.ok ? r.json() : []`, and a string literal holding the pattern as
// documentation. A rule that fires on its own documentation trains people to
// delete the documentation — or worse, to re-baseline without reading.
//
// Length is preserved so nothing downstream shifts.
let inBlock = false
function strip(line, _n) {
  let out = ''
  let i = 0
  let quote = null
  while (i < line.length) {
    const two = line.slice(i, i + 2)
    if (inBlock) {
      if (two === '*/') { inBlock = false; out += '  '; i += 2 }
      else { out += ' '; i += 1 }
      continue
    }
    if (quote) {
      if (line[i] === '\\') { out += '  '; i += 2; continue }
      if (line[i] === quote) { quote = null; out += ' '; i += 1; continue }
      out += ' '; i += 1; continue
    }
    if (two === '/*') { inBlock = true; out += '  '; i += 2; continue }
    if (two === '//') { out += ' '.repeat(line.length - i); break }
    if (line[i] === "'" || line[i] === '"' || line[i] === '`') { quote = line[i]; out += ' '; i += 1; continue }
    out += line[i]; i += 1
  }
  return out
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) { walk(p, out); continue }
    if (/\.(jsx?|tsx?)$/.test(name)) out.push(p)
  }
  return out
}

const findings = []
let scanned = 0
for (const root of ROOTS) {
  for (const file of walk(root)) {
    scanned++
    const rel = relative('.', file)
    const lines = readFileSync(file, 'utf8').split('\n')
    inBlock = false
    lines.forEach((line, n) => {
      // Comments describing the defect are not the defect. Every fix in
      // this codebase carries a comment explaining what it replaced, and a
      // scanner that flags its own documentation trains people to delete
      // the documentation.
      const code = strip(line, n)
      for (const rule of RULES) {
        if (rule.scope === 'function') continue
        if (rule.test(code)) {
          findings.push({ rule: rule.id, file: rel, line: n + 1, say: rule.say, code: code.trim().replace(/\s+/g, ' ') })
        }
      }
    })

    // Function-scoped rules need more than one line of context. Crude
    // block-slicing rather than a parser: this script must never be the
    // reason a commit is blocked on a dependency, and a missed function
    // here degrades to the line rules above rather than to a false pass.
    const text = lines.join('\n')
    for (const rule of RULES) {
      if (rule.scope !== 'function') continue
      for (const m of text.matchAll(/(?:async\s+function\s+\w+|const\s+\w+\s*=\s*async\s*\(|async\s*\([^)]*\)\s*=>)/g)) {
        const start = m.index
        let depth = 0, i = text.indexOf('{', start), end = -1
        if (i < 0) continue
        for (let k = i; k < text.length && k < i + 8000; k++) {
          if (text[k] === '{') depth++
          else if (text[k] === '}') { depth--; if (depth === 0) { end = k; break } }
        }
        if (end < 0) continue
        const body = text.slice(start, end)
        const wasInBlock = inBlock
        inBlock = false
        const stripped = body.split('\n').map(l => strip(l, 0)).join('\n')
        inBlock = wasInBlock
        if (rule.test(stripped)) {
          const line = text.slice(0, start).split('\n').length
          const sig = body.split('\n')[0].trim().replace(/\s+/g, ' ').slice(0, 90)
          findings.push({ rule: rule.id, file: rel, line, say: rule.say, code: sig })
        }
      }
    }
  }
}

// Keyed on the CODE, not the line number. A baseline anchored to line
// numbers turns every unrelated edit above a known site into a false "new
// finding", and a check that cries wolf is a check somebody re-baselines
// without reading. This way the entry survives the file moving around and
// only a genuinely new site is new.
const key = f => `${f.rule} ${f.file} :: ${f.code}`

if (process.argv.includes('--baseline')) {
  writeFileSync(BASELINE, JSON.stringify(findings.map(key).sort(), null, 2) + '\n')
  console.log(`honest-failure: baseline written — ${findings.length} known site(s).`)
  process.exit(0)
}

let baseline = []
try { baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) } catch { /* first run */ }
const known = new Set(baseline)
const fresh = findings.filter(f => !known.has(key(f)))

if (process.argv.includes('--list')) {
  for (const f of findings) {
    console.log(`${known.has(key(f)) ? '  known ' : '  NEW   '}${f.rule.padEnd(16)} ${f.file}:${f.line}`)
  }
  console.log(`\n${scanned} files scanned, ${findings.length} site(s), ${fresh.length} new.`)
}

if (fresh.length) {
  console.error(`\nhonest-failure: ${fresh.length} new site(s) where a failure would look like an answer.\n`)
  for (const f of fresh) {
    console.error(`  ${f.file}:${f.line}  [${f.rule}]`)
    console.error(`    ${f.say}\n`)
  }
  console.error(`The diocese app has helpers for all three — loadOne, loadAll and`)
  console.error(`postJson in client-diocese/src/utils/format.js — and a <LoadError>`)
  console.error(`banner in client-diocese/src/components/LoadError.jsx.`)
  console.error(`If a site genuinely should stay silent on failure, say why in a`)
  console.error(`comment and re-baseline with:  node scripts/honest-failure.mjs --baseline\n`)
  process.exit(1)
}

console.log(`honest-failure: ${scanned} files, ${findings.length} known site(s), no new drift.`)
