#!/usr/bin/env node
//
// OPERATOR lint — machine enforcement for the hard bans in OPERATOR.md §
// "Hard bans (reject on sight)".
//
// WHY THIS EXISTS. The bans were already written down and already agreed,
// and drift re-entered anyway: the Phase Zero QA audit found 76 raw accent
// tokens on Donations alone, 19 `shadow-lg+` sites, hover-scale on every
// primary button, and a scale-and-rotate-90 modal close button. None of
// that survived review because nobody was reviewing for it on every commit.
// A rule a human has to remember is a rule that erodes under time pressure,
// which is exactly when a demo week applies the most pressure.
//
//   node scripts/operator-lint.mjs            # fail if any rule got WORSE
//   node scripts/operator-lint.mjs --list     # show every hit, never fail
//   node scripts/operator-lint.mjs --baseline # re-record after cleaning up
//
// THIS IS A RATCHET, NOT A CLEAN BILL OF HEALTH. There are 200-odd existing
// violations — mostly raw accent tokens on pages the C3 sweep has not
// reached yet, plus the Sparkles motif and raw text-white. Failing CI on all
// of them today would mean either a giant risky sweep in demo week or, far
// more likely, someone disabling the check. So the baseline file records
// today's count per rule and the lint fails only when a count goes UP. New
// code is held to the standard immediately; the backlog gets paid down
// deliberately, and every payment is locked in by re-baselining.
//
// Scope is UI code only: client/src and client-diocese/src.
//
// ADDING AN EXCEPTION. Put the path in ALLOWED for that rule with a reason.
// "It's just this once" is how the 76 got there; write the reason down.

import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOTS = ['client/src', 'client-diocese/src']
const EXT = /\.(jsx?|tsx?|css)$/

const RULES = [
  {
    id: 'raw-accent-color',
    // Tailwind accent families that are not part of Parchment & Brass.
    // Matched with the tailwind prefix so prose like "a slate roof" or an
    // identifier such as `grayscale` cannot trip it.
    re: /\b(?:bg|text|border|ring|from|via|to|divide|decoration|outline|shadow|accent|caret|fill|stroke|placeholder)-(indigo|violet|sky|blue|teal|pink|purple|slate|stone|gray|emerald|green|fuchsia|cyan|lime|orange|yellow|red|zinc|neutral)-\d{2,3}\b/g,
    why: 'Only church / parchment / brass / ink, plus muted amber and rose. (OPERATOR P6, P8)',
    allowed: [
      // Liturgical hues are canonical, not decoration.
      'client/src/utils/liturgicalColors.js',
      // CARE.1's exception for client-diocese/src/pages/ParishCare.jsx was
      // REMOVED on 2026-08-17, and the way it was removed is the point.
      //
      // The conflict was real: the Pastoral Oversight handoff specifies a
      // muted green for "Ready", and Parchment & Brass carried no green, so
      // the tone was raw Tailwind emerald behind this allowlist. The two
      // obvious resolutions were both bad — keep the exception (a permanent
      // hole in the palette rule) or desaturate Ready to ink (which makes
      // "Ready" and "Awaiting update" read as the same weight, the one
      // distinction a diocesan staff member scans for).
      //
      // Resolved instead by making the tone legitimate: `sage` is now a real
      // scale in both tailwind configs, warm and olive-leaning so it sits
      // with brass rather than reading as a UI-kit green. The directive is
      // honoured, the palette holds, and this rule needs no carve-out.
      // sage-800 on sage-50 measures 9.8:1, and sage-600 stays clearly
      // distinct from ink-400 by luminance.
    ],
  },
  {
    id: 'cool-shadow',
    re: /\bshadow-(lg|xl|2xl)\b/g,
    why: 'Surfaces use shadow-warm / shadow-warm-md / shadow-warm-lg. (OPERATOR P6)',
    allowed: [],
  },
  {
    id: 'hover-motion',
    re: /whileHover\s*=|\bhover:scale-|\bhover:rotate-|\banimate-bounce\b|\banimate-ping\b/g,
    why: 'Hover shifts colour toward brass; nothing scales, bounces, or celebrates. (OPERATOR P8)',
    allowed: [],
  },
  {
    id: 'glass-and-glow',
    re: /\bbackdrop-blur\b|\bbackdrop-filter\b|\bdrop-shadow-2xl\b/g,
    why: 'No glassmorphism, neon, or glow. (OPERATOR P10)',
    // The modal scrim is the one sanctioned use: it exists to recede the
    // page behind a dialog, not to decorate a surface.
    allowed: ['client/src/components/MobileSheet.jsx'],
  },
  {
    id: 'native-dialog',
    // prompt() joined the ban once usePrompt() existed to replace it. The
    // lookbehind keeps `deferredPrompt.prompt()` — the PWA install API, not
    // a dialog we render — out of it.
    re: /(?<![.\w])(?:window\.)?(?:alert|confirm|prompt)\s*\(/g,
    why: 'Use ToastProvider for messages, useConfirm() for confirmations, usePrompt() for typed replies. (OPERATOR P1)',
    // The providers are the sanctioned replacements; their own doc comments
    // name the things they replace.
    allowed: [
      'client/src/components/ConfirmProvider.jsx',
      'client-diocese/src/components/ConfirmProvider.jsx',
    ],
  },
  {
    id: 'raw-text-white',
    re: /\btext-white\b/g,
    why: 'Use text-parchment-50. (OPERATOR P6)',
    allowed: [],
  },
  {
    id: 'sparkles-as-ai-motif',
    re: /\bSparkles\b/g,
    why: 'The AI motif is the quill (Feather) — assistance as craft, not sorcery. (OPERATOR P10)',
    allowed: [],
  },
]

function walk(dir, out = []) {
  let entries
  try { entries = readdirSync(dir) } catch { return out }
  for (const e of entries) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (EXT.test(p)) out.push(p)
  }
  return out
}

const listMode = process.argv.includes('--list')
const writeBaseline = process.argv.includes('--baseline')
const BASELINE_PATH = 'scripts/operator-lint-baseline.json'
const files = ROOTS.flatMap(r => walk(r))
const findings = []

for (const file of files) {
  const rel = relative('.', file)
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n')
  for (const rule of RULES) {
    if (rule.allowed.some(a => rel === a || rel.startsWith(a))) continue
    lines.forEach((line, i) => {
      // A line that opts out explicitly is a documented decision, not drift.
      if (line.includes('operator-lint-disable')) return
      // Comment lines describe the bans (this file's own rules, the doc
      // comment on ConfirmProvider, "never a native alert()" notes). A rule
      // that fires on its own documentation trains people to ignore it.
      // `{/*` is the JSX form and describes UI in prose just as often —
      // "Update prompt (PWA.6)" is a banner, not a call to prompt().
      const t = line.trim()
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('{/*')) return
      const m = line.match(rule.re)
      if (m) findings.push({ rel, line: i + 1, rule, hit: m[0], text: line.trim().slice(0, 100) })
    })
  }
}

const byRule = new Map()
for (const rule of RULES) byRule.set(rule.id, [])
for (const f of findings) byRule.get(f.rule.id).push(f)

// Baseline is per-rule PER FILE, not a single number. A bare total tells you
// "something got worse" and then makes you hunt; per-file tells you exactly
// which file to open. File-level (not line-level) keeps it stable when code
// moves around for unrelated reasons.
const counts = {}
for (const [id, hits] of byRule) {
  counts[id] = {}
  for (const h of hits) counts[id][h.rel] = (counts[id][h.rel] ?? 0) + 1
}
const totalFor = id => Object.values(counts[id] ?? {}).reduce((a, b) => a + b, 0)

if (writeBaseline) {
  writeFileSync(BASELINE_PATH, JSON.stringify(counts, null, 2) + '\n')
  console.log(`OPERATOR lint: baseline written to ${BASELINE_PATH}`)
  for (const id of Object.keys(counts)) console.log(`  ${id.padEnd(24)} ${totalFor(id)}`)
  process.exit(0)
}

const baseline = existsSync(BASELINE_PATH)
  ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
  : {}

const worse = []   // [{ rule, file, was, now }]
const better = []  // [{ rule, was, now }] — rule-level totals
for (const rule of RULES) {
  const nowFiles = counts[rule.id] ?? {}
  const wasFiles = baseline[rule.id] ?? {}
  for (const [file, now] of Object.entries(nowFiles)) {
    const was = wasFiles[file] ?? 0
    if (now > was) worse.push({ rule, file, was, now })
  }
  const nowTotal = totalFor(rule.id)
  const wasTotal = Object.values(wasFiles).reduce((a, b) => a + b, 0)
  if (nowTotal < wasTotal) better.push({ rule, was: wasTotal, now: nowTotal })
}

if (listMode) {
  for (const [id, hits] of byRule) {
    if (!hits.length) continue
    console.error(`  ${id} — ${hits[0].rule.why}`)
    for (const h of hits) console.error(`    ${h.rel}:${h.line}  ${h.hit}   ${h.text}`)
    console.error('')
  }
}

for (const b of better) {
  console.log(`OPERATOR lint: ${b.rule.id} improved ${b.was} -> ${b.now}. Re-baseline to lock it in:`)
  console.log('  node scripts/operator-lint.mjs --baseline')
}

if (!worse.length) {
  console.log(`OPERATOR lint: no new drift — ${findings.length} known violation(s) across ${files.length} UI files.`)
  process.exit(0)
}

console.error(`\nOPERATOR lint: NEW drift in ${worse.length} file(s).\n`)
for (const w of worse) {
  console.error(`  ${w.file} — ${w.rule.id} was ${w.was}, now ${w.now}`)
  console.error(`    ${w.rule.why}`)
  for (const h of byRule.get(w.rule.id).filter(h => h.rel === w.file)) {
    console.error(`    ${w.file}:${h.line}  ${h.hit}   ${h.text}`)
  }
  console.error('')
}
console.error('Fix the new occurrences, add a documented exception in')
console.error('scripts/operator-lint.mjs, or mark the line `operator-lint-disable`.')
process.exit(1)
