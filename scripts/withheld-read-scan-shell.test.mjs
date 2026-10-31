// R335-6: the snapshot's withheld-read block, run through bash exactly as
// push-public-snapshot.sh has it (extracted between its >>> / <<< markers).
// A scanner that crashes with empty stdout must fail closed, not pass.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const SCRIPT = process.env.SNAPSHOT_SCRIPT || join(here, '..', 'push-public-snapshot.sh')
// The snapshot script is withheld from the public snapshot itself, so this
// file is a no-op there; in the private repo a missing script is a failure.
const PRIVATE_MAP = 'CURRENT-EXECUTION-MAP.md'
const PUBLIC_SNAPSHOT = !existsSync(SCRIPT) && !existsSync(join(here, '..', 'docs', PRIVATE_MAP))
const src = PUBLIC_SNAPSHOT ? '' : readFileSync(SCRIPT, 'utf8')
const block = src.slice(src.indexOf('# >>> withheld-read-scan'), src.indexOf('# <<< withheld-read-scan'))
const t = PUBLIC_SNAPSHOT ? test.skip : test

function run(tree, scanner) {
  const prog = `set -eo pipefail\nfail_check() { echo "  ✗ $1 — stopping"; exit 1; }\nSRC=${JSON.stringify(join(here, '..'))}\ncd ${JSON.stringify(tree)}\n${block}\necho SENTINEL_PASSED\n`
  return spawnSync('bash', ['--noprofile', '--norc', '-c', prog], { encoding: 'utf8', env: { ...process.env, ...(scanner ? { WRS_SCANNER: scanner } : {}) } })
}
function tree(withRead) {
  const t = mkdtempSync(join(tmpdir(), 'wrs-sh-'))
  mkdirSync(join(t, 'src'))
  const J = (...a) => 'jo' + 'in(' + a.join(', ') + ')'
  writeFileSync(join(t, 'src', 'a.test.js'), withRead ? J('here', "'..'", "'docs'", "'gone'", "'X.md'") + '\n' : 'ok\n')
  return t
}

t('block is present in the snapshot script', () => { assert.ok(block.length > 50) })

t('clean tree passes', () => {
  const r = run(tree(false))
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /SENTINEL_PASSED/)
})

t('a withheld-document read fails with the finding shown', () => {
  const r = run(tree(true))
  assert.notEqual(r.status, 0)
  assert.doesNotMatch(r.stdout, /SENTINEL_PASSED/)
  assert.match(r.stdout, /reads withheld docs\/gone\/X\.md/)
})

t('a missing scanner fails closed', () => {
  const r = run(tree(false), '/nonexistent/withheld-read-scan.mjs')
  assert.notEqual(r.status, 0)
  assert.doesNotMatch(r.stdout, /SENTINEL_PASSED/)
  assert.match(r.stdout, /scanner did not complete|MODULE_NOT_FOUND|Cannot find module/)
})

t('a throwing scanner with empty stdout fails closed', () => {
  const d = mkdtempSync(join(tmpdir(), 'wrs-bad-'))
  const bad = join(d, 'bad.mjs')
  writeFileSync(bad, "throw new Error('boom')\n")
  const r = run(tree(false), bad)
  assert.notEqual(r.status, 0)
  assert.doesNotMatch(r.stdout, /SENTINEL_PASSED/)
})
