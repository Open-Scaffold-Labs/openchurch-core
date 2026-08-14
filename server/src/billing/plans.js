// Plan definitions. Provider-agnostic — `provider_price_id` is the
// only field that bakes in vendor specifics, and it's nullable so the
// stub flow works without it. When a real provider gets wired in,
// fill these from env (e.g. process.env.PRICE_ID_PRO) so price-id
// rotations don't require a code change.
//
// Pricing here is placeholder — real numbers come once we have the
// product positioning conversation. The shape is what matters for
// scaffolding: each plan has a stable `id`, human-readable `name`
// + `description`, monthly `price` in dollars, a `features` list for
// the UI, and (eventually) `limits` the rest of the app reads to
// enforce gates.

export const PLAN_IDS = ['free', 'pro']

export const PLANS = {
  free: {
    id:          'free',
    name:        'Free',
    description: 'For small congregations getting started.',
    price:       0,
    features: [
      'Up to 50 members',
      'Up to 100 events',
      'Basic scheduling',
      'Email support',
    ],
    limits: {
      members: 50,
      events:  100,
      ai_generations_per_month: 20,
      // How long org-visible operational logs (audit, notification)
      // are kept. Internal accounting tables (ai_usage, scheduled
      // notifications) use fixed windows hard-coded in retention.js.
      retention_days: 30,
    },
    provider_price_id: null,
  },
  pro: {
    id:          'pro',
    name:        'Parish',
    description: 'Everything a parish office needs, one flat price.',
    price:       79, // board-approved flat parish price (2026-07)
    features: [
      'Unlimited members',
      'Unlimited events',
      'Full AI Studio access',
      'Priority support',
      'Custom branding (coming soon)',
    ],
    limits: {
      members: null, // null = unlimited
      events:  null,
      ai_generations_per_month: 500,
      retention_days: 365,
    },
    provider_price_id: process.env.BILLING_PRICE_ID_PRO || null,
  },
}

// Safe accessor — unknown plan ids fall back to free rather than
// throwing, so a stale plan value in the DB doesn't break the page.
export function getPlan(id) {
  return PLANS[id] || PLANS.free
}
