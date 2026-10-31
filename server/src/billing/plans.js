// Plan definitions & Parish Pricing Floor (José's Ledger Audit t71ua0 / t71u).
// Single source of truth for plan limits, illustrative parish tiers,
// Stripe Connect Mode A0 ("Stripe handles pricing" + Direct Charges),
// Published Entry vs. $15M+/mo Scale Target Rail B rates, and 501(c)(3)
// Stripe Nonprofit + Visa Charity MCC 8398 fee guidance.
//
// `Infinity` in JS doesn't survive JSON.stringify (it turns into `null`),
// so we use `null` to mean "unlimited" — any limit check treats `null`
// as no cap, and the JSON wire representation stays honest.

export const STRIPE_CONNECT_MODE_A0 = 'A0_STRIPE_HANDLES_PRICING_DIRECT_CHARGE'

export const COVER_FEE_DEFAULT_CHECKED = false

export const PARISH_PRICING_TIERS = Object.freeze({
  small_parish: {
    id: 'small_parish',
    name: 'Small Parish (< 150 active families)',
    priceMonthly: 49,
    status: 'illustrative_unapproved',
    pricingApprovalStatus: 'illustrative_unapproved',
    note: 'Illustrative tier pending formal lock by Dale and José.',
  },
  parish_standard: {
    id: 'parish_standard',
    name: 'Parish Standard (150–600 active families)',
    priceMonthly: 79,
    status: 'illustrative_unapproved',
    pricingApprovalStatus: 'illustrative_unapproved',
    note: 'Illustrative tier pending formal lock by Dale and José.',
  },
  cathedral_multi_site: {
    id: 'cathedral_multi_site',
    name: 'Cathedral & Multi-Site (600+ families)',
    priceMonthly: 149,
    status: 'illustrative_unapproved',
    pricingApprovalStatus: 'illustrative_unapproved',
    note: 'Illustrative tier pending formal lock by Dale and José.',
  },
  founding_10_charter: {
    id: 'founding_10_charter',
    name: 'Founding 10 Charter Parish (50% lifetime discount on illustrative tiers)',
    discountPercent: 50,
    illustrativeMonthlyPrices: {
      small_parish: 24.5,
      parish_standard: 39.5,
      cathedral_multi_site: 74.5,
    },
    status: 'illustrative_unapproved',
    pricingApprovalStatus: 'illustrative_unapproved',
    note: 'Illustrative charter tier pending formal lock by Dale and José.',
  },
})

export const PARISH_PRICING_FLOOR_V21 = Object.freeze({
  version: '2.1.0',
  coverFeeDefaultChecked: COVER_FEE_DEFAULT_CHECKED,
  rail_a0_stripe_direct_charge: {
    rail_id: 'rail_a0_stripe_direct_charge',
    connect_mode: STRIPE_CONNECT_MODE_A0,
    pricing_owner: 'stripe_handles_pricing',
    charge_type: 'direct_charge',
    stripe_account_header_required: true,
    application_fee_amount: 0,
    osl_monthly_active_account_fee_cents: 0,
    osl_payout_fee_bps: 0,
    osl_payout_fee_fixed_cents: 0,
    card_standard_rate_bps: 290,
    card_standard_fixed_cents: 30,
    card_nonprofit_501c3_rate_bps: 220,
    card_nonprofit_501c3_fixed_cents: 30,
    ach_rate_bps: 80,
    ach_cap_cents: 500,
    ach_instant_win_threshold_cents: 62500,
    banned_modes: ['A_OSL_ABSORBS_CONNECT_FEES', 'YOU_HANDLE_PRICING_PLATFORM_PAYS'],
  },
  rainforest_published_entry: {
    rail_id: 'rainforest_published_entry',
    tier: 'published_entry_0_to_5m_monthly',
    is_default_entry_rate: true,
    card_markup_bps: 30,
    card_markup_fixed_cents: 30,
    network_assessment_dfa_bps: 14,
    network_assessment_dfa_fixed_cents: 2,
    ach_flat_fee_cents: 20,
    payout_fee_cents: 20,
    monthly_active_merchant_fee_cents: 0,
  },
  finix_published_entry: {
    rail_id: 'finix_published_entry',
    tier: 'published_entry_0_to_5m_monthly',
    is_default_entry_rate: true,
    card_markup_bps: 30,
    card_markup_fixed_cents: 15,
    network_assessment_dfa_bps: 14,
    network_assessment_dfa_fixed_cents: 2,
    ach_rate_bps: 100,
    ach_fixed_cents: 25,
    ach_cap_cents: 1000,
    monthly_active_merchant_fee_cents: 250,
    payout_fee_cents: 50,
  },
  finix_scale_target_15m_monthly: {
    rail_id: 'finix_scale_target_15m_monthly',
    tier: 'negotiated_scale_target_15m_monthly',
    is_default_entry_rate: false,
    minimum_monthly_volume_cents: 1500000000,
    card_markup_bps: 15,
    card_markup_fixed_cents: 8,
    ach_flat_fee_cents: 25,
  },
  interchange_constants: {
    debit_blend: {
      durbin_regulated_share: 0.70,
      durbin_regulated_rate_bps: 5,
      durbin_regulated_fixed_cents: 22,
      durbin_exempt_share: 0.30,
      durbin_exempt_rate_bps: 80,
      durbin_exempt_fixed_cents: 15,
      statutory_citation: '12 CFR 235.3–235.4 (Federal Reserve Regulation II)',
    },
    credit_interchange: {
      visa_charity_mcc_8398_rate_bps: 135,
      visa_charity_mcc_8398_fixed_cents: 5,
      standard_cnp_rate_bps: 210,
      standard_cnp_fixed_cents: 10,
    },
    network_assessments_dfa: {
      rate_bps: 14,
      fixed_cents: 2,
    },
  },
})

export function buildStripeNonprofitAndMcc8398Guide(parish = {}) {
  return {
    parish_id: parish.organizationId || parish.id || null,
    parish_name: parish.name || null,
    stripe_nonprofit_application_url:
      'https://support.stripe.com/questions/fee-discount-for-nonprofit-organizations',
    support_email: 'nonprofit@stripe.com',
    connect_mode: STRIPE_CONNECT_MODE_A0,
    application_fee_amount: 0,
    cover_fee_default_checked: COVER_FEE_DEFAULT_CHECKED,
    eligibility_requirements: [
      'IRS 501(c)(3) determination letter (or listing in the Official Catholic Directory / USCCB group ruling)',
      'At least 80% of payment volume on the connected Stripe account consists of tax-deductible donations (>=80% donation rule)',
    ],
    discounted_stripe_rates: {
      cards_nonprofit_rate: '2.2% + $0.30',
      cards_standard_rate: '2.9% + $0.30',
      ach_direct_debit_rate: '0.80% capped at $5.00 (instant win for gifts >= $625)',
      osl_platform_fee_cents: 0,
      osl_connect_active_account_fee_cents: 0,
      osl_connect_payout_fee_cents: 0,
    },
    mcc_8398_charity_interchange: {
      mcc_code: '8398',
      mcc_description: 'Charitable and Social Service Organizations',
      visa_charity_credit_interchange: '1.35% + $0.05 (vs. 2.10% + $0.10 standard CNP)',
      durbin_regulated_debit_interchange: '0.05% + $0.22 (70% regulated / 30% exempt blend)',
      network_assessments_dfa: '0.14% + $0.02',
    },
    parish_pricing_tiers_status: 'illustrative_unapproved',
  }
}

export function evaluateParishPricingFloor({
  annualVolumeDollars = 1200000,
  averageGiftDollars = 150,
  achShare = 0.20,
  debitShare = 0.48,
  creditShare = 0.32,
} = {}) {
  const totalTxCount = Math.round(annualVolumeDollars / averageGiftDollars)
  const achTxCount = Math.round(totalTxCount * achShare)
  const debitTxCount = Math.round(totalTxCount * debitShare)
  const creditTxCount = totalTxCount - achTxCount - debitTxCount
  const cardTxCount = debitTxCount + creditTxCount

  const debitVolumeDollars = debitTxCount * averageGiftDollars
  const creditVolumeDollars = creditTxCount * averageGiftDollars
  const cardVolumeDollars = debitVolumeDollars + creditVolumeDollars

  const durbinTxCount = debitTxCount * 0.70
  const exemptTxCount = debitTxCount * 0.30
  const durbinVol = debitVolumeDollars * 0.70
  const exemptVol = debitVolumeDollars * 0.30

  const debitIcDollars =
    durbinVol * 0.0005 + durbinTxCount * 0.22 + exemptVol * 0.008 + exemptTxCount * 0.15
  const creditCharityIcDollars = creditVolumeDollars * 0.0135 + creditTxCount * 0.05
  const totalCardIcDollars = Number((debitIcDollars + creditCharityIcDollars).toFixed(2))
  const totalDfaDollars = Number((cardVolumeDollars * 0.0014 + cardTxCount * 0.02).toFixed(2))

  const rainforestMarkupDollars = Number(
    (cardVolumeDollars * 0.003 + cardTxCount * 0.3 + achTxCount * 0.2).toFixed(2)
  )
  const rainforestTotalAnnualDollars = Number(
    (totalCardIcDollars + totalDfaDollars + rainforestMarkupDollars).toFixed(2)
  )

  const finixAchFeePerGiftDollars = Math.min(averageGiftDollars * 0.01 + 0.25, 10.0)
  const finixPublishedEntryMarkupDollars = Number(
    (
      cardVolumeDollars * 0.003 +
      cardTxCount * 0.15 +
      achTxCount * finixAchFeePerGiftDollars
    ).toFixed(2)
  )
  const finixPublishedEntryTotalAnnualDollars = Number(
    (totalCardIcDollars + totalDfaDollars + finixPublishedEntryMarkupDollars).toFixed(2)
  )

  const tithelyTotalAnnualDollars = Number(
    (
      cardVolumeDollars * 0.029 +
      cardTxCount * 0.3 +
      achTxCount * averageGiftDollars * 0.01 +
      achTxCount * 0.3
    ).toFixed(2)
  )

  const stripeStandardAnnualDollars = Number(
    (
      cardVolumeDollars * 0.029 +
      cardTxCount * 0.3 +
      achTxCount * Math.min(averageGiftDollars * 0.008, 5.0)
    ).toFixed(2)
  )

  return {
    connect_mode: STRIPE_CONNECT_MODE_A0,
    cover_fee_default_checked: COVER_FEE_DEFAULT_CHECKED,
    total_tx_count: totalTxCount,
    ach_tx_count: achTxCount,
    debit_tx_count: debitTxCount,
    credit_tx_count: creditTxCount,
    card_interchange_mcc_8398_dollars: totalCardIcDollars,
    network_assessments_dfa_dollars: totalDfaDollars,
    rainforest_published_entry_total_dollars: rainforestTotalAnnualDollars,
    finix_published_entry_total_dollars: finixPublishedEntryTotalAnnualDollars,
    tithely_total_dollars: tithelyTotalAnnualDollars,
    stripe_standard_total_dollars: stripeStandardAnnualDollars,
    rainforest_savings_vs_tithely_dollars: Number(
      (tithelyTotalAnnualDollars - rainforestTotalAnnualDollars).toFixed(2)
    ),
    finix_published_savings_vs_tithely_dollars: Number(
      (tithelyTotalAnnualDollars - finixPublishedEntryTotalAnnualDollars).toFixed(2)
    ),
  }
}

export const PLAN_IDS = ['free', 'pro']

export const buildNonprofitPaymentOnboardingGuide = buildStripeNonprofitAndMcc8398Guide

export const PLANS = {
  free: {
    id:           'free',
    name:         'Community (Free)',
    price:        0,
    priceMonthly: 0,
    status:       'active',
    pricingApprovalStatus: 'active_free_tier',
    limits: {
      members:                  50,
      events:                   100,
      admins:                   2,
      ai_generations_per_month: 20,
      retention_days:           30,
      email_notifications:      true,
      csv_import:               true,
      audit_log:                false,
    },
  },
  pro: {
    id:           'pro',
    name:         'Parish Pro',
    // Illustrative $49 / $79 / $149 parish pricing tiers — explicitly marked
    // status: 'illustrative_unapproved' until Dale and José formally lock parish pricing.
    price:        79,
    priceMonthly: 79,
    status:       'illustrative_unapproved',
    pricingApprovalStatus: 'illustrative_unapproved',
    // Populated at deploy time via env when the real provider is wired;
    // the stub provider ignores it.
    priceIdEnv:   'BILLING_PRICE_ID_PRO',
    limits: {
      members:                  null,
      events:                   null,
      admins:                   null,
      ai_generations_per_month: 500,
      retention_days:           365,
      email_notifications:      true,
      csv_import:               true,
      audit_log:                true,
    },
  },
}

// Resolve an org's plan key (`ochr_organizations.plan`) to its plan
// object. Any unrecognised value falls back to `free` so a bad DB value
// fails closed rather than granting unlimited access.
export function getPlan(planKey) {
  return PLANS[planKey] ?? PLANS.free
}

// Is a given feature boolean enabled on this plan?
export function hasFeature(planKey, feature) {
  const plan = getPlan(planKey)
  return Boolean(plan.limits[feature])
}

// Numeric limit for a resource (`null` = unlimited).
export function getLimit(planKey, resource) {
  const plan = getPlan(planKey)
  const v = plan.limits[resource]
  return v === undefined ? null : v
}
