// honest-failure gate: a baseline entry that no longer matches code is
// STALE and fails the gate, because it would pre-approve that exact code if
// it were written back. Runs the real script against throwaway trees.
//   node --test scripts/honest-failure.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'honest-failure.mjs')
const BAD = "    .then(r => (r.ok ? r.json() : { conflicts: [] }))\n"
const GOOD = "    .then(r => { if (!r.ok) throw new Error('x'); return r.json() })\n"

function tree(files, baseline) {
  const root = mkdtempSync(join(tmpdir(), 'hf-'))
  mkdirSync(join(root, 'client/src'), { recursive: true })
  mkdirSync(join(root, 'client-diocese/src'), { recursive: true })
  mkdirSync(join(root, 'scripts'), { recursive: true })
  for (const [p, body] of Object.entries(files)) writeFileSync(join(root, p), body)
  if (baseline) writeFileSync(join(root, 'scripts/honest-failure-baseline.json'), JSON.stringify(baseline))
  return root
}
const run = (root, ...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: 'utf8' })
const KEY = 'ternary-empty client/src/pages/Schedule.jsx :: .then(r => (r.ok ? r.json() : { conflicts: [] }))'

test('baseline equal to the findings passes', () => {
  const root = tree({ 'client/src/Schedule.jsx': BAD }, null)
  try {
    assert.equal(run(root, '--baseline').status, 0)
    const r = run(root)
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /1 known site\(s\), no new drift, no stale entries/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a fixed site whose entry was not pruned fails as STALE', () => {
  const root = tree({ 'client/src/pages.jsx': GOOD }, [KEY])
  try {
    const r = run(root)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /1 STALE baseline entry/)
    assert.ok(r.stderr.includes(KEY))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('after pruning, the same code written back is a NEW site', () => {
  const root = tree({ 'client/src/Schedule.jsx': BAD }, [])
  try {
    const r = run(root)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /1 new site\(s\)/)
    assert.match(r.stderr, /Schedule\.jsx:1 {2}\[ternary-empty\]/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('the repository baseline has no stale entries', () => {
  const repo = join(dirname(SCRIPT), '..')
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: repo, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const baseline = JSON.parse(readFileSync(join(repo, 'scripts/honest-failure-baseline.json'), 'utf8'))
  assert.match(r.stdout, new RegExp(`${baseline.length} known site\\(s\\), no new drift, no stale entries`))
})
