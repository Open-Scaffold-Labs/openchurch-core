import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const launcher = join(repoRoot, 'scripts', 'ios-local-api.mjs')
const guard = join(repoRoot, 'scripts', 'ios-local-api-guard.mjs')
const PINNED_DATABASE_URL = readFileSync(guard, 'utf8').match(/PINNED_DATABASE_URL = '([^']+)'/)[1]

function planViaNode(env, root) {
  const script = [
    `import { planIosLocalApi } from ${JSON.stringify(pathToFileURL(guard).href)}`,
    `const plan = planIosLocalApi(${JSON.stringify(env)}${root ? `, { root: ${JSON.stringify(root)} }` : ''})`,
    'const child = plan.childEnv || null',
    'process.stdout.write(JSON.stringify({',
    '  refuse: plan.refuse,',
    '  databaseUrl: child && child.DATABASE_URL,',
    '  nodeEnv: child && child.NODE_ENV,',
    '  port: child && child.PORT,',
    '  resend: child && child.RESEND_API_KEY,',
    '  seed: child && child.SEED_DEMO,',
    '  sealed: Boolean(child && child.DOTENV_CONFIG_PATH),',
    '}))',
  ].join('\n')
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
  expect(run.status, run.stderr).toBe(0)
  return JSON.parse(run.stdout)
}
const SECRET = 'synthetic-rehearsal-key-do-not-send'
const base = { PATH: process.env.PATH, HOME: process.env.HOME || '/tmp' }

function hookPair(name) {
  const dir = mkdtempSync(join(tmpdir(), `oc-ios-api-${name}-`))
  const hook = join(dir, 'hook.mjs')
  const reg = join(dir, 'reg.mjs')
  writeFileSync(hook, [
    'export async function resolve(specifier, context, next) {',
    '  const resolved = await next(specifier, context)',
    "  if (resolved.url.includes('/server/src/') || resolved.url.includes('/node_modules/pg/')) {",
    "    process.stderr.write('LOADED ' + resolved.url + '\\n')",
    '  }',
    '  return resolved',
    '}',
    '',
  ].join('\n'))
  writeFileSync(reg, `import { register } from 'node:module'\nregister(${JSON.stringify(pathToFileURL(hook).href)})\n`)
  return { dir, reg }
}

function runLauncher(env, reg) {
  const args = reg ? ['--import', reg, launcher] : [launcher]
  return spawnSync(process.execPath, args, {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    timeout: 20000,
  })
}

describe('iOS local API launcher', () => {
  it('refuses a forbidden target before the app or pg is imported', () => {
    const source = readFileSync(launcher, 'utf8')
    expect(source.indexOf('planIosLocalApi(process.env)')).toBeGreaterThan(-1)
    expect(source.indexOf('planIosLocalApi(process.env)')).toBeLessThan(source.indexOf('spawn('))
    expect(source).not.toMatch(/from\s+['"][^'"]*server\/src/)
    expect(source).not.toMatch(/from\s+['"]pg['"]/)

    const { dir, reg } = hookPair('forbid')
    const cases = [
      [{ ...base, DATABASE_URL: 'postgres://synthetic:s3cret@db.example.invalid/shared' }, 'remote'],
      [{ ...base, DATABASE_URL: 'postgres://postgres@127.0.0.1/local?host=127.0.0.1' }, '?host='],
      [{ ...base, DATABASE_URL: PINNED_DATABASE_URL, PGHOST: 'db.example.invalid' }, 'PGHOST'],
      [{ ...base, RESEND_API_KEY: SECRET }, 'RESEND_API_KEY'],
      [{ ...base, NODE_ENV: 'production', DATABASE_URL: PINNED_DATABASE_URL }, 'NODE_ENV'],
    ]
    try {
      for (const [env, needle] of cases) {
        const run = runLauncher(env, reg)
        expect(run.status, run.stderr).toBe(2)
        expect(run.stderr).toContain('refusing to start')
        expect(run.stderr).toContain(needle)
        expect(run.stderr).not.toContain('LOADED')
        expect(run.stderr).not.toContain('s3cret')
        expect(run.stderr).not.toContain(SECRET)
        expect(run.stdout || '').not.toContain('Starting server')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a database named only in an env file', () => {
    const root = mkdtempSync(join(tmpdir(), 'oc-ios-api-file-'))
    writeFileSync(join(root, '.env'), 'DATABASE_URL=postgres://synthetic:s3cret@db.example.invalid/shared\n')
    try {
      const plan = planViaNode(base, root)
      expect(plan.refuse).toMatch(/DATABASE_URL in \.env/)
      expect(plan.refuse).not.toContain('s3cret')
      expect(plan.databaseUrl).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('pins the loopback database for an empty shell', () => {
    const plan = planViaNode(base)
    expect(plan.refuse).toBeNull()
    expect(plan.databaseUrl).toBe(PINNED_DATABASE_URL)
    expect(plan.nodeEnv).toBe('development')
    expect(plan.port).toBe('3034')
    expect(plan.resend).toBe('')
    expect(plan.seed).toBe('')
    expect(plan.sealed).toBe(true)

    const child = spawn(process.execPath, [launcher], {
      cwd: repoRoot,
      env: base,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let settled = false
    const seen = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`launcher did not reach the server entry: ${out}`)), 20000)
      const finish = (text) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(text)
      }
      child.stdout.on('data', (chunk) => {
        out += chunk.toString()
        if (out.includes('Starting server')) finish(out)
      })
      child.stderr.on('data', (chunk) => {
        out += chunk.toString()
      })
      child.on('exit', (code) => {
        if (settled) return
        clearTimeout(timer)
        reject(new Error(`exited ${code} before the entry: ${out}`))
      })
    })
    return seen.then((text) => {
      expect(text).toContain('DB: set')
      expect(text).not.toContain('refusing to start')
      expect(text).not.toContain(PINNED_DATABASE_URL)
    }).finally(() => {
      child.kill('SIGKILL')
    })
  })
})
