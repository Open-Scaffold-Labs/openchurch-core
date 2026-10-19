#!/usr/bin/env node
// DEMO-L1-08 — deterministic Golden Journey rehearsal.
//
// Default (--proof) runs the existing GJ1 + GJ2 vitest hops, then the
// GJ2 certificate-path file that test:golden does not include. No
// database. No server/.env. Safe on any machine that can run client tests.
//
// --local-db is opt-in and fail-closed:
//   - OCHR_REHEARSAL must be exactly `local`
//   - DATABASE_URL must be set and loopback (localhost / 127.0.0.1 / ::1)
// It never seeds, never migrates, never calls seedStBrigids, and never
// reads server/.env. A remote or missing URL exits 2.
//
// This is not a production reset. This is not a credential surface.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  LOOPBACK,
  classifyDatabaseUrl,
  isLoopbackHost,
  requireLocalRehearsal,
} from './lib/db-target-guard.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT = join(ROOT, 'client')
const GOLDEN = join(ROOT, 'scripts', 'golden-journeys.mjs')
const GJ2_PATH = 'src/pages/GoldenJourney2Path.test.jsx'

export { LOOPBACK, classifyDatabaseUrl, isLoopbackHost }

export function allowLocalDb({ rehearsal, databaseUrl } = {}) {
  const gate = requireLocalRehearsal({
    rehearsal,
    urls: [{ label: 'DATABASE_URL', url: databaseUrl }],
  })
  if (!gate.ok) {
    // Keep the DEMO-L1-08 --local-db wording stable for existing tests.
    if (rehearsal !== 'local') {
      return {
        ok: false,
        code: 2,
        reason: 'OCHR_REHEARSAL must be exactly "local" before --local-db. Refusing.',
      }
    }
    if (classifyDatabaseUrl(databaseUrl).kind === 'missing') {
      return {
        ok: false,
        code: 2,
        reason: 'DATABASE_URL is missing. Set a loopback URL (or `node scripts/local-db.mjs env`) and retry. Refusing.',
      }
    }
    return {
      ok: false,
      code: 2,
      reason: `DATABASE_URL host ${classifyDatabaseUrl(databaseUrl).hostname || '(unparseable)'} is not loopback. Refusing — rehearsal cannot target production or a shared database.`,
    }
  }
  return { ok: true, code: 0, reason: `loopback ${classifyDatabaseUrl(databaseUrl).hostname}` }
}

export function parseArgs(argv) {
  const args = argv.slice(2)
  const localDb = args.includes('--local-db')
  const proofFlag = args.includes('--proof')
  return {
    help: args.includes('--help') || args.includes('-h'),
    localDb,
    // Bare invocation is --proof. --local-db alone is the identity gate only.
    proof: proofFlag || args.length === 0,
  }
}

function interpretSummary(output) {
  const lines = String(output).split(/\r?\n/)
  let summary = null
  for (const line of lines) {
    if (/^\s*Tests\s+/.test(line)) summary = line
  }
  if (!summary) return { ok: false, reason: 'no Tests summary line', summary: null }
  const failed = /(\d+)\s+failed/.exec(summary)
  const passed = /(\d+)\s+passed/.exec(summary)
  const failedN = failed ? Number(failed[1]) : 0
  const passedN = passed ? Number(passed[1]) : 0
  if (failedN > 0) return { ok: false, reason: `${failedN} failed`, summary: summary.trim() }
  if (passedN < 1) return { ok: false, reason: '0 passed', summary: summary.trim() }
  return { ok: true, reason: `${passedN} passed`, summary: summary.trim() }
}

function runProof() {
  if (!existsSync(GOLDEN)) {
    console.error('demo-rehearsal: missing scripts/golden-journeys.mjs')
    return 1
  }
  console.log('demo-rehearsal: --proof (no database, no seed, no server/.env)')
  const golden = spawnSync(process.execPath, [GOLDEN], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
    stdio: 'inherit',
  })
  if (golden.status !== 0) return golden.status ?? 1

  const pathFile = join(CLIENT, GJ2_PATH)
  if (!existsSync(pathFile)) {
    console.error(`demo-rehearsal: missing ${GJ2_PATH}`)
    return 1
  }
  console.log('\n==== GJ2-PATH: certificate-path localization (not in test:golden) ====\n')
  const pathRun = spawnSync('npm', ['test', '--', GJ2_PATH], {
    cwd: CLIENT,
    encoding: 'utf8',
    env: process.env,
  })
  process.stdout.write(pathRun.stdout || '')
  if (pathRun.stderr) process.stderr.write(pathRun.stderr)
  const interpreted = interpretSummary(`${pathRun.stdout || ''}${pathRun.stderr || ''}`)
  if (!interpreted.ok) {
    console.error(`demo-rehearsal: GJ2-PATH ${interpreted.reason}`)
    return 1
  }
  console.log(`demo-rehearsal: GJ2-PATH ${interpreted.reason}`)
  return 0
}

function runLocalDbGate() {
  const gate = allowLocalDb({
    rehearsal: process.env.OCHR_REHEARSAL,
    databaseUrl: process.env.DATABASE_URL,
  })
  if (!gate.ok) {
    console.error(`demo-rehearsal: ${gate.reason}`)
    return gate.code
  }
  console.log(`demo-rehearsal: --local-db allowed (${gate.reason}).`)
  console.log('              This rehearsal does not seed, migrate, or reset.')
  console.log('              Local forge (hard-coded loopback): node scripts/local-db.mjs up')
  console.log('              It never follows server/.env.')
  return 0
}

function printHelp() {
  console.log(`Usage: node scripts/demo-rehearsal.mjs [--proof] [--local-db]

  --proof      Default. Run Golden Journeys 1–2 + GJ2 path. No database.
  --local-db   Fail closed unless OCHR_REHEARSAL=local and DATABASE_URL is loopback.
               Does not seed, migrate, or reset.

See docs/DEMO-REHEARSAL.md.`)
}

const isMain = fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const opts = parseArgs(process.argv)
  if (opts.help) {
    printHelp()
    process.exit(0)
  }
  let code = 0
  if (opts.localDb) code = runLocalDbGate()
  if (code === 0 && opts.proof && !opts.localDb) code = runProof()
  if (code === 0 && opts.localDb && opts.proof && process.argv.includes('--proof')) {
    code = runProof()
  }
  process.exit(code)
}
