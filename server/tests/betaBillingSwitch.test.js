// R398-1: server-side open-beta billing switch. No DB, no Stripe.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'

const h = vi.hoisted(() => ({
  query: vi.fn(),
  createCheckoutSession: vi.fn(async () => ({ url: 'https://checkout.test/x' })),
  createPortalSession: vi.fn(async () => ({ url: 'https://portal.test/x' })),
  verifyWebhook: vi.fn(async () => ({ result: { received: true, stub: true } })),
}))
vi.mock('../src/db.js', () => ({ default: { query: h.query } }))
vi.mock('../src/billing/provider.js', () => ({
  createCheckoutSession: h.createCheckoutSession,
  createPortalSession: h.createPortalSession,
  verifyWebhook: h.verifyWebhook,
}))
vi.mock('../src/billing/webhookReceipts.js', () => ({ storeVerifiedEvent: vi.fn(), applyStoredEvent: vi.fn() }))
vi.mock('../src/monitoring/index.js', () => ({ monitor: { captureException: vi.fn(), captureMessage: vi.fn() } }))

const { authRouter, publicRouter } = await import('../src/routes/billing.js')
const { isBetaBillingOn } = await import('../src/billing/beta.js')

function app() {
  const a = express()
  a.use('/api/billing', publicRouter)
  a.use(express.json())
  a.use((req, _res, next) => { req.organizationId = 'org-1'; next() })
  a.use('/api/billing', authRouter)
  return a
}

let saved
beforeEach(() => { saved = process.env.OC_BETA_BILLING; delete process.env.OC_BETA_BILLING; vi.clearAllMocks() })
afterEach(() => { if (saved === undefined) delete process.env.OC_BETA_BILLING; else process.env.OC_BETA_BILLING = saved })

describe('beta billing switch default', () => {
  it('is ON when unset or unrecognised; off only when explicit', () => {
    expect(isBetaBillingOn({})).toBe(true)
    expect(isBetaBillingOn({ OC_BETA_BILLING: 'yes' })).toBe(true)
    for (const v of ['off', 'false', '0', 'NO']) expect(isBetaBillingOn({ OC_BETA_BILLING: v })).toBe(false)
  })
})

describe('beta ON (default)', () => {
  it('POST /checkout → 409 beta_billing_disabled, no provider call', async () => {
    const r = await request(app()).post('/api/billing/checkout').send({ planId: 'pro' })
    expect(r.status).toBe(409)
    expect(r.body).toEqual({ error: 'beta_billing_disabled' })
    expect(h.createCheckoutSession).not.toHaveBeenCalled()
  })
  it('POST /portal still works for an existing subscriber', async () => {
    const r = await request(app()).post('/api/billing/portal').send({})
    expect(r.status).toBe(200)
    expect(r.body.url).toBe('https://portal.test/x')
    expect(h.createPortalSession).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'org-1' }))
  })
  it('webhook path is untouched (still verified + acked)', async () => {
    const r = await request(app()).post('/api/billing/webhook').set('content-type', 'application/json').send('{}')
    expect(r.status).toBe(200)
    expect(h.verifyWebhook).toHaveBeenCalledTimes(1)
  })
  it('GET /status carries no price amounts', async () => {
    h.query.mockResolvedValueOnce({ rows: [{ plan: 'pro', billing_status: 'active', current_period_end: null, trial_ends_at: null }] })
    const r = await request(app()).get('/api/billing/status')
    expect(r.status).toBe(200)
    expect(r.body.beta_billing).toBe(true)
    expect(r.body.plan).toBe('pro')
    const s = JSON.stringify(r.body)
    expect(s).not.toMatch(/"price"|provider_price_id/)
    expect(r.body.availablePlans).toEqual([])
  })
  it('GET /status does not announce plan-tier limits (SP-186 S4, R398-2)', async () => {
    h.query.mockResolvedValueOnce({ rows: [{ plan: 'free', billing_status: 'active', current_period_end: null, trial_ends_at: null }] })
    const r = await request(app()).get('/api/billing/status')
    expect(r.status).toBe(200)
    expect(r.body.availablePlans).toEqual([])
    expect(r.body.plan).toBe('free')
    expect(r.body.planDetails?.id).toBe('free')
  })
})

describe('beta OFF (explicit) — pre-beta behaviour preserved', () => {
  it('checkout reaches the provider and status shows prices', async () => {
    process.env.OC_BETA_BILLING = 'off'
    const c = await request(app()).post('/api/billing/checkout').send({ planId: 'pro' })
    expect(c.status).toBe(200)
    expect(h.createCheckoutSession).toHaveBeenCalledTimes(1)
    h.query.mockResolvedValueOnce({ rows: [{ plan: 'free' }] })
    const s = await request(app()).get('/api/billing/status')
    expect(s.body.availablePlans.some((p) => typeof p.price === 'number')).toBe(true)
  })
})
