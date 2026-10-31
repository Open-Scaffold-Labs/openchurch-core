// Mac check before opening the iOS project. Capacitor 8.5.3 needs Xcode 26
// or newer. This does not compile, sign, or launch anything.
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export function parseXcodeVersion(text) {
  const match = /Xcode (\d+)(?:\.(\d+))?/.exec(String(text || ''))
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2] || 0) }
}

export function xcodeMeetsMinimum(text) {
  const version = parseXcodeVersion(text)
  if (!version) return { ok: false, reason: 'Xcode version was not reported' }
  if (version.major < 26) {
    return { ok: false, reason: `Xcode ${version.major}.${version.minor} is below 26` }
  }
  return { ok: true, version }
}

function main() {
  const run = spawnSync('xcodebuild', ['-version'], { encoding: 'utf8' })
  if (run.error || run.status !== 0) {
    console.error('refusing: xcodebuild did not report a version. Xcode 26 or newer is required. Native compile is NOT MEASURED.')
    process.exit(2)
  }
  const verdict = xcodeMeetsMinimum(`${run.stdout || ''}\n${run.stderr || ''}`)
  if (!verdict.ok) {
    console.error(`refusing: ${verdict.reason}. Capacitor 8.5.3 needs Xcode 26 or newer. Native compile is NOT MEASURED.`)
    process.exit(2)
  }
  console.log(`Xcode ${verdict.version.major}.${verdict.version.minor} meets the Capacitor 8.5.3 prerequisite. Native compile is still NOT MEASURED.`)
}

const invoked = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invoked) main()
