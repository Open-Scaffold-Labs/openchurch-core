// createCharge() — the single entrypoint the giving flow uses to take
// a payment. The provider-specific transport lives at the bottom of
// this file, exactly like notifications/transport.js. When the team
// lead picks Stripe / Adyen / etc., the only thing that changes is the
// dispatch block here (and unit conversion inside it) — the public
// give route and the recorded ochr_donations row don't move.
//
// PAYMENTS_PROVIDER selects the transport (default 'stub'). The stub
// never touches a card or moves money: it returns a synthetic
// succeeded charge so the whole give → record → receipt path is real
// and testable today, ahead of a provider pick.
//
// Money is passed around in whole-currency units (dollars) to match
// ochr_donations.amount NUMERIC(10,2). A real adapter converts to the
// provider's unit (e.g. Stripe cents) at the boundary — that
// conversion is a provider-file concern, not a caller concern.

import pool from '../db.js'
import { monitor } from '../monitoring/index.js'
import { notify } from '../notifications/transport.js'
import { stripeRequest } from '../utils/stripeApi.js'

// Provider selection, checked at call time. Explicit PAYMENTS_PROVIDER
// wins; otherwise the presence of the Stripe secret (shared with
// billing) flips giving to live. No secret, no env → stub.
const stripeSecret = () => process.env.BILLING_PROVIDER_SECRET
function currentProvider() {
  if (process.env.PAYMENTS_PROVIDER) return process.env.PAYMENTS_PROVIDER
  return stripeSecret() ? 'stripe' : 'stub'
}

function randomRef(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
}

// The stub transport — current default. Logs and returns a synthetic
// succeeded charge. No network, no money. Swapping in a real provider
// replaces this function; createCharge()'s contract stays the same.
//
// When the caller supplies an idempotencyKey (the recurring-gift cron
// does), the synthetic ref is DERIVED from it, not random — so a retried
// call for the same billing period produces the identical payment_ref,
// and the partial unique index uq_donations_org_payment_ref (050) turns
// a retry into a no-op instead of a duplicate row. A real provider maps
// the same key to its native idempotency header.
async function chargeStub({ amount, currency, donorName, idempotencyKey }) {
  const ref = idempotencyKey
    ? `stub_${String(idempotencyKey).replace(/[^a-zA-Z0-9_-]/g, '')}`
    : randomRef('stub')
  console.log(`[pay:stub] → ${donorName ?? '(anonymous)'} | ${currency.toUpperCase()} ${amount.toFixed(2)} | ${ref}`)
  return { id: ref, status: 'succeeded', provider: 'stub' }
}

// Refund the other direction. The stub returns a synthetic refunded
// result; a real provider issues the refund against the original charge.
async function refundStub({ chargeId, amount }) {
  const ref = randomRef('stubref')
  console.log(`[pay:stub] refund ${chargeId ?? '(unknown)'} → ${ref}${amount != null ? ` | ${amount.toFixed(2)}` : ''}`)
  return { id: ref, status: 'refunded', provider: 'stub' }
}

// Live one-time charges go through hosted Checkout (createDonationCheckout
// below), not this synchronous path — a server can't charge a card it never
// saw. Anything that still lands here in live mode (today: the recurring-
// gifts cron) fails loudly with a descriptive error instead of pretending.
async function chargeStripe({ donorName }) {
  // TODO(audit C1): when saved-card charging lands, destructure
  // idempotencyKey here and forward it as Stripe's `Idempotency-Key`
  // header so a retried recurring charge cannot move money twice.
  throw new Error(
    `Stripe saved-card charging is not enabled yet (gift for ${donorName ?? 'donor'}); ` +
    'one-time gifts use hosted Checkout'
  )
}

// Refund a completed Checkout payment. payment_ref on the donation row
// is the PaymentIntent id (pi_…) captured by the webhook.
async function refundStripe({ chargeId, amount }) {
  const refund = await stripeRequest('refunds', {
    payment_intent: chargeId,
    ...(amount != null ? { amount: Math.round(amount * 100) } : {}),
  }, stripeSecret())
  return { id: refund.id, status: refund.status === 'succeeded' || refund.status === 'pending' ? 'refunded' : refund.status, provider: 'stripe' }
}

const TRANSPORTS = {
  stub:   chargeStub,
  stripe: chargeStripe,
}

const REFUND_TRANSPORTS = {
  stub:   refundStub,
  stripe: refundStripe,
}

// createCharge({ organizationId, amount, currency?, donorName?, donorEmail?, metadata?, idempotencyKey? })
//   → { id, status, provider }
//
// Validates the amount defensively (callers also validate, but this is
// the money boundary), dispatches to the configured transport, and
// normalizes failures to a thrown Error the caller turns into a 4xx/5xx.
// idempotencyKey, when provided, makes a retried call safe TODAY only
// for the stub: it derives its ref from the key, so a retry yields the
// same payment_ref and the unique index (050) dedupes the ledger row.
// No LIVE adapter consumes the key yet — saved-card charging
// (chargeStripe) is unimplemented; when it lands it MUST forward this
// as Stripe's Idempotency-Key header to close the double-CHARGE race
// for real. Double-POST protection (the ledger unique index) is live
// everywhere; double-charge protection is currently stub-only.
export async function createCharge({ organizationId, amount, currency = 'usd', donorName, donorEmail, metadata, idempotencyKey }) {
  const cents = Math.round(Number(amount) * 100)
  if (!Number.isFinite(cents) || cents <= 0) {
    throw new Error('Invalid charge amount')
  }

  const PROVIDER = currentProvider()
  const transport = TRANSPORTS[PROVIDER]
  if (!transport) {
    monitor.error('payments.no_transport', new Error(`Unknown PAYMENTS_PROVIDER: ${PROVIDER}`), { organizationId })
    throw new Error('Payments are not configured')
  }

  try {
    const charge = await transport({
      amount: cents / 100,
      currency,
      donorName,
      donorEmail,
      idempotencyKey,
      metadata: { organization_id: organizationId, ...(metadata || {}) },
    })
    if (charge.status !== 'succeeded') {
      throw new Error(`Charge not successful (${charge.status})`)
    }
    return charge
  } catch (err) {
    monitor.error('payments.charge', err, { organizationId, provider: PROVIDER })
    throw err
  }
}

// createRefund({ organizationId, chargeId, amount? }) → { id, status, provider }
// Reverses a prior charge. amount omitted = full refund. Dispatches to
// the configured provider's refund transport; the stub always succeeds.
export async function createRefund({ organizationId, chargeId, amount }) {
  const PROVIDER = currentProvider()
  const transport = REFUND_TRANSPORTS[PROVIDER]
  if (!transport) {
    monitor.error('payments.no_refund_transport', new Error(`Unknown PAYMENTS_PROVIDER: ${PROVIDER}`), { organizationId })
    throw new Error('Refunds are not configured')
  }
  try {
    const refund = await transport({
      chargeId,
      amount: amount != null ? Math.round(Number(amount) * 100) / 100 : undefined,
      metadata: { organization_id: organizationId },
    })
    if (refund.status !== 'refunded') {
      throw new Error(`Refund not successful (${refund.status})`)
    }
    return refund
  } catch (err) {
    monitor.error('payments.refund', err, { organizationId, provider: PROVIDER, chargeId })
    throw err
  }
}

// Surfaced so admin UIs / health checks can show "giving runs on: stub"
// without importing the env var directly.
export function paymentsProvider() {
  return currentProvider()
}

// ── Hosted Checkout for public offerings (live mode) ─────────────
// The public give route calls this instead of createCharge when Stripe
// is live: the donor is redirected to Stripe's hosted page, and the
// donation row is written by the webhook when the session completes —
// never before money actually moved.
export async function createDonationCheckout({
  organizationId, amount, fundId, fundName, donorName, donorEmail, message,
  successUrl, cancelUrl,
}) {
  const cents = Math.round(Number(amount) * 100)
  if (!Number.isFinite(cents) || cents <= 0) throw new Error('Invalid gift amount')

  const session = await stripeRequest('checkout/sessions', {
    mode: 'payment',
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: cents,
        product_data: { name: `Offering — ${fundName}` },
      },
    }],
    success_url: successUrl,
    cancel_url:  cancelUrl,
    ...(donorEmail ? { customer_email: donorEmail } : {}),
    metadata: {
      kind: 'donation',
      organization_id: String(organizationId),
      fund_id:   String(fundId),
      fund:      String(fundName).slice(0, 200),
      donor_name: String(donorName).slice(0, 200),
      ...(donorEmail ? { donor_email: String(donorEmail).slice(0, 200) } : {}),
      ...(message ? { message: String(message).slice(0, 400) } : {}),
    },
  }, stripeSecret())

  return { url: session.url, sessionId: session.id }
}

// Webhook completion → the ochr_donations row + receipt. Idempotent on
// the PaymentIntent id: Stripe retries webhooks, the row appears once.
export async function recordDonationCheckoutCompleted(session) {
  const md = session?.metadata ?? {}
  const orgId  = Number(md.organization_id)
  const fundId = Number(md.fund_id)
  const paymentRef = session?.payment_intent ?? session?.id
  const dollars = Math.round(Number(session?.amount_total)) / 100

  if (!Number.isInteger(orgId) || !paymentRef || !Number.isFinite(dollars) || dollars <= 0) {
    monitor.warn('payments.webhook', 'donation session missing fields', { session: session?.id })
    return { recorded: false }
  }

  // Atomic dedup on (organization_id, payment_ref): the partial unique
  // index uq_donations_org_payment_ref (migration 050) makes a second,
  // concurrent webhook delivery for the same session conflict instead of
  // inserting a duplicate. rowCount tells us whether THIS call was the one
  // that inserted — so exactly one receipt goes out even under a race.
  const inserted = await pool.query(
    `INSERT INTO ochr_donations
       (organization_id, donor_name, donor_email, amount, category, method, date,
        source, fund_id, payment_ref, payment_status, notes)
     VALUES ($1, $2, $3, $4, $5, 'online', CURRENT_DATE, 'online', $6, $7, 'succeeded', $8)
     ON CONFLICT (organization_id, payment_ref) WHERE payment_ref IS NOT NULL
     DO NOTHING`,
    [
      orgId,
      md.donor_name || 'Online donor',
      md.donor_email || null,
      dollars,
      md.fund || null,
      Number.isInteger(fundId) ? fundId : null,
      paymentRef,
      md.message || null,
    ]
  )
  if (inserted.rowCount === 0) return { recorded: false, duplicate: true }

  // Receipt through the same notify() path the stub flow uses (GIV.5).
  if (md.donor_email) {
    try {
      const { rows } = await pool.query('SELECT name FROM ochr_organizations WHERE id = $1', [orgId])
      await notify({
        organizationId:    orgId,
        recipient:         md.donor_email,
        notification_type: 'donation_receipt',
        vars: {
          donor_name:  md.donor_name || 'Friend',
          church_name: rows[0]?.name ?? 'your church',
          amount:      `$${dollars.toFixed(2)}`,
          fund:        md.fund || 'General',
          date:        new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
          reference:   paymentRef,
        },
      })
    } catch (err) {
      monitor.error('payments.webhook.receipt', err, { orgId, paymentRef })
    }
  }

  return { recorded: true }
}
