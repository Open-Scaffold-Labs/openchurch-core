// Real `vite build` probe (project vite.config.js, every plugin) for the
// demo-login boundary. Builds into a throwaway temp directory, never
// ./dist, and prints only PRESENT/ABSENT and asset names, never the
// literal it looks for.
//
//   node scripts/login-real-build-check.mjs [--mode <mode>]
//
// Run it as a child process: under Vitest, import.meta.env.DEV is true.
import { build } from 'vite'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLIENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const modeIdx = process.argv.indexOf('--mode')
const mode = modeIdx > 0 ? process.argv[modeIdx + 1] : 'production'
const outDir = mkdtempSync(join(tmpdir(), 'oc-login-build-'))
// Split so this file never contains the literal it hunts for.
const NEEDLES = { credential: ['demo', '1234'].join(''), helper_copy: 'Use demo account' }

let code = 0
try {
  await build({ root: CLIENT_ROOT, mode, logLevel: 'silent', build: { outDir, emptyOutDir: true } })
  const assets = join(outDir, 'assets')
  const files = readdirSync(assets).filter(f => f.endsWith('.js'))
  const login = files.filter(f => /^Login-/.test(f))
  console.log(`LOGIN_CHUNK ${login.join(',') || 'none'}`)
  for (const [k, n] of Object.entries(NEEDLES)) {
    const hits = files.filter(f => readFileSync(join(assets, f), 'utf8').includes(n))
    console.log(`${k.toUpperCase()}_${hits.length ? 'PRESENT' : 'ABSENT'} ${hits.join(',')}`)
  }
} catch (e) {
  console.log(`BUILD_FAILED ${e?.message ?? e}`)
  code = 2
} finally {
  rmSync(outDir, { recursive: true, force: true })
}
// Plugins can leave handles open; never hang a test or CI job.
process.exit(code)
