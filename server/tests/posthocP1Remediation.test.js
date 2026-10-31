// TARS after-the-fact review of CTO direct pushes 3d5a1838 / 409159d8.
// Bounded remediation: Connect destination fail-closed, payments hold on
// public Checkout, and no fake confirmations from public schedule.book_slot.
import { describe, it, expect, afterEach } from 'vitest'
import request from 'supertest'
import app from '../src/app.js'
import {
  buildStripeConnectA0DirectChargeConfig,
  allowPlatformDonationFallback,
} from '../src/payments/index.js'

afterEach(() => {
  delete process.env.OC_ALLOW_PLATFORM_DONATION_FALLBACK
  delete process.env.NODE_ENV
  process.env.NODE_ENV = 'test'
})

describe('P1: platform donation fallback is fail-closed outside isolated tests', () => {
  it('refuses when NODE_ENV is production (no flag helps)', () => {
    process.env.NODE_ENV = 'production'
    process.env.OC_ALLOW_PLATFORM_DONATION_FALLBACK = '1'
    expect(allowPlatformDonationFallback()).toBe(false)
    expect(() =>
      buildStripeConnectA0DirectChargeConfig({
        organizationId: 1,
        stripeConnectAccountId: null,
        amount: 10,
        successUrl: 'https://x/s',
        cancelUrl: 'https://x/c',
      })
    ).toThrow(/Stripe Connect account required/)
  })

  it('refuses in test without the explicit opt-in flag', () => {
    process.env.NODE_ENV = 'test'
    delete process.env.OC_ALLOW_PLATFORM_DONATION_FALLBACK
    expect(allowPlatformDonationFallback()).toBe(false)
    expect(() =>
      buildStripeConnectA0DirectChargeConfig({
        organizationId: 1,
        stripeConnectAccountId: null,
        amount: 10,
      })
    ).toThrow(/Stripe Connect account required/)
  })

  it('allows demo_or_test_platform_account only with NODE_ENV=test + flag', () => {
    process.env.NODE_ENV = 'test'
    process.env.OC_ALLOW_PLATFORM_DONATION_FALLBACK = '1'
    const cfg = buildStripeConnectA0DirectChargeConfig({
      organizationId: 1,
      stripeConnectAccountId: null,
      amount: 10,
    })
    expect(cfg.fallback_mode).toBe('demo_or_test_platform_account')
    expect(cfg.stripeAccount).toBeNull()
  })

  it('still builds Direct Charges when a Connect account is supplied', () => {
    process.env.NODE_ENV = 'production'
    const cfg = buildStripeConnectA0DirectChargeConfig({
      organizationId: 1,
      stripeConnectAccountId: 'acct_PARISHONLY1',
      amount: 25,
      successUrl: 'https://x/s',
      cancelUrl: 'https://x/c',
    })
    expect(cfg.stripeAccount).toBe('acct_PARISHONLY1')
    expect(cfg.fallback_mode).toBeNull()
    expect(cfg.requestOptions).toEqual({ stripeAccount: 'acct_PARISHONLY1' })
  })
})

describe('P1: public schedule.book_slot never claims confirmed', () => {
  it('returns 501 not_implemented with ok:false and no confirmed status', async () => {
    const res = await request(app)
      .post('/api/schedule/mcp')
      .send({ tool: 'schedule.book_slot', input: { title: 'Forged booking' } })
    expect(res.status).toBe(501)
    expect(res.body.ok).toBe(false)
    expect(res.body.status).toBe('not_implemented')
    expect(JSON.stringify(res.body)).not.toMatch(/confirmed/i)
  })
})
