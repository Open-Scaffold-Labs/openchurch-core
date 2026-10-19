// Sentry #293 @ b89de6e3 follow-ups: S-F1 provider-failure log masks the
// recipient; S-F2 refund stub logs no charge id/amount; S-F3 bad-request log
// masks token path segments. Local synthetic data only; fetch is faked.
import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from 'vitest'
import request from 'supertest'
import 'dotenv/config'
import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { notify } from '../src/notifications/transport.js'
import { createRefund } from '../src/payments/index.js'
import { monitor } from '../src/monitoring/index.js'
import { maskPath, maskRef } from '../src/utils/redact.js'

let server, orgId
const R = RUN_ID.replace(/[^a-z0-9]/gi, '').toLowerCase()
const allOutput = (...spies) => spies.flatMap(s => s.mock.calls).map(c => JSON.stringify(c, (k, v) => v instanceof Error ? v.message : v)).join('\n')

beforeAll(async () => {
  await migrateOnce(); server = await bindServer()
  const res = await request(server).post('/api/auth/signup').set('X-Forwarded-For', '10.95.1.1')
    .send({ organizationName: `SF ${R}`, name: 'A', email: `sf_admin_${R}@example.com`, password: 'sf-test-pw' })
  expect(res.status).toBe(201); orgId = res.body.user.organization.id
}, 60_000)
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); delete process.env.RESEND_API_KEY })
afterAll(async () => {
  await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [orgId]).catch(() => {})
  await closeServer(server); await pool.end()
})

describe('Sentry #293 follow-ups', () => {
  it('S-F1: a provider 500 is logged failed with the recipient masked everywhere', async () => {
    const to = `sf_victim_${R}@example.com`
    process.env.RESEND_API_KEY = 'test-key-not-real'
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`{"message":"bad recipient ${to}"}`, { status: 500 })))
    const mon = vi.spyOn(monitor, 'error').mockImplementation(() => {})
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = await notify({ organizationId: orgId, recipient: to, notification_type: 'member_birthday', vars: { member_name: 'M' } })
    expect(r.status).toBe('failed')
    expect(mon).toHaveBeenCalled()
    expect(allOutput(mon, err, log, warn)).not.toContain(to)
    const row = (await pool.query('SELECT error FROM ochr_notification_log WHERE id = $1', [r.id])).rows[0]
    expect(row.error).not.toContain(to)
    expect(row.error).toMatch(/500/)
  })

  it('S-F2: the refund stub logs neither the charge id nor the amount; refs are masked', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const chargeId = `ch_secret_${R}_abcdef`
    await createRefund({ organizationId: orgId, chargeId, amount: 123.45, idempotencyKey: `rk_${R}` }).catch(() => {})
    const out = allOutput(log)
    expect(out).toContain('[pay:stub] refund')
    expect(out).not.toContain(chargeId)
    expect(out).not.toContain('123.45')
    expect(maskRef('cs_test_abcdefghijklmnop')).toBe('cs_test_***')
  })

  it('S-F3: a malformed body on /api/unsubscribe/<token> logs the path with the token masked', async () => {
    const tok = `tok${R}AbCdEfGhIjKlMnOpQrStUv`
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await request(server).post(`/api/unsubscribe/${tok}`).set('Content-Type', 'application/json').send('{"bad json')
    expect(res.status).toBe(400)
    const out = allOutput(warn)
    expect(out).toContain('[bad-request]')
    expect(out).not.toContain(tok)
    expect(out).toContain('/api/unsubscribe/:token')
    expect(maskPath('/api/swaps/12/accept')).toBe('/api/swaps/12/accept')
  })
})
