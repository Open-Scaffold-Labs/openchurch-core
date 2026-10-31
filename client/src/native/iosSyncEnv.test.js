import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { sealIosChildEnv } from './iosSyncEnv'

const clientRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')
const vite = join(clientRoot, 'node_modules', '.bin', 'vite')
const syncSource = readFileSync(join(clientRoot, 'scripts', 'ios-sync.mjs'), 'utf8')
const FROM_DOTENV = 'https://from-dotenv.example.invalid'
const FROM_LOCAL = 'https://from-production-local.example.invalid'

const root = mkdtempSync(join(tmpdir(), 'oc-ios-sync-'))
writeFileSync(join(root, 'package.json'), '{"type":"module"}\n')
writeFileSync(join(root, 'index.html'), '<script type="module" src="/main.js"></script>\n')
writeFileSync(join(root, 'main.js'), [
  'globalThis.__OC_ENV__ = {',
  '  api: import.meta.env.VITE_API_URL,',
  '  push: import.meta.env.VITE_ENABLE_IOS_PUSH,',
  '  cap: import.meta.env.VITE_CAPACITOR,',
  '}',
  '',
].join('\n'))
writeFileSync(join(root, '.env'), `VITE_API_URL=${FROM_DOTENV}\nVITE_ENABLE_IOS_PUSH=1\n`)
writeFileSync(join(root, '.env.production.local'), `VITE_API_URL=${FROM_LOCAL}\nVITE_ENABLE_IOS_PUSH=1\n`)
mkdirSync(join(root, 'dist'), { recursive: true })

function build(env, outDir) {
  writeFileSync(join(root, 'vite.config.js'), `export default { build: { outDir: ${JSON.stringify(outDir)}, emptyOutDir: true } }\n`)
  return spawnSync(vite, ['build'], {
    cwd: root,
    env,
    encoding: 'utf8',
  })
}

function bundle(outDir) {
  const html = readFileSync(join(root, outDir, 'index.html'), 'utf8')
  const file = html.match(/assets\/[^"]+\.js/)
  expect(file).toBeTruthy()
  return readFileSync(join(root, outDir, file[0]), 'utf8')
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('iOS sync seals the Vite build environment', () => {
  it('wires the seal into ios-sync before vite runs', () => {
    expect(syncSource.indexOf('sealIosChildEnv(process.env)')).toBeGreaterThan(-1)
    expect(syncSource.indexOf('sealIosChildEnv(process.env)')).toBeLessThan(syncSource.indexOf('run(vite'))
    expect(syncSource).not.toMatch(/delete env\.VITE_ENABLE_IOS_PUSH/)
  })

  it('keeps a file-only API origin and push flag out of a default build', () => {
    const open = build({ PATH: process.env.PATH, HOME: process.env.HOME }, 'dist-open')
    expect(open.status, open.stderr).toBe(0)
    const leaked = bundle('dist-open')
    expect(leaked).toContain(FROM_LOCAL)
    expect(leaked).toContain('1')

    const sealed = sealIosChildEnv({ PATH: process.env.PATH, HOME: process.env.HOME })
    expect(sealed.env.VITE_API_URL).toBe('')
    expect(sealed.env.VITE_ENABLE_IOS_PUSH).toBe('')
    const closed = build(sealed.env, 'dist-sealed')
    expect(closed.status, closed.stderr).toBe(0)
    const safe = bundle('dist-sealed')
    expect(safe).not.toContain(FROM_DOTENV)
    expect(safe).not.toContain(FROM_LOCAL)
    expect(safe).not.toContain('push:`1`')
    expect(safe).toContain('push:``')
    expect(safe).toContain('cap:`1`')
  })

  it('keeps an explicit push opt-in when the env file says otherwise', () => {
    writeFileSync(join(root, '.env.production.local'), `VITE_API_URL=${FROM_LOCAL}\nVITE_ENABLE_IOS_PUSH=0\n`)
    const sealed = sealIosChildEnv({
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      VITE_ENABLE_IOS_PUSH: '1',
    })
    expect(sealed.checked.push).toBe(true)
    const built = build(sealed.env, 'dist-push')
    expect(built.status, built.stderr).toBe(0)
    const js = bundle('dist-push')
    expect(js).toContain('push:`1`')
    expect(js).not.toContain(FROM_LOCAL)
    expect(js).not.toContain(FROM_DOTENV)
  })
})
