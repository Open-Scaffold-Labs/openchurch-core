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

import { maskRef } from '../utils/redact.js'
import pool from '../db.js'
import { normalizeDonorEmail } from '../finance/donorIdentity.js'
import { monitor } from '../monitoring/index.js'
import { notify } from '../notifications/transport.js'
import { stripeRequest } from '../utils/stripeApi.js'

// Provider selection, checked at call time. Explicit PAYMENTS_PROVIDER wins;
// otherwise a giving secret flips giving to live. No secret, no env → stub.
//
// GIVING AND BILLING NO LONGER SHARE A SECRET. They used to: this read
// BILLING_PROVIDER_SECRET, which is the SaaS subscription concern — what the
// parish pays us. So configuring subscription billing, an unrelated decision
// made by a different person on a different day, silently flipped parishioner
// giving to live Stripe. And because chargeStripe() below has never been
// implemented, that would have failed every recurring gift in every
// organisation on the next daily cron: three attempts each, then paused, with
// nobody having touched giving at all.
//
// Two concerns, two variables. PAYMENTS_PROVIDER_SECRET is giving.
// BILLING_PROVIDER_SECRET stays what a parish is charged. Setting one no
// longer moves the other.
const stripeSecret = () => process.env.PAYMENTS_PROVIDER_SECRET
function currentProvider() {
  if (process.env.PAYMENTS_PROVIDER) return process.env.PAYMENTS_PROVIDER
  return stripeSecret() ? 'stripe' : 'stub'
}

// Can this provider charge a card we already hold — the thing a recurring
// gift needs on its second and every subsequent cycle?
//
// Stripe cannot, here, today: one-time gifts go through hosted Checkout,
// where the card is entered by the donor, and saved-card charging was never
// built (chargeStripe throws, see below). Treating that as a per-gift ERROR
// meant switching Stripe on would look exactly like every donor's card being
// declined at once — three failed attempts each, every gift paused, every
// donor emailed. It is not a failure. It is a capability this provider does
// not have yet, and the honest response is to decline to run at all and say
// so once.
export function canChargeSavedCards() {
  return currentProvider() === 'stub'
}

// "Which provider is running" and "has anybody chosen one" are different
// questions, and conflating them is what let the public giving route write
// donation rows for free. The stub is a legitimate thing to RUN — tests and
// demos need an end-to-end giving flow without a merchant account — but it is
// not a legitimate thing to DEFAULT into on a page a stranger can reach.
//
// So: an explicit PAYMENTS_PROVIDER (including 'stub') is a choice somebody
// made. Nothing set at all, with no Stripe secret either, is the absence of a
// choice — which is production's state today. The public route refuses in
// that case and only that case.
export function paymentsConfigured() {
  return Boolean(process.env.PAYMENTS_PROVIDER || stripeSecret())
}

// ── STUB IS NOT MONEY, AND A DEPLOYMENT MUST NOT BE ABLE TO SAY IT IS ────
//
// paymentsConfigured() above closes the ABSENCE of a choice. It does not
// close the wrong choice: set PAYMENTS_PROVIDER=stub on the deployed
// environment and everything downstream reads as a made decision. The
// public give page then takes a stranger's card details, chargeStub()
// returns a synthetic succeeded charge, a donation row is written with
// payment_status 'succeeded', and a receipt thanks them for money that
// never moved. That row reaches the dashboard, the finance summary, the
// diocesan assessable base and the donor's year-end tax statement. One
// environment variable is the whole distance between the demo flow and
// that, and today production sits one keystroke from it.
//
// WHAT DETERMINES THE ACTUAL TARGET.
//
// Not NODE_ENV: it is a label somebody sets, it is unset on Vercel by
// default, and this codebase already learned (local-db.mjs) that "we are in
// development" is a belief rather than a safety mechanism. Two directer
// signals, in order:
//
//   1. VERCEL_ENV — set by the platform, not by us, and it says exactly
//      which deployment this is. Preview deployments are not production,
//      and a stub there is legitimate.
//   2. Failing that, WHERE THE DONATION ROW WOULD LAND. If DATABASE_URL is
//      not loopback, the row is real to somebody: it is in a database other
//      people read, back up and bill from. A missing or unparseable
//      DATABASE_URL counts as not-local, because an unknown target is not a
//      safe one.
//
// Local and CI both keep working: no VERCEL_ENV, DATABASE_URL on
// localhost/127.0.0.1 → not production-like → the stub runs exactly as it
// does today. That is the demo and test path and it is not touched.
const LOOPBACK = /^(localhost|127\.0\.0\.1|::1|\[::1\])$/i

function databaseIsLoopback() {
  const raw = process.env.DATABASE_URL
  if (!raw) return false
  try {
    return LOOPBACK.test(new URL(raw).hostname)
  } catch {
    return false
  }
}

export function deploymentIsProductionLike() {
  if (process.env.VERCEL_ENV) return process.env.VERCEL_ENV === 'production'
  return !databaseIsLoopback()
}

// The guardrail predicate: a synthetic charge is about to be treated as a
// real one, somewhere real.
export function stubWouldFakeMoney() {
  return currentProvider() === 'stub' && deploymentIsProductionLike()
}

// SELECTED IS NOT CONFIGURED IS NOT CAPABLE.
//
// PAYMENTS_PROVIDER=stripe with no PAYMENTS_PROVIDER_SECRET reads as a
// chosen, configured Stripe today — and then every charge fails at the
// network boundary. Health said "stripe" and meant "somebody typed
// stripe". This is the question a deploy check actually wants answered:
// can this deployment move money right now, at all?
export function paymentsCanMoveMoney() {
  const provider = currentProvider()
  // The stub never moves money anywhere, including locally. That is the
  // point of it.
  if (provider === 'stub') return false
  // Stripe moves money through hosted Checkout, and the gift only reaches
  // this system through the webhook — which cannot verify anything without
  // its signing secret (billing/provider.js). Secret without webhook is a
  // deployment that can TAKE a gift and cannot RECORD one, which is the
  // worst of the four states health enumerates, not a capable one.
  if (provider === 'stripe') return Boolean(stripeSecret()) && paymentsWebhookReady()
  // An unknown provider name is a typo, not a capability.
  return false
}

// Can the webhook receiver record what the provider tells it? One shared
// endpoint serves billing and giving, and one signing secret verifies it.
// Read here rather than in app.js so health and the capability predicate
// above cannot disagree about which variable that is.
export function paymentsWebhookReady() {
  return Boolean(process.env.BILLING_WEBHOOK_SECRET)
}

// Could a REAL provider event still arrive at this deployment? Not "is
// giving switched on" — "is there a live credential anywhere in this
// environment", which is a strictly weaker and strictly safer question.
//
// currentProvider() lets an explicit PAYMENTS_PROVIDER win over the secret,
// which is right for outgoing behaviour: setting it to `stub` is how an
// operator switches giving OFF. It is wrong for INCOMING behaviour. Switching
// off does not cancel the Checkout sessions donors already opened, and Stripe
// delivers those for up to 24h. With PAYMENTS_PROVIDER=stub and the live
// secret still in the environment, a correctly-signed donation event was
// answered {received:true, stub:true} 200 and dropped — the same
// acknowledge-into-silence the billing/giving split was just fixed for,
// reached through a rollback instead of a rollout (reproduced 4 Sep, M6).
//
// So the webhook asks THIS question, and a rollback stops taking new gifts
// without discarding the ones already in flight.
export function paymentsLiveCredentialPresent() {
  return Boolean(stripeSecret())
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
// Test seam, matching _setDispatchForTests and _setAuditCountCapForTests.
//
// A declined card and an unsupported provider are different facts and now
// take different paths — one fails a single gift, the other declines the
// whole run. The recurring tests used to simulate a decline by naming a
// provider that does not exist, which was always a proxy for the wrong thing
// and is now caught by the capability gate. This lets a test say "the charge
// failed" without lying about which provider is running.
let _forcedChargeError = null
export function _setChargeFailureForTests(message) {
  const previous = _forcedChargeError
  _forcedChargeError = message
  return previous
}

async function chargeStub({ amount, currency, donorName, idempotencyKey }) {
  if (_forcedChargeError) throw new Error(_forcedChargeError)
  const ref = idempotencyKey
    ? `stub_${String(idempotencyKey).replace(/[^a-zA-Z0-9_-]/g, '')}`
    : randomRef('stub')
  console.log(`[pay:stub] charge ${ref} (donor and amount not logged)`)
  return { id: ref, status: 'succeeded', provider: 'stub' }
}

// Refund the other direction. The stub returns a synthetic refunded
// result; a real provider issues the refund against the original charge.
//
// The ref is DERIVED from idempotencyKey exactly as chargeStub does above,
// for the same reason: the refund route's provider call and its row UPDATE
// are two steps, and a retry after the second failed used to reach here
// again with nothing tying it to the first — two refund ids for one gift
// (4 Sep). With the key, the retry and the first call are the same refund.
async function refundStub({ chargeId, amount, idempotencyKey }) {
  const ref = idempotencyKey
    ? `stubref_${String(idempotencyKey).replace(/[^a-zA-Z0-9_-]/g, '')}`
    : randomRef('stubref')
  console.log(`[pay:stub] refund (charge and amount not logged) → ${ref}`)
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
//
// idempotencyKey goes out as Stripe's Idempotency-Key header. Without it,
// the failure mode was worse than the stub's: Stripe REJECTS a second full
// refund of one PaymentIntent, so a retry after our UPDATE failed got a
// provider error, answered 502, and left the row 'succeeded' for good while
// the donor already had the money back. With the key Stripe replays the
// first refund's response, the UPDATE runs, and the row catches up.
async function refundStripe({ chargeId, amount, idempotencyKey }) {
  const refund = await stripeRequest('refunds', {
    payment_intent: chargeId,
    ...(amount != null ? { amount: Math.round(amount * 100) } : {}),
  }, stripeSecret(), { idempotencyKey })
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

// createRefund({ organizationId, chargeId, amount?, idempotencyKey? }) → { id, status, provider }
// Reverses a prior charge. amount omitted = full refund. Dispatches to
// the configured provider's refund transport; the stub always succeeds.
//
// idempotencyKey is the caller's name for THIS refund. Option A (GIV-06)
// uses a per-refund key (`refund-<org>-<donation>-<refundId>`), not a
// gift-only key — two partials of one gift are two movements of money.
// Unlike createCharge's key, BOTH transports consume it today: the stub
// derives its ref from it, refundStripe forwards it as the Idempotency-Key
// header.
export async function createRefund({ organizationId, chargeId, amount, idempotencyKey }) {
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
      idempotencyKey,
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
//
// A DATABASE ROW IS NOT A SETTLED PAYMENT. checkout.session.completed
// means the donor finished Checkout, not that the money moved. For a card
// those are the same moment and payment_status is 'paid'. For a
// delayed-notification method — ACH debit, SEPA, OXXO, whichever the
// dashboard has enabled, since payment_method_types is not pinned at
// createDonationCheckout — the session completes 'unpaid', the donor sees
// the success page, and the bank answers days later through
// checkout.session.async_payment_succeeded or …async_payment_failed.
// This recorder wrote 'succeeded' and sent a thank-you on the 'unpaid'
// event (reproduced 8 Sep): a gift in the ledger, the finance summary, the
// assessable base and the donor's year-end statement for money that could
// still bounce.
//
// So payment_status decides. 'paid' and 'no_payment_required' (a fully
// discounted session) are recorded. 'unpaid' is acknowledged and NOT
// recorded — Stripe sends the follow-up, and the same session object
// arrives here again under the succeeded event with 'paid' on it, where
// the dedup on payment_ref still applies. Anything else is a value this
// code has never seen: not recorded, and not acknowledged either — a 2xx
// would end the delivery on a guess, so the error goes back, Stripe
// redelivers, and the operator sees it.
//
// Absent entirely: Stripe stamps payment_status on every Checkout Session,
// so an object without one is not a live delivery — it is one of the
// hand-built fixtures the earlier webhook tests use, which predate this
// check. Those keep recording; the field is decided on when it is there.
const SETTLED_PAYMENT_STATUSES = new Set(['paid', 'no_payment_required'])

export async function recordDonationCheckoutCompleted(session) {
  const md = session?.metadata ?? {}
  const orgId  = Number(md.organization_id)
  const fundId = Number(md.fund_id)
  const paymentRef = session?.payment_intent ?? session?.id
  const dollars = Math.round(Number(session?.amount_total)) / 100

  if (!Number.isInteger(orgId) || !paymentRef || !Number.isFinite(dollars) || dollars <= 0) {
    monitor.warn('payments.webhook', 'donation session missing fields', { session: maskRef(session?.id) })
    return { recorded: false }
  }

  const paymentStatus = session?.payment_status
  if (paymentStatus !== undefined && !SETTLED_PAYMENT_STATUSES.has(paymentStatus)) {
    if (paymentStatus === 'unpaid') {
      monitor.warn('payments.webhook', 'donation session completed unpaid (delayed payment method); not recorded until async_payment_succeeded',
        { session: maskRef(session?.id), paymentRef: maskRef(paymentRef), orgId })
      return { recorded: false, pending: true }
    }
    const err = new Error(`donation session ${maskRef(session?.id)} has unknown payment_status '${paymentStatus}'; not recorded`)
    monitor.error('payments.webhook.payment_status', err, { session: maskRef(session?.id), paymentRef: maskRef(paymentRef), orgId, paymentStatus })
    throw err
  }

  // The fund id was stamped at Checkout, and Checkout is not the webhook:
  // minutes pass between them, and a parish can delete a fund with no
  // gifts in those minutes (funds.js only refuses a fund WITH gifts — and
  // this gift is not recorded yet). The INSERT then hit FK 23503, every
  // redelivery hit it again, and after Stripe's three-day window the gift
  // — money the donor had already given — was simply gone (4 Sep).
  //
  // So the fund is resolved against THIS org first. Gone (or, for the same
  // price, somebody else's): the row is written undesignated, fund_id NULL,
  // with the name Checkout stamped kept in category and spelled out in
  // notes so the parish can see what the donor meant. That is funds.js's
  // own model of a deleted fund — the gifts "lose the designation, which a
  // restore puts back" — applied to a gift that arrived late. The operator
  // is told, because a restricted gift landing in the general fund is a
  // bookkeeping decision somebody has to make on purpose.
  let resolvedFundId = null
  let fundNote = null
  if (Number.isInteger(fundId)) {
    const { rowCount } = await pool.query(
      'SELECT 1 FROM ochr_funds WHERE id = $1 AND organization_id = $2', [fundId, orgId])
    if (rowCount) {
      resolvedFundId = fundId
    } else {
      const designation = md.fund ? `"${md.fund}"` : `fund #${fundId}`
      fundNote = `Given to ${designation} (fund #${fundId}), which no longer existed when the payment was confirmed. ` +
        'Recorded without a fund; restore the fund and re-designate this gift to put it back.'
      monitor.error('payments.webhook.fund_missing',
        new Error(`fund ${fundId} not found for org ${orgId}; gift ${paymentRef} recorded undesignated`),
        { orgId, fundId, paymentRef, fund: md.fund ?? null })
    }
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
      normalizeDonorEmail(md.donor_email),
      dollars,
      md.fund || null,
      resolvedFundId,
      paymentRef,
      [md.message || null, fundNote].filter(Boolean).join('\n') || null,
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
      monitor.error('payments.webhook.receipt', err, { orgId, paymentRef: maskRef(paymentRef) })
    }
  }

  return { recorded: true }
}
