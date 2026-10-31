// Billing routes. Splits into two routers because the webhook needs
// the raw request body for signature verification (most providers
// sign the bytes, not the parsed JSON), while the rest of the
// endpoints want JSON parsing + auth.
//
//   publicRouter — POST /webhook (no auth, raw body, provider-signed)
//   authRouter   — GET /status (any role), POST /checkout + /portal
//                  (admin-only, applied at the app.js mount)

import { monitor } from '../monitoring/index.js'
import { storeVerifiedEvent, applyStoredEvent } from '../billing/webhookReceipts.js'
import { Router } from 'express'
import express from 'express'
import pool from '../db.js'
import {
  getPlan,
  PLANS,
  PARISH_PRICING_TIERS,
  PARISH_PRICING_FLOOR_V21,
  COVER_FEE_DEFAULT_CHECKED,
  STRIPE_CONNECT_MODE_A0,
  buildStripeNonprofitAndMcc8398Guide,
  evaluateParishPricingFloor,
} from '../billing/plans.js'
import { isBetaBillingOn, stripPlanAmounts } from '../billing/beta.js'
import {
  createCheckoutSession,
  createPortalSession,
  verifyWebhook,
} from '../billing/provider.js'

// Where the client lives — used to build success/cancel/return URLs.
const CLIENT_URL = (process.env.CLIENT_URL || 'http://localhost:5202').replace(/\/$/, '')

// ── Public router (no auth) ──────────────────────────────────────
export const publicRouter = Router()

// GET /api/billing/nonprofit-fee-guide & /api/billing/nonprofit-rate-guide
// Public transparency guide for 501(c)(3) parishes: how to apply directly to
// Stripe for the 2.2% + 30c Nonprofit Rate (>=80% tax-deductible donations)
// and MCC 8398 Visa Charity Interchange (1.35% + 5c on OSL Rail B), plus
// the Published Entry vs $15M+/mo Scale rate comparison.
function handleNonprofitRateGuide(_req, res) {
  const benchmark = evaluateParishPricingFloor()
  res.json({
    guide: buildStripeNonprofitAndMcc8398Guide(),
    connect_mode: STRIPE_CONNECT_MODE_A0,
    cover_fee_default_checked: COVER_FEE_DEFAULT_CHECKED,
    pricing_approval_status: 'illustrative_unapproved',
    parish_pricing_tiers: PARISH_PRICING_TIERS,
    pricing_floor_v21: PARISH_PRICING_FLOOR_V21,
    parish_pricing_floor_v21: PARISH_PRICING_FLOOR_V21,
    medium_parish_benchmark: benchmark,
    sample_500k_parish_model: benchmark,
  })
}
publicRouter.get('/nonprofit-fee-guide', handleNonprofitRateGuide)
publicRouter.get('/nonprofit-rate-guide', handleNonprofitRateGuide)

// POST /api/billing/webhook
// Provider posts subscription lifecycle events here (and completed giving
// checkouts — see payments/index.js). We feed the raw body + signature
// header to the provider module which verifies and applies.
//
// A failure to PROCESS a verified event is answered 5xx (1 Sep). This
// route used to answer 200 to every non-signature error, on the stated
// grounds that "real failures get logged for retry-from-our-side". There
// is no such retry anywhere in this codebase: no stored events, no replay
// job, nothing reads the log back. So a checkout.session.completed whose
// donation INSERT failed — a parish deleting the fund between checkout
// and webhook is enough (FK 23503) — meant money moved, no row, no
// receipt, and the provider told "delivered". Stripe retries a non-2xx
// with backoff for up to three days; that is the retry, and it costs a
// log line. Every handler here is idempotent (uq_donations_org_payment_ref,
// COALESCE updates), so a redelivery cannot double-apply.
//
// Since Stage 6 (Oct 2026) provider retries are no longer the only record:
// every verified event is stored in ochr_billing_event_receipts before it is
// applied (billing/webhookReceipts.js). An event for an organization on hold
// is stored, acknowledged and left unapplied ('held'); operators reconcile
// from that table (routes/maintenance.js).
publicRouter.post(
  '/webhook',
  express.raw({ type: '*/*', limit: '1mb' }),
  async (req, res) => {
    let verified
    try {
      const signature = req.headers['stripe-signature']
                     || req.headers['x-signature']
                     || req.headers['webhook-signature']
                     || null
      verified = await verifyWebhook({ rawBody: req.body, signature })
    } catch (err) {
      console.error('billing webhook failed:', err)
      // Bad signature = 400 (fail closed; a retry would carry the same bad
      // signature, and nothing is stored). Anything else = 5xx so the
      // provider redelivers.
      return res.status(err.statusCode === 400 ? 400 : 500).json({ received: false, error: err.message })
    }
    if (verified.result) return res.json(verified.result)

    // Durable first (Stage 6): the event is stored before anything is
    // applied and before the provider hears "received". If storing fails,
    // say so with a 5xx and let the provider redeliver.
    let receipt
    try {
      receipt = await storeVerifiedEvent(verified.event, req.body)
    } catch (err) {
      monitor.error('billing.webhook.store', err)
      return res.status(500).json({ received: false, error: 'Event could not be stored; redeliver.' })
    }
    try {
      const outcome = await applyStoredEvent(receipt.receiptId)
      if (outcome.status === 'applied') {
        return res.json({ ...(outcome.result ?? { received: true }), received: true, ...(outcome.duplicate ? { duplicate: true } : {}) })
      }
      if (outcome.status === 'deferred') return res.json(outcome.result)
      if (outcome.inProgress) {
        // Another delivery of this event is applying it right now. Stored;
        // not yet known to be applied, so ask the provider to come back.
        return res.status(503).json({ received: false, stored: true, in_progress: true })
      }
      if (outcome.status === 'held') {
        // Kept, not applied: the organization is on hold. Acknowledged, so
        // the provider stops; reconciliation reads it from the receipts.
        return res.json({ received: true, stored: true, applied: false, reason: 'organization_on_hold' })
      }
      // Stored but not applied for another reason: redelivery retries it.
      return res.status(500).json({ received: false, stored: true, error: outcome.error ?? 'Event was stored but not applied' })
    } catch (err) {
      monitor.error('billing.webhook.apply', err, { receiptId: receipt.receiptId })
      return res.status(500).json({ received: false, stored: true, error: 'Event was stored but not applied' })
    }
  }
)

// ── Auth router (auth-gated) ─────────────────────────────────────
export const authRouter = Router()

// GET /api/billing/status
// Returns the current org's plan + billing state. Any authenticated
// role can read — staff and viewers may want to see "you're on Pro,
// renews Apr 25" without being able to change it.
authRouter.get('/status', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT plan, billing_status, current_period_end, trial_ends_at
         FROM ochr_organizations
        WHERE id = $1`,
      [req.organizationId]
    )
    if (!rows.length) return res.status(404).json({ error: 'Organization not found' })
    const o = rows[0]
    const beta = isBetaBillingOn()
    const shape = beta ? stripPlanAmounts : (p) => p
    res.json({
      plan:               o.plan || 'free',
      planDetails:        shape(getPlan(o.plan || 'free')),
      billing_status:     o.billing_status,
      current_period_end: o.current_period_end,
      trial_ends_at:      o.trial_ends_at,
      // SP-186 S4 / R398-2: during the beta no plan tiers (and so no
      // tier limits) are announced. Enforcement and planDetails unchanged.
      availablePlans:     beta ? [] : Object.values(PLANS).map(shape),
      beta_billing:       beta,
      ...(beta ? {} : { parishPricingTiers: PARISH_PRICING_TIERS }),
      pricingApprovalStatus: 'illustrative_unapproved',
      connectMode:        STRIPE_CONNECT_MODE_A0,
      coverFeeDefaultChecked: COVER_FEE_DEFAULT_CHECKED,
      nonprofitFeeGuide:  buildStripeNonprofitAndMcc8398Guide({ id: req.organizationId }),
    })
  } catch (err) {
    console.error('billing status failed:', err)
    res.status(500).json({ error: 'Failed to load billing status' })
  }
})

// POST /api/billing/checkout
// Creates a checkout session for the requested plan and returns a
// URL the client should redirect the browser to. Admin-only (gate
// applied at the app.js mount).
authRouter.post('/checkout', async (req, res) => {
  // Open beta: no NEW paid checkouts (R398-1). Portal stays open below.
  if (isBetaBillingOn()) return res.status(409).json({ error: 'beta_billing_disabled' })
  try {
    const { planId } = req.body ?? {}
    const plan = getPlan(planId)
    if (plan.id === 'free') {
      return res.status(400).json({ error: 'Free plan does not require checkout' })
    }
    const { url } = await createCheckoutSession({
      orgId:       req.organizationId,
      planId:      plan.id,
      successUrl:  `${CLIENT_URL}/billing?success=1`,
      cancelUrl:   `${CLIENT_URL}/billing?canceled=1`,
    })
    res.json({ url })
  } catch (err) {
    console.error('billing checkout failed:', err)
    res.status(500).json({ error: 'Failed to start checkout' })
  }
})

// POST /api/billing/portal
// Creates a customer-portal session for managing payment method,
// canceling, viewing invoices. Admin-only.
authRouter.post('/portal', async (req, res) => {
  try {
    const { url } = await createPortalSession({
      orgId:     req.organizationId,
      returnUrl: `${CLIENT_URL}/billing`,
    })
    res.json({ url })
  } catch (err) {
    console.error('billing portal failed:', err)
    res.status(500).json({ error: 'Failed to open portal' })
  }
})
