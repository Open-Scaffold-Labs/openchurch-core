// Billing routes. Splits into two routers because the webhook needs
// the raw request body for signature verification (most providers
// sign the bytes, not the parsed JSON), while the rest of the
// endpoints want JSON parsing + auth.
//
//   publicRouter — POST /webhook (no auth, raw body, provider-signed)
//   authRouter   — GET /status (any role), POST /checkout + /portal
//                  (admin-only, applied at the app.js mount)

import { Router } from 'express'
import express from 'express'
import pool from '../db.js'
import { getPlan, PLANS } from '../billing/plans.js'
import {
  createCheckoutSession,
  createPortalSession,
  handleWebhook,
} from '../billing/provider.js'

// Where the client lives — used to build success/cancel/return URLs.
const CLIENT_URL = (process.env.CLIENT_URL || 'http://localhost:5202').replace(/\/$/, '')

// ── Public router (no auth) ──────────────────────────────────────
export const publicRouter = Router()

// POST /api/billing/webhook
// Provider posts subscription lifecycle events here. We feed the raw
// body + signature header to the provider module which verifies and
// applies. Always returns 200 quickly so the provider doesn't retry —
// real failures get logged for retry-from-our-side.
publicRouter.post(
  '/webhook',
  express.raw({ type: '*/*', limit: '1mb' }),
  async (req, res) => {
    try {
      const signature = req.headers['stripe-signature']
                     || req.headers['x-signature']
                     || req.headers['webhook-signature']
                     || null
      const result = await handleWebhook({ rawBody: req.body, signature })
      res.json(result)
    } catch (err) {
      console.error('billing webhook failed:', err)
      // Bad signature = 400 (fail closed, provider should not consider
      // it delivered). Anything else returns 200 — webhooks should be
      // idempotent on the provider side, and a 5xx makes them retry
      // which spams logs. Real failures are visible in monitoring.
      res.status(err.statusCode === 400 ? 400 : 200).json({ received: false, error: err.message })
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
    res.json({
      plan:               o.plan || 'free',
      planDetails:        getPlan(o.plan || 'free'),
      billing_status:     o.billing_status,
      current_period_end: o.current_period_end,
      trial_ends_at:      o.trial_ends_at,
      availablePlans:     Object.values(PLANS),
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
