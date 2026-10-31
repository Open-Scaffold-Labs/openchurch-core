// Regressions for scripts/withheld-read-scan.mjs (R335-1).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { docReads, scan } from './withheld-read-scan.mjs'

// Fixture sources are assembled at runtime so this file never contains a
// literal join(...) of a withheld document (the scanner would flag itself).
const J = (...a) => 'jo' + 'in(' + a.join(', ') + ')'

test('segment form with relative hops is resolved', () => {
  const r = docReads('const x = readFileSync(' + J('here', "'..'", "'..'", "'..'", "'docs'", "'stage11-12'", "'CLAIMS-REGISTER-DRAFT.md'") + ", 'utf8')")
  assert.deepEqual(r, [{ line: 1, doc: 'docs/stage11-12/CLAIMS-REGISTER-DRAFT.md' }])
})

test('single literal path form is resolved', () => {
  assert.deepEqual(docReads(J('ROOT', "'docs/BRAND.md'")), [{ line: 1, doc: 'docs/BRAND.md' }])
})

test('non-md joins are ignored', () => {
  assert.deepEqual(docReads(J('here', "'..'", "'App.jsx'")), [])
})

test('scan flags a withheld doc and passes a present one', () => {
  const root = mkdtempSync(join(tmpdir(), 'wrs-'))
  mkdirSync(join(root, 'docs'), { recursive: true })
  mkdirSync(join(root, 'src'))
  const pub = 'PUBLIC.md'
  writeFileSync(join(root, 'docs', pub), 'x')
  writeFileSync(join(root, 'src', 'a.test.jsx'), J('here', "'..'", "'docs'", "'PUBLIC.md'") + '\n' + J('here', "'..'", "'docs'", "'private'", "'GONE.md'") + '\n')
  assert.deepEqual(scan(root), ['src/a.test.jsx:2 reads withheld docs/private/GONE.md'])
})
