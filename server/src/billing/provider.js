// Vendor-neutral billing transport. Every provider-specific call lives
// in this file — the rest of the app talks to billing via the exports
// here without knowing whether Stripe, Lemon Squeezy, or Paddle is on
// the other end.
//
// Provider selection is env-driven, checked at call time:
//   BILLING_PROVIDER_SECRET set   → live Stripe (secret key, sk_…)
//   BILLING_PROVIDER_SECRET unset → stub (dev default; no network)
//   BILLING_WEBHOOK_SECRET        → Stripe webhook signing secret (whsec_…),
//                                   required for live webhook processing —
//                                   live BILLING or live GIVING; the
//                                   endpoint records donations too. On its
//                                   own it is sufficient: while it is set,
//                                   deliveries are verified and gifts are
//                                   recorded whatever the provider switches
//                                   say (see handleWebhook).
//
// All exports return the same shape regardless of provider so the
// routes layer is provider-blind.

import pool from '../db.js'
import { getPlan } from './plans.js'
import { stripeRequest, verifyStripeSignature } from '../utils/stripeApi.js'
import { recordDonationCheckoutCompleted, paymentsLiveCredentialPresent } from '../payments/index.js'
import { monitor } from '../monitoring/index.js'

// Call-time check (not module-load) so tests can toggle and a redeploy
// isn't needed to flip modes.
const isStub = () => !process.env.BILLING_PROVIDER_SECRET
const secret = () => process.env.BILLING_PROVIDER_SECRET

// ── Checkout session ─────────────────────────────────────────────
// Caller passes `successUrl` + `cancelUrl`; we return `{ url }` to
// redirect the browser to.
export async function createCheckoutSession({ orgId, planId, successUrl, cancelUrl }) {
  const plan = getPlan(planId)
  if (plan.id === 'free') throw new Error('Free plan does not require checkout')

  if (isStub()) {
    console.log('[billing:stub] createCheckoutSession', { orgId, planId, successUrl, cancelUrl })
    // Pretend the user paid and bounce them to the success URL with a
    // marker query param so the success page can show a "thanks" note.
    await applySubscriptionEvent({
      organizationId: orgId,
      plan: planId,
      status: 'active',
      providerCustomerId:     `stub_cus_${orgId}`,
      providerSubscriptionId: `stub_sub_${orgId}_${Date.now()}`,
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // +30d
    })
    const sep = successUrl.includes('?') ? '&' : '?'
    return { url: `${successUrl}${sep}stub_checkout=1` }
  }

  // Live: Stripe hosted Checkout, subscription mode. If the plan has a
  // dashboard-managed price id use it; otherwise inline price_data from
  // plans.js so activation needs zero Stripe-dashboard setup.
  const line_items = [
    plan.provider_price_id
      ? { price: plan.provider_price_id, quantity: 1 }
      : {
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: Math.round(plan.price * 100),
            recurring: { interval: 'month' },
            product_data: { name: `OpenChurch ${plan.name}` },
          },
        },
  ]

  const session = await stripeRequest('checkout/sessions', {
    mode: 'subscription',
    line_items,
    success_url: successUrl,
    cancel_url:  cancelUrl,
    client_reference_id: String(orgId),
    metadata: { organization_id: String(orgId), plan: plan.id },
    subscription_data: { metadata: { organization_id: String(orgId), plan: plan.id } },
  }, secret())

  return { url: session.url }
}

// ── Customer portal session ──────────────────────────────────────
// Returns `{ url }` for the provider's hosted portal where the
// customer can update payment method, cancel, see invoices, etc.
export async function createPortalSession({ orgId, returnUrl }) {
  if (isStub()) {
    console.log('[billing:stub] createPortalSession', { orgId, returnUrl })
    // No real portal in stub mode — just bounce back to where the user
    // came from, with a marker so the UI can show a "stub mode" note.
    const sep = returnUrl.includes('?') ? '&' : '?'
    return { url: `${returnUrl}${sep}stub_portal=1` }
  }

  const { rows } = await pool.query(
    'SELECT provider_customer_id FROM ochr_organizations WHERE id = $1',
    [orgId]
  )
  const customer = rows[0]?.provider_customer_id
  if (!customer || customer.startsWith('stub_')) {
    throw new Error('No billing customer on file yet — subscribe first')
  }

  const session = await stripeRequest('billing_portal/sessions', {
    customer,
    return_url: returnUrl,
  }, secret())

  return { url: session.url }
}

// ── Webhook handler ──────────────────────────────────────────────
// Raw body + signature header from the provider's webhook HTTP call.
// Signature is verified first — fail closed: a bad/missing signature
// throws a 400-tagged error and nothing is processed. On a verified
// event, normalize into applySubscriptionEvent (subscriptions) or hand
// giving events to the payments module.
//
// THIS ENDPOINT IS SHARED WITH GIVING, AND GIVING HAS ITS OWN SWITCH.
// PAYMENTS_PROVIDER_SECRET flips parishioner giving to live Stripe on its
// own (payments/index.js, "two concerns, two variables") — and every one
// of those gifts is recorded by a checkout.session.completed arriving
// HERE. The stub short-circuit used to read only the billing secret, so
// giving-live-with-billing-stub — the natural first step for a parish
// that takes gifts before it pays for a plan — answered every donation
// event {received:true, stub:true} 200 before parsing it. Stripe does not
// retry a 2xx. Money moved, no row, no receipt, and nothing red anywhere
// (reproduced 4 Sep). The stub answer is only honest when NEITHER side of
// this endpoint is live.
//
// AND "LIVE" IS THE WRONG QUESTION TOO. The gate above was then written as
// "is a live credential present on either side", which still let the
// SELECTED provider decide what happens to a delivery. Remove
// PAYMENTS_PROVIDER_SECRET — a key rotation, or a rollback that pulled the
// whole variable — with BILLING_WEBHOOK_SECRET still set, and the sessions
// donors had already completed arrived at an endpoint that answered
// {received:true, stub:true} 200 without reading the signature. Bad
// signatures got the same 200 (reproduced 8 Sep). The money moved at Stripe
// regardless of what this deployment now selects; the only thing that
// should decide whether an event is processed is whether it can be VERIFIED.
//
// So the gate is the signing secret. No BILLING_WEBHOOK_SECRET and nothing
// live → there is nothing to verify against and the stub ack is the honest
// answer. A signing secret present → verify (400 on a bad signature) and
// process donation events whatever giving is set to. Subscription events
// while billing is still the stub keep their stub acknowledgement below,
// after verification — there is no billing to apply them to.
// Verify-and-apply in one call (the stub path and the existing callers).
// The route uses the two halves separately so a verified event is stored
// durably between them (webhookReceipts.js).
export async function handleWebhook({ rawBody, signature }) {
  const verified = await verifyWebhook({ rawBody, signature })
  if (verified.result) return verified.result
  return applyWebhookEvent(verified.event)
}

// Returns { result } when there is nothing to verify (billing and giving
// both stub, no signing secret), else { event } for a verified event.
// Throws 400 on a bad signature and 503 when live without a secret.
export async function verifyWebhook({ rawBody, signature }) {
  // A live credential, not a switched-on provider — see
  // paymentsLiveCredentialPresent(). PAYMENTS_PROVIDER=stub with the secret
  // still set is a rollback, and a rollback must not discard the gifts
  // already in flight.
  const givingLive = paymentsLiveCredentialPresent()
  const signingSecret = process.env.BILLING_WEBHOOK_SECRET
  if (!signingSecret && isStub() && !givingLive) {
    console.log('[billing:stub] handleWebhook', { signature, bytes: rawBody?.length ?? 0 })
    return { result: { received: true, stub: true } }
  }

  // Live on either side means a signing secret is REQUIRED. Missing it is
  // a deployment fault, not a bad delivery: a 400 would tell Stripe the
  // event itself is unwanted, and a 200 would tell it the event is done.
  // 503 with the variable's name is neither — Stripe keeps redelivering
  // (up to three days), and the operator sees the reason in the log
  // instead of silence. (routes/billing.js currently answers every non-400
  // as 500; that is still a retry, and the message still names the fix.)
  if (!signingSecret) {
    const err = new Error(
      'BILLING_WEBHOOK_SECRET is not set: this deployment takes live payments but cannot verify ' +
      'or record their webhooks. Set it to the endpoint signing secret (whsec_…); the provider will redeliver.'
    )
    err.statusCode = 503
    monitor.error('billing.webhook.unconfigured', err, { givingLive, billingLive: !isStub() })
    throw err
  }
  if (!verifyStripeSignature(rawBody, signature, signingSecret)) {
    const err = new Error('Webhook signature verification failed')
    err.statusCode = 400
    throw err
  }

  const event = JSON.parse(
    Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody)
  )
  return { event }
}

// Applies a verified event. Idempotent per event (uq_donations_org_payment_ref,
// COALESCE updates), so a redelivery or a reconciliation retry cannot
// double-apply. Never contacts the provider.
export async function applyWebhookEvent(event) {
  const obj = event?.data?.object ?? {}

  // Verified, and now we know what it is. A giving event is handled below
  // whatever billing is doing. Anything else, while billing is still the
  // stub, gets the same stub acknowledgement it always did — billing has
  // not been switched on, so there is nothing to apply it to.
  //
  // A gift is three events, not one. Checkout closes with
  // checkout.session.completed; for a card that is also the payment. For a
  // delayed-notification method (ACH debit, SEPA, OXXO — enabled per
  // dashboard, payment_method_types is not pinned) the session completes
  // with payment_status 'unpaid' and the money is confirmed days later by
  // checkout.session.async_payment_succeeded, or refused by
  // …async_payment_failed. All three carry the same session object, so the
  // recorder reads payment_status and the dedup on payment_ref makes the
  // succeeded event the one that writes the row.
  const isDonationSession = obj.mode === 'payment' && obj.metadata?.kind === 'donation'
  const DONATION_EVENTS = new Set([
    'checkout.session.completed',
    'checkout.session.async_payment_succeeded',
    'checkout.session.async_payment_failed',
  ])
  const isDonation = DONATION_EVENTS.has(event?.type) && isDonationSession
  if (isStub() && !isDonation) {
    console.log('[billing:stub] handleWebhook', { type: event?.type })
    return { received: true, stub: true }
  }

  switch (event?.type) {
    case 'checkout.session.async_payment_failed': {
      // The bank said no, after Checkout had already said "complete". No
      // row was written for the 'unpaid' completion, so there is nothing
      // to reverse — only something to know about, because the donor was
      // shown a success page for money that never arrived.
      if (isDonationSession) {
        monitor.warn('payments.webhook', 'donation async payment failed; nothing recorded',
          { session: obj.id, paymentRef: obj.payment_intent ?? obj.id, orgId: obj.metadata?.organization_id ?? null })
        return { received: true, handled: 'donation-failed' }
      }
      return { received: true, ignored: event.type }
    }

    case 'checkout.session.async_payment_succeeded':
    case 'checkout.session.completed': {
      // Donations ride the same Stripe account/endpoint — payment-mode
      // sessions tagged kind=donation belong to the giving flow.
      if (isDonationSession) {
        await recordDonationCheckoutCompleted(obj)
        return { received: true, handled: 'donation' }
      }
      if (event.type !== 'checkout.session.completed') return { received: true, ignored: event.type }
      if (obj.mode === 'subscription') {
        const orgId = Number(obj.metadata?.organization_id ?? obj.client_reference_id)
        if (!Number.isInteger(orgId)) {
          monitor.warn('billing.webhook', 'checkout.session.completed without org id', { session: obj.id })
          return { received: true, ignored: 'no-org' }
        }
        await applySubscriptionEvent({
          organizationId: orgId,
          plan:   obj.metadata?.plan ?? null,
          status: 'active',
          providerCustomerId:     obj.customer ?? null,
          providerSubscriptionId: obj.subscription ?? null,
          currentPeriodEnd: null, // arrives with customer.subscription.updated
        })
        return { received: true, handled: event.type }
      }
      return { received: true, ignored: event.type }
    }

    case 'customer.subscription.updated': {
      const orgId = await resolveOrgForSubscription(obj)
      if (!orgId) return { received: true, ignored: 'no-org' }
      const STATUS_MAP = {
        active: 'active', trialing: 'active',
        past_due: 'past_due',
        canceled: 'canceled', unpaid: 'canceled', incomplete_expired: 'canceled',
      }
      await applySubscriptionEvent({
        organizationId: orgId,
        plan:   obj.metadata?.plan ?? null,
        status: STATUS_MAP[obj.status] ?? null,
        providerCustomerId:     obj.customer ?? null,
        providerSubscriptionId: obj.id ?? null,
        currentPeriodEnd: obj.current_period_end
          ? new Date(obj.current_period_end * 1000)
          : null,
      })
      return { received: true, handled: event.type }
    }

    case 'customer.subscription.deleted': {
      const orgId = await resolveOrgForSubscription(obj)
      if (!orgId) return { received: true, ignored: 'no-org' }
      await applySubscriptionEvent({
        organizationId: orgId,
        plan:   'free',
        status: 'canceled',
        providerCustomerId:     null,
        providerSubscriptionId: null,
        currentPeriodEnd: null,
      })
      return { received: true, handled: event.type }
    }

    default:
      return { received: true, ignored: event?.type ?? 'unknown' }
  }
}

// Subscription events carry our org id in metadata (we stamp it at
// checkout). Fall back to a lookup by the stored subscription id for
// events created outside our checkout flow.
async function resolveOrgForSubscription(sub) {
  const fromMeta = Number(sub?.metadata?.organization_id)
  if (Number.isInteger(fromMeta) && fromMeta > 0) return fromMeta
  if (!sub?.id) return null
  const { rows } = await pool.query(
    'SELECT id FROM ochr_organizations WHERE provider_subscription_id = $1',
    [sub.id]
  )
  return rows[0]?.id ?? null
}

// ── Apply event to DB ────────────────────────────────────────────
// Provider-agnostic. Webhook handlers translate raw provider events
// into this shape and call into here. Also called by the stub
// checkout flow to simulate a successful subscription.
//
// Updates the org row in place — every billing field is on
// ochr_organizations (no separate subscriptions table) since each org
// has at most one active subscription at a time in our model.
export async function applySubscriptionEvent({
  organizationId,
  plan,
  status,
  providerCustomerId,
  providerSubscriptionId,
  currentPeriodEnd,
}) {
  await pool.query(
    `UPDATE ochr_organizations
        SET plan                     = COALESCE($2, plan),
            billing_status           = COALESCE($3, billing_status),
            provider_customer_id     = COALESCE($4, provider_customer_id),
            provider_subscription_id = COALESCE($5, provider_subscription_id),
            current_period_end       = COALESCE($6, current_period_end)
      WHERE id = $1`,
    [organizationId, plan ?? null, status ?? null, providerCustomerId ?? null, providerSubscriptionId ?? null, currentPeriodEnd ?? null]
  )
}
