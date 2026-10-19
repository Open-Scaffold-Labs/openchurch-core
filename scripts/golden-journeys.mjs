#!/usr/bin/env node
// Golden Journey proofs — one entry point for GJ1 + GJ2.
//
// WHY THIS EXISTS. Golden Journey 1 (book → sacristy sheet → print) and
// Golden Journey 2 (member → linked register → certificate → print) each
// have their own vitest file so a failure names the hop. Agents and
// developers were running them one at a time and missing the other.
// This script runs both, labels each result, and fails the process if
// either journey is not green.
//
// WHAT IT IS NOT. It does not merge fixtures, skip tests, or change
// product behaviour. Each journey still runs independently:
//   cd client && npm test -- src/pages/GoldenJourney1.test.jsx
//   cd client && npm test -- src/pages/GoldenJourney2.test.jsx
//
// Fixture convention (do not merge the files — the hops are different):
//   goldenJourney1.fixture.js — GJ1_*  Mass Intention → sheet → print
//   goldenJourney2.fixture.js — GJ2_*  Member → register → certificate
// Synthetic names only. St Test parish. No real parish / member / donor
// / child / sacramental data.
//
// Usage:
//   npm run test:golden                 (from repo root)
//   cd client && npm run test:golden
//   node scripts/golden-journeys.mjs
//
// Gate on the summary line (OPERATOR.md): a vitest process can exit 0
// after "Tests N skipped". We require each journey's summary to show
// passed tests and zero failures. Both journeys always run so a GJ1
// failure does not hide a GJ2 failure.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT = join(ROOT, 'client')

const JOURNEYS = [
  {
    id: 'GJ1',
    title: 'Golden Journey 1 — book → sacristy sheet → print',
    file: 'src/pages/GoldenJourney1.test.jsx',
  },
  {
    id: 'GJ2',
    title: 'Golden Journey 2 — member → linked register → certificate → print',
    file: 'src/pages/GoldenJourney2.test.jsx',
  },
]

function banner(text) {
  const line = '='.repeat(72)
  console.log(`\n${line}\n${text}\n${line}\n`)
}

function interpretSummary(output) {
  const lines = String(output).split(/\r?\n/)
  let summary = null
  for (const line of lines) {
    if (/^\s*Tests\s+/.test(line)) summary = line
  }
  if (!summary) {
    return { ok: false, reason: 'no Tests summary line — runner did not finish', summary: null }
  }
  const failed = /(\d+)\s+failed/.exec(summary)
  const passed = /(\d+)\s+passed/.exec(summary)
  const skipped = /(\d+)\s+skipped/.exec(summary)
  const failedN = failed ? Number(failed[1]) : 0
  const passedN = passed ? Number(passed[1]) : 0
  const skippedN = skipped ? Number(skipped[1]) : 0
  if (failedN > 0) {
    return { ok: false, reason: `${failedN} failed`, summary: summary.trim(), passedN, failedN, skippedN }
  }
  if (passedN < 1) {
    const why = skippedN > 0 ? `${skippedN} skipped, 0 passed` : '0 passed'
    return { ok: false, reason: why, summary: summary.trim(), passedN, failedN, skippedN }
  }
  return { ok: true, reason: `${passedN} passed`, summary: summary.trim(), passedN, failedN, skippedN }
}

function runJourney(journey) {
  const abs = join(CLIENT, journey.file)
  if (!existsSync(abs)) {
    return {
      ...journey,
      ok: false,
      reason: `missing ${journey.file}`,
      summary: null,
      output: '',
    }
  }

  const result = spawnSync('npm', ['test', '--', journey.file], {
    cwd: CLIENT,
    encoding: 'utf8',
    env: process.env,
  })
  const output = `${result.stdout || ''}${result.stderr || ''}`
  process.stdout.write(result.stdout || '')
  if (result.stderr) process.stderr.write(result.stderr)
  const interpreted = interpretSummary(output)
  if (result.error) {
    return {
      ...journey,
      ok: false,
      reason: result.error.message,
      summary: interpreted.summary,
      output,
    }
  }
  return { ...journey, ...interpreted, output }
}

if (!existsSync(join(CLIENT, 'package.json'))) {
  console.error(`client/package.json not found next to ${ROOT}`)
  process.exit(1)
}

const results = []
for (const journey of JOURNEYS) {
  banner(`${journey.id}: ${journey.title}`)
  results.push(runJourney(journey))
}

banner('Golden Journey summary')
for (const r of results) {
  const mark = r.ok ? 'PASS' : 'FAIL'
  const detail = r.summary || r.reason
  console.log(`${mark}  ${r.id}  ${r.title}`)
  console.log(`      ${detail}`)
}

const failed = results.filter(r => !r.ok)
if (failed.length) {
  console.log('')
  console.log(`${failed.length} of ${results.length} Golden Journeys failed: ${failed.map(r => r.id).join(', ')}`)
  process.exit(1)
}

console.log('')
console.log('Both Golden Journeys passed.')
