#!/usr/bin/env node
// prepush — the cheap local checks to run BEFORE `git push`, so a change set
// goes to CI once and green instead of being pushed, failed and pushed again.
//
//   npm run check:prepush                 # changes vs origin/main
//   npm run check:prepush -- --base main  # another base
//
// WHY. GitHub bills every CI job rounded up to a whole minute, and every push
// to a PR is a full gate run (~10 min). Most red runs this repo has had were
// one of the dependency-free gates below, which fail here in about a second.
//
// WHAT RUNS.
//   always   lint:honest (+ its regressions), lint:operator, lint:api-shape,
//            scripts/ci-scope.test.mjs
//   client/          lint:client-scope, lint:i18n-critical, and the client
//                    tests RELATED to the changed client files
//   client-diocese/  the chancery tests related to the changed files
//   server/          the server tests related to the changed server files —
//                    ONLY against a loopback DATABASE_URL (see below)
//
// WHAT IT IS NOT. Not the full gate and not a substitute for CI: no builds, no
// full suites, no Tenant-FK or money audits. A step that cannot run here is
// printed as NOT RUN with the reason; NOT RUN is not PASS. Not a git hook:
// nothing runs unless you call it.
//
// DATABASE SAFETY. Server tests write to the database they are given. This
// script runs them only when DATABASE_URL classifies as loopback through the
// same guard the recovery tooling uses (scripts/lib/db-target-guard.mjs). It
// never reads server/.env. Start one with `node scripts/local-db.mjs up`, then
// `eval "$(node scripts/local-db.mjs env)"`.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyDatabaseUrl } from './lib/db-target-guard.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const baseIdx = args.indexOf('--base')
const BASE = baseIdx >= 0 ? args[baseIdx + 1] : 'origin/main'

const results = []
const record = (name, state, note = '') => results.push({ name, state, note })

function git(...a) {
  const r = spawnSync('git', a, { cwd: ROOT, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${a.join(' ')} failed: ${r.stderr.trim()}`)
  return r.stdout
}

function run(name, cmd, cmdArgs, { cwd = ROOT, env = process.env } = {}) {
  console.log(`\n── ${name}\n   $ ${[cmd, ...cmdArgs].join(' ')}${cwd === ROOT ? '' : `   (in ${relative(ROOT, cwd)})`}`)
  const r = spawnSync(cmd, cmdArgs, { cwd, env, stdio: 'inherit', shell: process.platform === 'win32' })
  record(name, r.status === 0 ? 'PASS' : 'FAIL', r.status === 0 ? '' : `exit ${r.status ?? r.signal}`)
}

// ── What changed: committed since the merge base, plus the working tree ──
let changed
try {
  const mb = git('merge-base', BASE, 'HEAD').trim()
  const committedAndWorking = git('diff', '--no-renames', '--name-only', mb).split('\n')
  const untracked = git('ls-files', '--others', '--exclude-standard').split('\n')
  changed = [...new Set([...committedAndWorking, ...untracked].filter(Boolean))]
} catch (e) {
  console.error(`prepush: cannot list changes against ${BASE}: ${e.message}`)
  console.error('         fetch it first (git fetch origin main) or pass --base <ref>.')
  process.exit(2)
}
console.log(`prepush: ${changed.length} changed file(s) vs ${BASE}`)
for (const f of changed) console.log(`  ${f}`)
if (git('status', '--porcelain').trim()) {
  console.log('  (includes uncommitted changes — commit them before you push)')
}

const under = (dir) => changed.filter((f) => f.startsWith(`${dir}/`) && existsSync(join(ROOT, f)))
const SRC_EXT = /\.(m?[jt]sx?|cjs)$/

// ── Always: the dependency-free gates CI runs first ──
run('Honest failure (lint:honest)', 'npm', ['run', '-s', 'lint:honest'])
run('Honest failure regressions', 'node', ['--test', 'scripts/honest-failure.test.mjs'])
run('OPERATOR lint', 'npm', ['run', '-s', 'lint:operator'])
run('API shape', 'npm', ['run', '-s', 'lint:api-shape'])
run('CI scope regressions', 'node', ['--test', 'scripts/ci-scope.test.mjs'])

// ── Focused tests per app ──
function related(app, label, { env, extra = [] } = {}) {
  const files = under(app).filter((f) => SRC_EXT.test(f)).map((f) => relative(app, f))
  if (files.length === 0) return
  if (!existsSync(join(ROOT, app, 'node_modules'))) {
    record(`${label} related tests`, 'NOT RUN', `${app}/node_modules missing — run: npm install --prefix ${app}`)
    return
  }
  run(`${label} related tests (${files.length} changed file(s))`, 'npx',
    ['vitest', 'related', '--run', ...extra, ...files], { cwd: join(ROOT, app), env })
}

if (under('client').length) {
  if (existsSync(join(ROOT, 'client', 'node_modules'))) {
    run('Client scope', 'npm', ['run', '-s', 'lint:client-scope'])
    run('Critical-surface i18n', 'npm', ['run', '-s', 'lint:i18n-critical'])
  } else {
    record('Client scope + i18n', 'NOT RUN', 'client/node_modules missing — run: npm install --prefix client')
  }
  related('client', 'Parish client')
}
related('client-diocese', 'Chancery client')

if (under('server').some((f) => SRC_EXT.test(f))) {
  const db = classifyDatabaseUrl(process.env.DATABASE_URL)
  if (db.kind !== 'local') {
    record('Server related tests', 'NOT RUN',
      `DATABASE_URL is ${db.kind}; server tests run only against loopback — ` +
      'node scripts/local-db.mjs up && eval "$(node scripts/local-db.mjs env)"')
  } else {
    const env = {
      ...process.env,
      NODE_ENV: 'test',
      JWT_SECRET: process.env.JWT_SECRET || 'prepush-test-secret-not-used-in-prod',
      CHECKIN_CODE_PEPPER: process.env.CHECKIN_CODE_PEPPER || 'prepush-test-pepper-not-used-in-prod',
    }
    // One file at a time: some server files must not share the database with
    // a parallel worker (see the serial group in server/package.json).
    related('server', 'Server', { env, extra: ['--testTimeout=15000', '--no-file-parallelism'] })
  }
}

// ── Summary ──
console.log('\nprepush summary')
for (const r of results) console.log(`  ${r.state.padEnd(7)} ${r.name}${r.note ? ` — ${r.note}` : ''}`)
const failed = results.filter((r) => r.state === 'FAIL').length
const notRun = results.filter((r) => r.state === 'NOT RUN').length
console.log(failed
  ? `\n✗ ${failed} check(s) failed — fix before pushing.`
  : `\n✓ no failures${notRun ? ` (${notRun} NOT RUN — not a pass; say so in the PR's "Couldn't verify")` : ''}.`)
process.exit(failed ? 1 : 0)
