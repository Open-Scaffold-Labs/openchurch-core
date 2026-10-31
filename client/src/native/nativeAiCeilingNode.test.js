// ios:sync is plain Node, not Vite. An extensionless import loads in the
// client test runner and fails at `node scripts/ios-sync.mjs`.
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const clientRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')

describe('ios:sync modules load in plain Node', () => {
  it('imports the archive ceiling and the other sync modules without Vite', () => {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { applyArchiveAiCeiling, NATIVE_SHELL_UA } from './src/native/nativeAiCeiling.js'
      import { sealIosChildEnv } from './src/native/iosSyncEnv.js'
      import { stampOfflinePage } from './src/native/offlinePage.js'
      import { versionXcconfig } from './src/native/iosVersion.js'
      const archived = applyArchiveAiCeiling({ server: { url: 'https://parish.example' } }, {})
      if (archived.appendUserAgent !== NATIVE_SHELL_UA) throw new Error('excluded archive lost its user agent')
      if (typeof sealIosChildEnv !== 'function') throw new Error('sealIosChildEnv missing')
      if (typeof stampOfflinePage !== 'function') throw new Error('stampOfflinePage missing')
      if (typeof versionXcconfig !== 'function') throw new Error('versionXcconfig missing')
    `], { cwd: clientRoot, encoding: 'utf8' })
    expect(child.status, `${child.stderr}\n${child.stdout}`).toBe(0)
  })
})
