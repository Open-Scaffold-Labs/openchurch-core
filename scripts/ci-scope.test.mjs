// Regressions for scripts/ci-scope.sh — the CI gate's docs-only decision.
//
// Each case builds a throwaway git repo shaped like a PR merge commit
// (HEAD^1 = base tip, HEAD = merge of the PR branch), then runs the script
// EXACTLY as GitHub's `shell: bash` does: bash --noprofile --norc -eo
// pipefail. R323-1 was a script that passed by eye and under plain `bash`
// but exited 1 with no outputs under -e on the docs-only path, so the shell
// flags are the point of this file, not a detail.
//
// SCOPE_SCRIPT=/path/to/other.sh runs the same cases against another
// implementation (used to show the pre-fix logic fails here).
//
//   node --test scripts/ci-scope.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(process.env.SCOPE_SCRIPT || join(HERE, 'ci-scope.sh'))
const RUNNER_SHELL = ['--noprofile', '--norc', '-eo', 'pipefail']

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1', HOME: tmpdir(),
}

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout
}

function put(root, rel, body) {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), body)
}

// Base tree: one doc a test reads (by literal path, the way client tests
// read docs/*.md), one doc nothing reads, and some code.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ci-scope-'))
  git(root, 'init', '-q', '-b', 'main')
  put(root, 'docs/ZZFIX-READ-BY-TEST.md', '# read by a test\n')
  put(root, 'docs/ZZFIX-UNREFERENCED.md', '# nobody reads this\n')
  put(root, 'client/src/zzfix.test.js', "readFileSync('docs/ZZFIX-READ-BY-TEST.md')\n")
  put(root, 'server/src/app.js', 'export default 1\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'base')
  return root
}

// Make the PR commit on a branch, then a --no-ff merge onto main, which is
// what actions/checkout gives a pull_request run (refs/pull/N/merge).
function prMerge(root, change) {
  git(root, 'checkout', '-q', '-b', 'pr')
  change(root)
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'pr')
  git(root, 'checkout', '-q', 'main')
  git(root, 'merge', '-q', '--no-ff', '--no-edit', 'pr')
}

function runScope(root, event) {
  const out = join(root, '.gh-output')
  rmSync(out, { force: true })
  const r = spawnSync('bash', [...RUNNER_SHELL, SCRIPT], {
    cwd: root, encoding: 'utf8',
    env: { ...GIT_ENV, GITHUB_EVENT_NAME: event, GITHUB_OUTPUT: out },
  })
  const outputs = existsSync(out)
    ? Object.fromEntries(readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map(l => l.split('=')))
    : {}
  return { status: r.status, outputs, log: r.stdout + r.stderr }
}

function expectScope(event, change, scope) {
  const root = fixture()
  try {
    prMerge(root, change)
    const r = runScope(root, event)
    assert.equal(r.status, 0, `script exited ${r.status} under bash -eo pipefail\n${r.log}`)
    assert.deepEqual(r.outputs, { scope, run: scope === 'full' ? 'true' : 'false' }, r.log)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const editUnreferenced = (root) => put(root, 'docs/ZZFIX-UNREFERENCED.md', '# edited\n')

test('pull_request: unreferenced doc only -> docs-only', () =>
  expectScope('pull_request', editUnreferenced, 'docs-only'))

test('pull_request: new unreferenced top-level .md -> docs-only', () =>
  expectScope('pull_request', (root) => put(root, 'ZZFIX-TOP-LEVEL-NOTE.md', 'x\n'), 'docs-only'))

test('pull_request: doc a test reads -> full', () =>
  expectScope('pull_request', (root) => put(root, 'docs/ZZFIX-READ-BY-TEST.md', '# edited\n'), 'full'))

test('pull_request: renamed doc a test reads -> full (old path is listed)', () =>
  expectScope('pull_request', (root) =>
    git(root, 'mv', 'docs/ZZFIX-READ-BY-TEST.md', 'docs/ZZFIX-MOVED-AWAY.md'), 'full'))

test('pull_request: deleted doc a test reads -> full', () =>
  expectScope('pull_request', (root) => git(root, 'rm', '-q', 'docs/ZZFIX-READ-BY-TEST.md'), 'full'))

test('pull_request: code only -> full', () =>
  expectScope('pull_request', (root) => put(root, 'server/src/app.js', 'export default 2\n'), 'full'))

test('pull_request: unreferenced doc + code -> full', () =>
  expectScope('pull_request', (root) => {
    editUnreferenced(root)
    put(root, 'server/src/app.js', 'export default 2\n')
  }, 'full'))

test('pull_request: .md inside a code directory -> full', () =>
  expectScope('pull_request', (root) => put(root, 'client/ZZFIX-NOTES.md', 'x\n'), 'full'))

test('push (main) with an unreferenced doc only -> full', () =>
  expectScope('push', editUnreferenced, 'full'))

test('workflow_dispatch with an unreferenced doc only -> full', () =>
  expectScope('workflow_dispatch', editUnreferenced, 'full'))

test('pull_request without a merge parent (HEAD^1 missing) -> full', () => {
  const root = fixture()
  try {
    const r = runScope(root, 'pull_request')
    assert.equal(r.status, 0, r.log)
    assert.deepEqual(r.outputs, { scope: 'full', run: 'true' }, r.log)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
