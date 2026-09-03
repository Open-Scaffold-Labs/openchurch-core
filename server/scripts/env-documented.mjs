#!/usr/bin/env node
// Env tripwire — every environment variable the server actually reads
// must be documented in server/.env.example.
//
// The failure this exists to prevent: a variable is added in code, works
// on the machine where it was written because that shell already has it,
// and is invisible to everyone else. It doesn't crash — it silently
// selects the fallback branch. RESEND_API_KEY was exactly this: eight
// markdown files described it and the one file a developer copies did
// not, so the honest reading of `.env.example` was "email has no live
// transport", which was false.
//
// A variable counts as DOCUMENTED if `.env.example` has a line
//   NAME=            or  # NAME=
// (commented-out entries count — they document the name and that it is
// optional, which is the whole point).
//
// A variable counts as READ if `process.env.NAME` appears on a line that
// is not itself a comment. Comment detection is deliberately shallow:
// a line whose first non-whitespace is //, * or /* is a comment. That is
// enough for this codebase's heavy block-comment style and it is the
// reason PRICE_ID_PRO — which appears only inside a prose comment in
// billing/plans.js — is not treated as a real read. A `process.env.X`
// buried mid-line after code on the same line as a trailing comment
// would be counted as read; that direction is the safe one to be wrong in.
//
// Platform-injected variables are allowlisted: nobody sets NODE_ENV or
// VERCEL_GIT_COMMIT_SHA in a .env file, and listing them would teach the
// wrong thing.
//
// Runs in CI with no database. Exit 1 on any violation.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC_DIR    = join(SERVER_DIR, 'src')
const EXAMPLE    = join(SERVER_DIR, '.env.example')

// Set by the runtime or the deploy platform, never by a developer in a
// .env file. Documenting these would imply they are yours to configure.
const PLATFORM_INJECTED = new Set([
  'NODE_ENV',
  'VERCEL_ENV',
  'VERCEL_GIT_COMMIT_SHA',
  'GIT_COMMIT_SHA',
  'SOURCE_COMMIT',
])

function jsFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...jsFiles(full))
    else if (entry.endsWith('.js')) out.push(full)
  }
  return out
}

function isCommentLine(line) {
  const t = line.trimStart()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

// ── Collect what the code reads ──────────────────────────────────
const readVars = new Map() // NAME -> "path:line"
for (const file of jsFiles(SRC_DIR)) {
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, i) => {
    if (isCommentLine(line)) return
    for (const m of line.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
      const name = m[1]
      if (!readVars.has(name)) {
        readVars.set(name, `${relative(SERVER_DIR, file)}:${i + 1}`)
      }
    }
  })
}

// ── Collect what the example documents ───────────────────────────
const documented = new Set()
for (const line of readFileSync(EXAMPLE, 'utf8').split('\n')) {
  const m = line.match(/^\s*#?\s*([A-Z0-9_]+)\s*=/)
  if (m) documented.add(m[1])
}

// ── Compare ──────────────────────────────────────────────────────
const missing = []
for (const [name, where] of readVars) {
  if (PLATFORM_INJECTED.has(name)) continue
  if (!documented.has(name)) missing.push({ name, where })
}
missing.sort((a, b) => a.name.localeCompare(b.name))

// Documented-but-never-read is a warning, not a failure: an entry may be
// a deliberate placeholder for a provider not yet wired. It is still
// worth printing, because the other way this file rots is accumulating
// names that no longer mean anything.
const stale = [...documented]
  .filter(n => !readVars.has(n) && !PLATFORM_INJECTED.has(n))
  .sort()

console.log(`env-documented: ${readVars.size} variables read across src/, ${documented.size} documented in .env.example`)

if (stale.length) {
  console.log(`\n  note — documented but never read (${stale.length}):`)
  for (const n of stale) console.log(`    ${n}`)
}

if (missing.length) {
  console.error(`\n✗ ${missing.length} environment variable(s) read by the server but absent from server/.env.example:\n`)
  for (const { name, where } of missing) console.error(`    ${name.padEnd(28)} first read at ${where}`)
  console.error(`
  Add each to server/.env.example — commented out (# NAME=) if optional.
  If a variable is injected by the platform rather than set by a developer,
  add it to PLATFORM_INJECTED in this script instead, with a reason.
`)
  process.exit(1)
}

console.log('\n✓ every variable the server reads is documented')
