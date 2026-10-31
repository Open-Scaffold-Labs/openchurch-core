import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('./typescale-lint.mjs', import.meta.url))

test('typescale lint exits 0 on clean tree (this repo)', () => {
  const r = spawnSync('node', [SCRIPT], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr || r.stdout)
  assert.match(r.stdout, /clean/)
})

test('typescale lint --list never fails', () => {
  const r = spawnSync('node', [SCRIPT, '--list'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr || r.stdout)
})

// Red/green: a planted text-[10px] must fail the lint (proves the regex
// matches after `]`, which a trailing \b never would).
test('typescale lint fails when a banned text-[10px] is present', () => {
  const dir = join(tmpdir(), `typescale-probe-${process.pid}-${Date.now()}`)
  mkdirSync(join(dir, 'client/src'), { recursive: true })
  mkdirSync(join(dir, 'client-diocese/src'), { recursive: true })
  writeFileSync(
    join(dir, 'client/src/probe.jsx'),
    'export const label = "text-[10px] uppercase"\n',
  )
  try {
    const r = spawnSync('node', [SCRIPT], { cwd: dir, encoding: 'utf8' })
    assert.notEqual(r.status, 0, 'expected non-zero when text-[10px] is present')
    const out = `${r.stdout || ''}${r.stderr || ''}`
    assert.match(out, /text-\[10px\]/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
