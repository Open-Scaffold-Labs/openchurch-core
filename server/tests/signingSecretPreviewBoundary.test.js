// Signing / encryption / pepper secrets must hard-fail on any
// production-like runtime — NODE_ENV=production OR VERCEL_ENV of
// production/preview (sessionCookie.js productionLike()) — when missing,
// blank, or a known dev fallback. TARS directive, #62 comment 6380227296.
//
// Each case imports the module in a fresh child process so module-load
// guards run against exactly the env under test. Values here are
// synthetic test strings, never real keys.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = (p) => pathToFileURL(path.join(here, '..', 'src', p)).href

const STRONG = 'synthetic-test-secret-0123456789abcdef'
const SECRET_VARS = ['JWT_SECRET', 'CHECKIN_CODE_PEPPER', 'AI_KEY_SECRET']

function run(code, env) {
  const base = { ...process.env }
  for (const k of [...SECRET_VARS, 'NODE_ENV', 'VERCEL_ENV', 'VITEST']) delete base[k]
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...base, ...env }, encoding: 'utf8', timeout: 20000,
  })
  return { ok: r.status === 0, out: `${r.stdout}\n${r.stderr}` }
}
const load = (mod, env) => run(`await import(${JSON.stringify(src(mod))})`, env)

const PREVIEW = { NODE_ENV: 'test', VERCEL_ENV: 'preview' }
const PREVIEW_NO_NODE = { VERCEL_ENV: 'preview' }

describe('JWT_SECRET (middleware/auth.js)', () => {
  const ok = { CHECKIN_CODE_PEPPER: STRONG }
  it('throws on preview with NODE_ENV=test when missing', () => {
    expect(load('middleware/auth.js', { ...PREVIEW, ...ok }).ok).toBe(false)
  })
  it('throws on preview with NODE_ENV unset when missing', () => {
    expect(load('middleware/auth.js', { ...PREVIEW_NO_NODE, ...ok }).ok).toBe(false)
  })
  it('throws on preview when blank / whitespace', () => {
    expect(load('middleware/auth.js', { ...PREVIEW, ...ok, JWT_SECRET: '   ' }).ok).toBe(false)
  })
  it('throws on preview and production when set to the known dev value', () => {
    expect(load('middleware/auth.js', { ...PREVIEW, ...ok, JWT_SECRET: 'dev-only-change-me-please' }).ok).toBe(false)
    expect(load('middleware/auth.js', { NODE_ENV: 'production', ...ok, JWT_SECRET: 'dev-only-change-me-please' }).ok).toBe(false)
  })
  it('throws on VERCEL_ENV=production even with NODE_ENV=test', () => {
    expect(load('middleware/auth.js', { NODE_ENV: 'test', VERCEL_ENV: 'production', ...ok }).ok).toBe(false)
  })
  it('loads on preview with a real-shaped secret', () => {
    const r = load('middleware/auth.js', { ...PREVIEW, ...ok, JWT_SECRET: STRONG })
    expect(r.out).toBe(r.out); expect(r.ok).toBe(true)
  })
  it('still loads with the dev fallback in test / vercel dev', () => {
    expect(load('middleware/auth.js', { NODE_ENV: 'test', ...ok }).ok).toBe(true)
    expect(load('middleware/auth.js', { NODE_ENV: 'development', VERCEL_ENV: 'development', ...ok }).ok).toBe(true)
  })
  it('never prints the secret value in the failure', () => {
    const r = load('middleware/auth.js', { ...PREVIEW, ...ok, JWT_SECRET: 'dev-only-change-me-please' })
    expect(r.out).toMatch(/JWT_SECRET/)
    expect(r.out).not.toMatch(/dev-only-change-me-please/)
  })
})

describe('CHECKIN_CODE_PEPPER (utils/pickupCode.js)', () => {
  it('throws on preview when missing, blank, or the dev pepper', () => {
    expect(load('utils/pickupCode.js', PREVIEW).ok).toBe(false)
    expect(load('utils/pickupCode.js', { ...PREVIEW, CHECKIN_CODE_PEPPER: '' }).ok).toBe(false)
    expect(load('utils/pickupCode.js', { ...PREVIEW, CHECKIN_CODE_PEPPER: 'dev-only-checkin-pepper-change-me' }).ok).toBe(false)
    expect(load('utils/pickupCode.js', { NODE_ENV: 'production', CHECKIN_CODE_PEPPER: 'dev-only-checkin-pepper-change-me' }).ok).toBe(false)
  })
  it('loads on preview with a real-shaped pepper, and in test without one', () => {
    expect(load('utils/pickupCode.js', { ...PREVIEW, CHECKIN_CODE_PEPPER: STRONG }).ok).toBe(true)
    expect(load('utils/pickupCode.js', { NODE_ENV: 'test' }).ok).toBe(true)
  })
})

describe('derived keys never fall back to a dev constant when production-like', () => {
  const call = (mod, expr) => `const m = await import(${JSON.stringify(src(mod))}); ${expr}`
  it('unsubscribe token signing refuses a dev/blank JWT_SECRET on preview', () => {
    const code = call('notifications/unsubscribeToken.js', `m.signUnsubscribe(1, 'x')`)
    expect(run(code, PREVIEW).ok).toBe(false)
    expect(run(code, { ...PREVIEW, JWT_SECRET: 'dev-only-change-me-please' }).ok).toBe(false)
    expect(run(code, { ...PREVIEW, JWT_SECRET: STRONG }).ok).toBe(true)
    expect(run(code, { NODE_ENV: 'test' }).ok).toBe(true)
  })
  it('org AI key encryption refuses dev/blank secrets on preview', () => {
    const code = call('ai/orgProvider.js', `m.encryptApiKey('sk-synthetic')`)
    expect(run(code, PREVIEW).ok).toBe(false)
    expect(run(code, { ...PREVIEW, AI_KEY_SECRET: 'dev-only-ai-key-secret' }).ok).toBe(false)
    expect(run(code, { ...PREVIEW, AI_KEY_SECRET: '  ', JWT_SECRET: 'dev-only-change-me-please' }).ok).toBe(false)
    expect(run(code, { ...PREVIEW, AI_KEY_SECRET: STRONG }).ok).toBe(true)
    // JWT_SECRET remains the documented fallback when it is real.
    expect(run(code, { ...PREVIEW, JWT_SECRET: STRONG }).ok).toBe(true)
    expect(run(code, { NODE_ENV: 'test' }).ok).toBe(true)
  })
  it('an empty AI_KEY_SECRET falls back to a real JWT_SECRET (documented legacy path)', () => {
    const code = call('ai/orgProvider.js', `const a = m.encryptApiKey('k'); process.env.AI_KEY_SECRET=''; if (m.decryptApiKey(a) !== 'k') process.exit(3)`)
    expect(run(code, { ...PREVIEW, AI_KEY_SECRET: '', JWT_SECRET: STRONG }).ok).toBe(true)
  })
})

// R381-1 (TARS, #381 comment 6380326883): a configured-but-rejected
// AI_KEY_SECRET must refuse, never silently switch the encryption root to
// JWT_SECRET (old ciphertext would stop decrypting and new writes would
// land under a different key).
describe('R381-1 AI_KEY_SECRET configured but invalid refuses, no JWT switch', () => {
  const call = (expr) => `import crypto from 'node:crypto'; const m = await import(${JSON.stringify(src('ai/orgProvider.js'))}); ${expr}`
  // Legacy derivation (main before #381): sha256(`${secret}:ochr-org-ai-key`).
  const legacyEnc = (secret, plain) => {
    const k = `crypto.createHash('sha256').update(${JSON.stringify(secret)} + ':ochr-org-ai-key').digest()`
    return `(() => { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', ${k}, iv); const ct = Buffer.concat([c.update(${JSON.stringify(plain)}, 'utf8'), c.final()]); return iv.toString('base64') + '.' + c.getAuthTag().toString('base64') + '.' + ct.toString('base64') })()`
  }
  for (const [label, bad] of [['whitespace-only', '   '], ['known-dev', 'dev-only-ai-key-secret'], ['padded known-dev', ' dev-only-ai-key-secret ']]) {
    for (const envName of ['preview', 'production']) {
      const env = envName === 'preview' ? PREVIEW : { NODE_ENV: 'production' }
      it(`${label} AI_KEY_SECRET + valid JWT_SECRET refuses new encryption on ${envName}`, () => {
        const r = run(call(`m.encryptApiKey('sk-synthetic')`), { ...env, AI_KEY_SECRET: bad, JWT_SECRET: STRONG })
        expect(r.ok).toBe(false)
        expect(r.out).toMatch(/AI_KEY_SECRET/)
        expect(r.out).not.toMatch(/dev-only-ai-key-secret/)
        expect(r.out).not.toContain(STRONG)
      })
      it(`${label} AI_KEY_SECRET + valid JWT_SECRET refuses decrypt on ${envName} (no JWT-root fallback)`, () => {
        const code = call(`const a = ${legacyEnc(STRONG, 'k')}; try { m.decryptApiKey(a); process.exit(0) } catch { process.exit(4) }`)
        expect(run(code, { ...env, AI_KEY_SECRET: bad, JWT_SECRET: STRONG }).ok).toBe(false)
      })
    }
  }
  it('valid dedicated-key legacy ciphertext stays readable on preview', () => {
    const code = call(`if (m.decryptApiKey(${legacyEnc(STRONG, 'sk-old')}) !== 'sk-old') process.exit(3)`)
    expect(run(code, { ...PREVIEW, AI_KEY_SECRET: STRONG, JWT_SECRET: 'other-synthetic-jwt-0123456789' }).ok).toBe(true)
  })
  it('absent/empty AI_KEY_SECRET JWT-fallback legacy ciphertext stays readable on preview', () => {
    const code = call(`if (m.decryptApiKey(${legacyEnc(STRONG, 'sk-old')}) !== 'sk-old') process.exit(3)`)
    expect(run(code, { ...PREVIEW, JWT_SECRET: STRONG }).ok).toBe(true)
    expect(run(code, { ...PREVIEW, AI_KEY_SECRET: '', JWT_SECRET: STRONG }).ok).toBe(true)
  })
  it('a valid padded AI_KEY_SECRET is used byte-for-byte (no trim)', () => {
    const padded = `  ${STRONG}\t`
    const code = call(`if (m.decryptApiKey(${legacyEnc(padded, 'sk-pad')}) !== 'sk-pad') process.exit(3); const w = m.encryptApiKey('n'); process.env.AI_KEY_SECRET = ${JSON.stringify(STRONG)}; try { m.decryptApiKey(w); process.exit(5) } catch {}`)
    expect(run(code, { ...PREVIEW, AI_KEY_SECRET: padded, JWT_SECRET: 'other-synthetic-jwt-0123456789' }).ok).toBe(true)
  })
})
