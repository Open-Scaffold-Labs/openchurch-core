// Build the parish client for the iOS shell and copy it into the
// Xcode project. Does not sign, archive, or upload.
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyArchiveAiCeiling } from '../src/native/nativeAiCeiling.js'
import { sealIosChildEnv } from '../src/native/iosSyncEnv.js'
import { stampOfflinePage } from '../src/native/offlinePage.js'
import { versionXcconfig } from '../src/native/iosVersion.js'

const root = dirname(fileURLToPath(import.meta.url))
const clientRoot = dirname(root)

let checked
let env
try {
  const sealed = sealIosChildEnv(process.env)
  checked = sealed.checked
  env = sealed.env
} catch (error) {
  console.error(error.message)
  process.exit(1)
}

function run(bin, args) {
  const result = spawnSync(bin, args, { cwd: clientRoot, env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const error = new Error(`${bin} exited ${result.status}`)
    error.status = result.status ?? 1
    throw error
  }
}

const vite = join(clientRoot, 'node_modules', '.bin', 'vite')
const cap = join(clientRoot, 'node_modules', '.bin', 'cap')
const configPath = join(clientRoot, 'capacitor.config.json')
const committed = readFileSync(configPath, 'utf8')
const versionPath = join(clientRoot, 'ios', 'Version.xcconfig')
let exitStatus = 0
try {
  // MARKETING_VERSION from package.json; CURRENT_PROJECT_VERSION from
  // OC_IOS_BUILD_NUMBER (default 1). Left in place for the Xcode build that
  // follows; do not commit a non-1 build number.
  const pkg = JSON.parse(readFileSync(join(clientRoot, 'package.json'), 'utf8'))
  writeFileSync(versionPath, versionXcconfig(pkg.version, process.env))
  run(vite, ['build'])
  const offline = readFileSync(join(clientRoot, 'ios-shell', 'offline.html'), 'utf8')
  writeFileSync(
    join(clientRoot, 'dist', 'offline.html'),
    stampOfflinePage(offline, checked.server?.url || ''),
  )
  const config = JSON.parse(committed)
  config.server = { errorPath: 'offline.html', ...(checked.server ?? {}) }
  // The user-agent token is the archive ceiling. A later hosted bundle
  // cannot change it. OC_IOS_AI_CEILING is read here, not by Vite.
  const archived = applyArchiveAiCeiling(config, process.env)
  writeFileSync(configPath, `${JSON.stringify(archived, null, 2)}\n`)
  run(cap, ['sync', 'ios'])
} catch (error) {
  console.error(error.message)
  exitStatus = error.status || 1
} finally {
  writeFileSync(configPath, committed)
}
process.exit(exitStatus)
