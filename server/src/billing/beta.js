// Open-beta billing switch (R398-1). Server-side, read per request.
//
// Safe default: beta ON — new paid checkouts are refused and price
// amounts are withheld from /api/billing/status. Only an explicit
// OC_BETA_BILLING=off|false|0 turns paid sign-up back on. Existing
// subscribers keep the portal; webhooks, Stripe config and
// subscription records are untouched. Entitlements are NOT changed
// here: José decided R398-2 (2026-10-25) that beta parishes keep the
// current free limits, and beta copy does not announce limits.
export function isBetaBillingOn(env = process.env) {
  const v = String(env.OC_BETA_BILLING ?? '').trim().toLowerCase()
  return !['off', 'false', '0', 'no'].includes(v)
}

export function stripPlanAmounts(plan) {
  if (!plan || typeof plan !== 'object') return plan
  // eslint-disable-next-line no-unused-vars
  const { price, provider_price_id, ...rest } = plan
  return rest
}
