import express from 'express'
import { publicRouter as billingPublicRouter } from '../src/routes/billing.js'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  PLANS,
  PARISH_PRICING_TIERS,
  PARISH_PRICING_FLOOR_V21,
  COVER_FEE_DEFAULT_CHECKED,
  STRIPE_CONNECT_MODE_A0,
  buildStripeNonprofitAndMcc8398Guide,
  evaluateParishPricingFloor,
} from '../src/billing/plans.js'
import {
  BANNED_STRIPE_CONNECT_MODES,
  resolveStripeConnectAccountId,
  computeDonorCoverFeeGrossUpCents,
  buildStripeConnectA0DirectChargeConfig,
  createDonationCheckout,
} from '../src/payments/index.js'
import { stripeRequest } from '../src/utils/stripeApi.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLANS_SRC = readFileSync(join(HERE, '../src/billing/plans.js'), 'utf8')
const PUBLIC_GIVE_SRC = readFileSync(join(HERE, '../../client/src/pages/PublicGive.jsx'), 'utf8')

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete process.env.PAYMENTS_PROVIDER
  delete process.env.PAYMENTS_PROVIDER_SECRET
  delete process.env.STRIPE_CONNECT_ACCOUNT_ID
})

describe('Parish Pricing Floor v2.1 (t71ua0 / t71u — José Ledger Audit)', () => {
  it('1. locks Stripe Connect Mode A0 Direct Charges (stripeAccount, application_fee_amount: 0); platform fallback only with explicit test opt-in', async () => {
    expect(STRIPE_CONNECT_MODE_A0).toBe('A0_STRIPE_HANDLES_PRICING_DIRECT_CHARGE')
    expect(BANNED_STRIPE_CONNECT_MODES).toContain('A_OSL_ABSORBS_CONNECT_FEES')

    const directCfg = buildStripeConnectA0DirectChargeConfig({
      organizationId: 12,
      stripeConnectAccountId: 'acct_1StMarkParish001',
      amount: 100,
      fundId: 3,
      fundName: 'General Offertory',
      donorName: 'Maria Lopez',
      donorEmail: 'maria@example.org',
      successUrl: 'https://parish.example.org/p/st-mark/give?success=1',
      cancelUrl: 'https://parish.example.org/p/st-mark/give?canceled=1',
    })
    expect(directCfg.connect_mode).toBe('A0_STRIPE_HANDLES_PRICING_DIRECT_CHARGE')
    expect(directCfg.stripeAccount).toBe('acct_1StMarkParish001')
    expect(directCfg.requestOptions).toEqual({ stripeAccount: 'acct_1StMarkParish001' })
    expect(directCfg.application_fee_amount).toBe(0)
    expect(directCfg.osl_monthly_active_account_fee_cents).toBe(0)
    expect(directCfg.osl_payout_fee_bps).toBe(0)
    expect(directCfg.osl_payout_fee_fixed_cents).toBe(0)
    expect(directCfg.coverFeeDefaultChecked).toBe(false)
    expect(directCfg.coverFeeApplied).toBe(false)
    expect(directCfg.totalAmountCents).toBe(10000)
    expect(directCfg.sessionParams.payment_intent_data).toEqual({ application_fee_amount: 0 })

    // Without an explicit test opt-in, a missing Connect account refuses
    // (prod must never fall open onto the platform account).
    expect(() =>
      buildStripeConnectA0DirectChargeConfig({
        organizationId: 12,
        stripeConnectAccountId: null,
        amount: 50,
      })
    ).toThrow(/Stripe Connect account required/)

    // Isolated-test opt-in only: NODE_ENV=test + OC_ALLOW_PLATFORM_DONATION_FALLBACK
    process.env.OC_ALLOW_PLATFORM_DONATION_FALLBACK = '1'
    const fallbackCfg = buildStripeConnectA0DirectChargeConfig({
      organizationId: 12,
      stripeConnectAccountId: null,
      amount: 50,
    })
    expect(fallbackCfg.stripeAccount).toBeNull()
    expect(fallbackCfg.requestOptions).toBeUndefined()
    expect(fallbackCfg.fallback_mode).toBe('demo_or_test_platform_account')
    expect(fallbackCfg.application_fee_amount).toBe(0)
    delete process.env.OC_ALLOW_PLATFORM_DONATION_FALLBACK

    expect(() =>
      buildStripeConnectA0DirectChargeConfig({
        organizationId: 12,
        amount: 50,
        connectMode: 'A_OSL_ABSORBS_CONNECT_FEES',
      })
    ).toThrow(/Banned Stripe Connect mode/)

    // Verify stripeRequest sends Stripe-Account header on Direct Charges
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: 'cs_test_a0_1', url: 'https://checkout.stripe.com/c/pay/cs_test_a0_1' }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    process.env.PAYMENTS_PROVIDER = 'stripe'
    process.env.PAYMENTS_PROVIDER_SECRET = 'sk_test_osl_a0'

    const checkout = await createDonationCheckout({
      organizationId: 12,
      stripeConnectAccountId: 'acct_1StMarkParish001',
      amount: 150,
      fundId: 1,
      fundName: 'General',
      donorName: 'Test Donor',
      successUrl: 'https://parish.example.org/give?success=1',
      cancelUrl: 'https://parish.example.org/give?canceled=1',
    })
    expect(checkout.url).toBe('https://checkout.stripe.com/c/pay/cs_test_a0_1')
    expect(checkout.connectMode).toBe('A0_STRIPE_HANDLES_PRICING_DIRECT_CHARGE')
    expect(checkout.stripeAccount).toBe('acct_1StMarkParish001')
    expect(checkout.applicationFeeAmount).toBe(0)
    expect(checkout.coverFeeDefaultChecked).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, reqInit] = fetchMock.mock.calls[0]
    expect(reqInit.headers['Stripe-Account']).toBe('acct_1StMarkParish001')
    expect(decodeURIComponent(String(reqInit.body))).toContain('payment_intent_data[application_fee_amount]=0')
  })

  it('2. enforces coverFeeDefaultChecked: false across giving UI and server helpers', () => {
    expect(COVER_FEE_DEFAULT_CHECKED).toBe(false)
    expect(PUBLIC_GIVE_SRC).toContain('export const COVER_FEE_DEFAULT_CHECKED = false')
    expect(PUBLIC_GIVE_SRC).toContain('useState(COVER_FEE_DEFAULT_CHECKED)')

    const defaultBreak = computeDonorCoverFeeGrossUpCents(10000)
    expect(defaultBreak.coverFeeDefaultChecked).toBe(false)
    expect(defaultBreak.coverFeeApplied).toBe(false)
    expect(defaultBreak.totalAmountCents).toBe(10000)
    expect(defaultBreak.feeAmountCents).toBe(0)

    const optInBreak = computeDonorCoverFeeGrossUpCents(10000, { coverFee: true })
    expect(optInBreak.coverFeeDefaultChecked).toBe(false)
    expect(optInBreak.coverFeeApplied).toBe(true)
    expect(optInBreak.totalAmountCents).toBeGreaterThan(10000)
  })

  it('3. marks $49 / $79 / $149 and Founding 10 Charter tiers as status: illustrative_unapproved with zero board-approved comments', () => {
    expect(PLANS_SRC).not.toMatch(/board-approved/i)
    expect(PLANS.pro.priceMonthly).toBe(79)
    expect(PLANS.pro.status).toBe('illustrative_unapproved')
    expect(PLANS.pro.pricingApprovalStatus).toBe('illustrative_unapproved')

    expect(PARISH_PRICING_TIERS.small_parish.priceMonthly).toBe(49)
    expect(PARISH_PRICING_TIERS.small_parish.status).toBe('illustrative_unapproved')
    expect(PARISH_PRICING_TIERS.parish_standard.priceMonthly).toBe(79)
    expect(PARISH_PRICING_TIERS.parish_standard.status).toBe('illustrative_unapproved')
    expect(PARISH_PRICING_TIERS.cathedral_multi_site.priceMonthly).toBe(149)
    expect(PARISH_PRICING_TIERS.cathedral_multi_site.status).toBe('illustrative_unapproved')
    expect(PARISH_PRICING_TIERS.founding_10_charter.discountPercent).toBe(50)
    expect(PARISH_PRICING_TIERS.founding_10_charter.status).toBe('illustrative_unapproved')
  })

  it('4. provides 501(c)(3) Stripe Nonprofit discount (>=80% donations) and Visa Charity MCC 8398 guide', () => {
    const guide = buildStripeNonprofitAndMcc8398Guide({ id: 7, name: 'St. Jude Parish' })
    expect(guide.stripe_nonprofit_application_url).toBe(
      'https://support.stripe.com/questions/fee-discount-for-nonprofit-organizations'
    )
    expect(guide.connect_mode).toBe('A0_STRIPE_HANDLES_PRICING_DIRECT_CHARGE')
    expect(guide.application_fee_amount).toBe(0)
    expect(guide.cover_fee_default_checked).toBe(false)
    expect(guide.discounted_stripe_rates.cards_nonprofit_rate).toBe('2.2% + $0.30')
    expect(guide.mcc_8398_charity_interchange.mcc_code).toBe('8398')
    expect(guide.parish_pricing_tiers_status).toBe('illustrative_unapproved')
  })

  it('5. distinguishes Rail B Published Entry Rates (Rainforest $0.20 ACH vs Finix 1.00%+25c cap $10) from $15M+/mo Scale Targets', () => {
    expect(PARISH_PRICING_FLOOR_V21.rainforest_published_entry.ach_flat_fee_cents).toBe(20)
    expect(PARISH_PRICING_FLOOR_V21.rainforest_published_entry.card_markup_bps).toBe(30)
    expect(PARISH_PRICING_FLOOR_V21.rainforest_published_entry.card_markup_fixed_cents).toBe(30)
    expect(PARISH_PRICING_FLOOR_V21.rainforest_published_entry.payout_fee_cents).toBe(20)
    expect(PARISH_PRICING_FLOOR_V21.rainforest_published_entry.monthly_active_merchant_fee_cents).toBe(0)

    expect(PARISH_PRICING_FLOOR_V21.finix_published_entry.ach_rate_bps).toBe(100)
    expect(PARISH_PRICING_FLOOR_V21.finix_published_entry.ach_fixed_cents).toBe(25)
    expect(PARISH_PRICING_FLOOR_V21.finix_published_entry.ach_cap_cents).toBe(1000)
    expect(PARISH_PRICING_FLOOR_V21.finix_published_entry.monthly_active_merchant_fee_cents).toBe(250)
    expect(PARISH_PRICING_FLOOR_V21.finix_published_entry.payout_fee_cents).toBe(50)

    expect(PARISH_PRICING_FLOOR_V21.finix_scale_target_15m_monthly.tier).toBe(
      'negotiated_scale_target_15m_monthly'
    )
    expect(PARISH_PRICING_FLOOR_V21.finix_scale_target_15m_monthly.is_default_entry_rate).toBe(false)
    expect(PARISH_PRICING_FLOOR_V21.finix_scale_target_15m_monthly.ach_flat_fee_cents).toBe(25)

    expect(PARISH_PRICING_FLOOR_V21.rail_a0_stripe_direct_charge.ach_rate_bps).toBe(80)
    expect(PARISH_PRICING_FLOOR_V21.rail_a0_stripe_direct_charge.ach_cap_cents).toBe(500)
    expect(PARISH_PRICING_FLOOR_V21.rail_a0_stripe_direct_charge.ach_instant_win_threshold_cents).toBe(62500)

    const model = evaluateParishPricingFloor()
    expect(model.total_tx_count).toBe(8000)
    expect(model.card_interchange_mcc_8398_dollars).toBe(7660.16)
    expect(model.network_assessments_dfa_dollars).toBe(1472.0)
    expect(model.rainforest_published_entry_total_dollars).toBe(14252.16)
    expect(model.finix_published_entry_total_dollars).toBe(15772.16)
    expect(model.tithely_total_dollars).toBe(32640.0)
    expect(model.stripe_standard_total_dollars).toBe(31680.0)
    expect(model.rainforest_savings_vs_tithely_dollars).toBe(18387.84)
    expect(model.finix_published_savings_vs_tithely_dollars).toBe(16867.84)
  })

  it('6. serves GET /api/billing/nonprofit-fee-guide with Connect A0, illustrative_unapproved tiers, and MCC 8398 guide', async () => {
    const app = express()
    app.use('/api/billing', billingPublicRouter)
    const srv = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s))
    })
    try {
      const port = srv.address().port
      const res = await fetch(`http://127.0.0.1:${port}/api/billing/nonprofit-fee-guide`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.connect_mode).toBe('A0_STRIPE_HANDLES_PRICING_DIRECT_CHARGE')
      expect(body.cover_fee_default_checked).toBe(false)
      expect(body.pricing_approval_status).toBe('illustrative_unapproved')
      expect(body.guide.stripe_nonprofit_application_url).toBe(
        'https://support.stripe.com/questions/fee-discount-for-nonprofit-organizations'
      )
      expect(body.medium_parish_benchmark.rainforest_published_entry_total_dollars).toBe(14252.16)
    } finally {
      await new Promise((resolve) => srv.close(resolve))
    }
  })
})
