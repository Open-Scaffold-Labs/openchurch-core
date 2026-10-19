// ARG-LEAK-2: the email stub must not print bodies, tokens, URLs or full
// addresses, and must refuse to stub in production. Synthetic data only.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import request from 'supertest'
import 'dotenv/config'
import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { sendEmail } from '../src/email/send.js'

const R = RUN_ID.replace(/[^a-z0-9]/gi, '').toLowerCase()
const email = `leak2_${R}@argus.test`
let server, orgId

function capture() {
  const out = []
  const spies = ['log', 'info', 'warn', 'error', 'debug'].map(k =>
    vi.spyOn(console, k).mockImplementation((...a) => { out.push(a.map(x => typeof x === 'string' ? x : (x instanceof Error ? `${x.message}\n${x.stack}` : JSON.stringify(x))).join(' ')) }))
  return { out, text: () => out.join('\n'), restore: () => spies.forEach(s => s.mockRestore()) }
}
function withEnv(vars, fn) {
  const prior = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]))
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  return Promise.resolve().then(fn).finally(() => {
    for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  })
}

beforeAll(async () => {
  await migrateOnce(); server = await bindServer()
  const res = await request(server).post('/api/auth/signup').set('X-Forwarded-For', '10.94.1.1')
    .send({ organizationName: `Leak2 ${R}`, name: 'Admin', email, password: 'leak2-test-pw' })
  expect(res.status).toBe(201)
  orgId = res.body.user.organization.id
}, 60_000)
afterAll(async () => {
  await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [orgId]).catch(() => {})
  await closeServer(server); await pool.end()
})

describe('ARG-LEAK-2 email stub redaction', () => {
  it('a dev password-reset email logs no token, URL, body or full address', async () => {
    const cap = capture()
    try {
      await withEnv({ NODE_ENV: 'test', RESEND_API_KEY: undefined }, async () => {
        const res = await request(server).post('/api/auth/forgot-password').set('X-Forwarded-For', '10.94.1.2').send({ email })
        expect(res.status).toBe(200)
      })
    } finally { cap.restore() }
    const t = cap.text()
    expect(t).toContain('[email:stub]')
    expect(t).not.toMatch(/token=/)
    expect(t).not.toMatch(/https?:\/\//)
    expect(t).not.toContain(email)
    expect(t).not.toMatch(/TEXT:|HEADERS:/)
  })

  it('dev stub with an explicit token-bearing body still logs none of it', async () => {
    const canary = 'TokCanary' + 'x'.repeat(30)
    const cap = capture()
    try {
      await withEnv({ NODE_ENV: 'development', RESEND_API_KEY: undefined }, () =>
        sendEmail({ to: email, subject: 'Reset', text: `https://app.test/reset?token=${canary}`, html: `<a href="https://app.test/reset?token=${canary}">x</a>`, headers: { 'List-Unsubscribe': `<https://app.test/u/${canary}>` } }))
    } finally { cap.restore() }
    expect(cap.text()).not.toContain(canary)
    expect(cap.text()).not.toContain(email)
  })

  it('production without RESEND_API_KEY refuses, and the error log carries no content', async () => {
    const canary = 'ProdCanary' + 'y'.repeat(30)
    const cap = capture()
    let err
    try {
      await withEnv({ NODE_ENV: 'production', RESEND_API_KEY: undefined }, () =>
        sendEmail({ to: email, subject: `Reset ${canary}`, text: `https://app.test/reset?token=${canary}` })).catch(e => { err = e })
    } finally { cap.restore() }
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe('EMAIL_TRANSPORT_UNCONFIGURED')
    expect(`${err.message}`).not.toContain(canary)
    expect(cap.text()).not.toContain(canary)
    expect(cap.text()).not.toContain(email)
    expect(cap.text()).toMatch(/refusing to stub/)
  })
})
