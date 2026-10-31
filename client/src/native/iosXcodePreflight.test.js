import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseXcodeVersion, xcodeMeetsMinimum } from '../../scripts/ios-xcode-preflight.mjs'

const script = join(dirname(fileURLToPath(import.meta.url)), '../../scripts/ios-xcode-preflight.mjs')

function withXcodebuild(output, status = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'oc-xcode-'))
  const bin = join(dir, 'xcodebuild')
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(output)}\nexit ${status}\n`)
  chmodSync(bin, 0o755)
  const run = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { PATH: dir, HOME: process.env.HOME },
  })
  rmSync(dir, { recursive: true, force: true })
  return run
}

describe('Xcode prerequisite', () => {
  it('accepts 26 and refuses 16', () => {
    expect(parseXcodeVersion('Xcode 26.0\nBuild version 17A400\n')).toEqual({ major: 26, minor: 0 })
    expect(xcodeMeetsMinimum('Xcode 26.1\n').ok).toBe(true)
    const old = xcodeMeetsMinimum('Xcode 16.4\nBuild version 16F6\n')
    expect(old.ok).toBe(false)
    expect(old.reason).toContain('16.4')
    expect(xcodeMeetsMinimum('no xcode').ok).toBe(false)
  })

  it('stops the Mac preflight for an older Xcode and continues for 26', () => {
    const old = withXcodebuild('Xcode 16.4\nBuild version 16F6')
    expect(old.status).toBe(2)
    expect(old.stderr).toContain('below 26')
    expect(old.stderr).toContain('NOT MEASURED')
    const current = withXcodebuild('Xcode 26.0\nBuild version 17A400')
    expect(current.status).toBe(0)
    expect(current.stdout).toContain('NOT MEASURED')
    const missing = withXcodebuild('', 1)
    expect(missing.status).toBe(2)
    expect(missing.stderr).toContain('NOT MEASURED')
  })
})
