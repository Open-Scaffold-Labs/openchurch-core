import { maskEmail } from '../utils/redact.js'
// notify() — the single entrypoint every part of the app uses to
// dispatch a notification. The provider-specific transport lives at
// the bottom of this file. When the team lead picks Resend / Postmark
// / SES, the only file that changes is this one's stub block — the
// callers don't move.
//
// Lifecycle for one call to notify():
//   1. Look up the template by notification_type.
//   2. Check the user's pref (opt-out: missing row = enabled).
//      If disabled, write a 'skipped' log row and return.
//   3. Render template with vars (no body sent if pref is off).
//   4. Dispatch via the configured transport. The stub transport
//      writes a 'stubbed' log row and console.logs. A real transport
//      will: call the provider, then write 'sent' or 'failed'.
//   5. Return { id, status } — callers don't need it but it's handy
//      for tests.

import { sqlNormEmail, sqlEmailSha256 } from '../utils/emailNorm.js'
import pool from '../db.js'
import { sendEmail } from '../email/send.js'
import { suppressionFor } from '../email/suppression.js'
import { memberLanguage } from '../directory/memberIdentity.js'
import { apiBase } from '../utils/publicUrl.js'
import { getTemplate, render } from './templates.js'
import { sendPushToUser } from './push.js'
import { signUnsubscribe } from './unsubscribeToken.js'
import { monitor } from '../monitoring/index.js'

// Read a pref row. No row = enabled (opt-out semantics).
async function isEnabled(userId, notification_type) {
  if (!userId) return true // anonymous recipient = always send
  const { rows } = await pool.query(
    `SELECT enabled FROM ochr_notification_prefs
      WHERE user_id = $1 AND notification_type = $2
      LIMIT 1`,
    [userId, notification_type]
  )
  if (!rows.length) return true
  return rows[0].enabled !== false
}

async function writeLog({
  organizationId, userId, recipient, notification_type, channel,
  subject, body, status, error, providerMessageId,
}) {
  const { rows } = await pool.query(
    `INSERT INTO ochr_notification_log
       (organization_id, user_id, recipient_email, notification_type,
        channel, subject, body, status, error, provider_message_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, status`,
    [
      organizationId, userId ?? null, recipient ?? null, notification_type,
      channel, subject ?? null, body ?? null, status, error ?? null,
      providerMessageId ?? null,
    ]
  )
  return rows[0]
}

// R286-3: a recipient is refused when the trusted userId is a closed or
// deactivated login, or (same rule as the scheduler backstop) the address
// belongs to a closed/deactivated login in the SAME organization and no
// live login there holds it.
// When the send comes from a claimed queue row (scheduledId), that row must
// still be 'processing': closure/deactivation cancel claimed rows by id or
// pre-closure address, which covers an address-only row whose login's
// address was tombstoned by closure.
// PR6 (ARG-V2-1): an address-only send queued AFTER closure is refused by
// by_former_address: the address's hash is in ochr_closed_address_suppressions
// for this org and no live login there holds it. This is the only place
// that suppression is applied; the scheduler backstop is unchanged.
// PR6 F1 (Carolina #293): by_former_address protects a CLOSED STAFF LOGIN's
// former address. It must not refuse mail addressed to a member or donor
// record that happens to share that address (closure is "not member
// removal", loginClosure.js). The discriminator is the notification type's
// recipient kind: types in RECORD_ADDRESSED_TYPES are sent to an
// ochr_clients / donor address and are exempt from by_former_address; every
// other type (including an unknown one) is treated as login-addressed and
// stays suppressed (fail closed). by_id / by_address / row_withdrawn are
// unchanged for every type. tests/closedAddressAudienceF1 asserts every
// template type is classified exactly once.
export const RECORD_ADDRESSED_TYPES = new Set([
  'donation_receipt', 'recurring_gift_needs_attention', 'recurring_gift_stopped',
  'event_assignment_added', 'assignment_reminder', 'weekly_serving_digest',
  'swap_requested', 'swap_accepted', 'swap_declined', 'swap_cancelled', 'swap_pending_reminder',
])
export const LOGIN_ADDRESSED_TYPES = new Set([
  'member_birthday', 'member_anniversary', 'sacrament_anniversary_digest',
  'support_ticket_update', 'recurring_gift_paused', 'task_due_reminder',
])

// PR6 F4: each refusal rule has its own reason text (log error and queue
// cancellation error). by_id keeps the pre-existing text.
export const REFUSAL_REASONS = {
  by_id: 'recipient login closed or deactivated',
  by_address: 'recipient address belongs to a closed or deactivated login',
  by_former_address: 'recipient address is the former address of a closed login',
  row_withdrawn: 'queued notification withdrawn after claim',
}

// Returns the first matching refusal rule's reason text, or null.
export async function recipientRefusal({ organizationId, userId, recipient, scheduledId = null, notification_type = null }) {
  const formerApplies = !RECORD_ADDRESSED_TYPES.has(notification_type)
  const { rows } = await pool.query(
    `SELECT
       EXISTS (SELECT 1 FROM ochr_users u WHERE u.id = $2
                 AND (u.closed_at IS NOT NULL OR u.deactivated_at IS NOT NULL)) AS by_id,
       ($3::text IS NOT NULL
        AND EXISTS (SELECT 1 FROM ochr_users u WHERE u.organization_id = $1
                      AND ${sqlNormEmail('u.email')} = ${sqlNormEmail('$3::text')}
                      AND (u.closed_at IS NOT NULL OR u.deactivated_at IS NOT NULL))
        AND NOT EXISTS (SELECT 1 FROM ochr_users u WHERE u.organization_id = $1
                      AND ${sqlNormEmail('u.email')} = ${sqlNormEmail('$3::text')}
                      AND u.closed_at IS NULL AND u.deactivated_at IS NULL)) AS by_address,
       ($5::boolean AND $3::text IS NOT NULL
        AND EXISTS (SELECT 1 FROM ochr_closed_address_suppressions s WHERE s.organization_id = $1
                      AND s.email_sha256 = ${sqlEmailSha256('$3::text')})
        AND NOT EXISTS (SELECT 1 FROM ochr_users u WHERE u.organization_id = $1
                      AND ${sqlNormEmail('u.email')} = ${sqlNormEmail('$3::text')}
                      AND u.closed_at IS NULL AND u.deactivated_at IS NULL)) AS by_former_address,
       ($4::int IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ochr_scheduled_notifications q
                      WHERE q.id = $4 AND q.organization_id = $1 AND q.status = 'processing')) AS row_withdrawn`,
    [organizationId, userId ?? null, recipient ?? null, scheduledId, formerApplies])
  for (const k of ['by_id', 'by_address', 'by_former_address', 'row_withdrawn']) {
    if (rows[0][k]) return REFUSAL_REASONS[k]
  }
  return null
}

export async function recipientInactive(args) {
  return (await recipientRefusal(args)) != null
}

// One read for the final admission decision: HOLD first (it is reported
// as organization_held, preserving the queue row), then recipient/claim.
export async function admissionRefusal({ organizationId, userId, recipient, scheduledId = null, notification_type = null, withDetail = false }) {
  const { rows } = await pool.query(
    'SELECT 1 FROM ochr_organizations WHERE id = $1 AND held_at IS NULL', [organizationId])
  if (!rows.length) return withDetail ? { reason: 'organization_held' } : 'organization_held'
  const detail = await recipientRefusal({ organizationId, userId, recipient, scheduledId, notification_type })
  if (detail) return withDetail ? { reason: 'recipient_inactive', detail } : 'recipient_inactive'
  return null
}

// TARS 317-a / R319-1: a NEW unconfigured or provider-failed email log
// row is minimized. The outcome is failed or unconfirmed (a provider error
// does not prove the message was never delivered), and the row is an
// accounting record, not a copy of the message. It keeps tenant, user,
// type, channel and status, stores the recipient only as maskEmail()
// output (never the raw address, and not a hash, which an unsalted address
// could be matched against), and stores no subject or body. Its error is a
// CLOSED diagnostic (failureDiagnostic below), never provider text, so no
// truncated, scrubbed or overlapping echo of the message can survive in it.
// Status, reason, queue outcome and counters are untouched; for a provider
// failure the returned detail is the same closed diagnostic (TARS 319
// residuals). Rows written before these changes are not rewritten here.
function minimizedFailureLog({ recipient, error }) {
  return {
    recipient: recipient ? maskEmail(recipient) : null,
    subject: null, body: null, error,
  }
}

// R319-1: the persisted provider-failure diagnostic is built only from
// allowlisted parts: the outcome code, the provider name and HTTP status
// when the error message STARTS with sendEmail()'s own fixed prefix and the
// status is a three-digit 1xx-5xx code, otherwise an error code from a
// fixed set, otherwise 'unclassified'. Nothing else from the error is read.
const PROVIDER_STATUS_RE = /^Resend send failed \(([1-5][0-9]{2})\):/
const DIAGNOSTIC_CODES = new Set([
  'EMAIL_TRANSPORT_UNCONFIGURED', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT',
  'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ABORT_ERR',
])
export function failureDiagnostic(err) {
  const msg = typeof err?.message === 'string' ? err.message : ''
  const m = PROVIDER_STATUS_RE.exec(msg)
  if (m) return `provider_failed: provider=resend status=${m[1]}`
  const code = typeof err?.code === 'string' && DIAGNOSTIC_CODES.has(err.code) ? err.code
    : typeof err?.cause?.code === 'string' && DIAGNOSTIC_CODES.has(err.cause.code) ? err.cause.code
      : null
  return code ? `provider_failed: code=${code}` : 'provider_failed: unclassified'
}

export const PUSH_SETTLE_MS = 15_000
export const UNCONFIGURED_ERROR = 'unconfigured: email provider not configured (RESEND_API_KEY unset in production)'

// The stub transport — current default. Logs to console + writes a
// 'stubbed' log row so admins can see exactly what would have gone
// out. When a real provider is configured, this whole function gets
// replaced (or extended) and the calling code is unchanged.
async function dispatchStub({ organizationId, userId, recipient, notification_type, channel, subject, body }) {
  console.log(`[notify:stub] → ${recipient ? maskEmail(recipient) : '(no recipient)'} | ${notification_type}`)
  return writeLog({
    organizationId, userId, recipient, notification_type, channel,
    subject, body, status: 'stubbed',
  })
}

// The live dispatch — used when RESEND_API_KEY is configured (checked
// at call time, same as email/send.js). Sends through the vendor-
// neutral sendEmail() and writes a 'sent' or 'failed' log row, so the
// admin-visible notification log is the delivery ledger either way.
// A row with no recipient email has nowhere to go — it's logged as
// 'stubbed' exactly as before (push may still reach the user below).
async function dispatch({ organizationId, userId, recipient, notification_type, channel, subject, body, headers, scheduledId = null }) {
  const { rows: activeOrg } = await pool.query(
    'SELECT id FROM ochr_organizations WHERE id = $1 AND held_at IS NULL', [organizationId],
  )
  if (!activeOrg.length) return { status: 'skipped', reason: 'organization_held' }
  // R286-3: authoritative recipient admission, re-read here at the last
  // step before any transport (stub or provider), after every awaited
  // lookup above. A closure/deactivation that commits after a queue claim
  // is seen here. A provider request already sent cannot be recalled; this
  // only guarantees none STARTS after the state change is visible.
  const early = await recipientRefusal({ organizationId, userId, recipient, scheduledId, notification_type })
  if (early) {
    const row = await writeLog({
      organizationId, userId, recipient, notification_type, channel,
      subject: null, body: null, status: 'skipped', error: early,
    })
    return { ...row, status: 'skipped', reason: 'recipient_inactive', detail: early }
  }
  // P-1 (TARS bridge #62): in production a missing provider key is not a
  // stub, it is an undeliverable message. Refuse visibly at admission: a
  // 'failed' log row with an 'unconfigured:' reason, a monitor error, and
  // reason 'unconfigured' so the scheduler never settles the row as sent.
  // Dev/test keep the stub. The log row is minimized (TARS 317-a): the
  // address is stored masked, subject and body are not stored, and the
  // monitor event carries only the masked address. Rows written before
  // that change still hold the raw recipient, subject and body.
  if (recipient && !process.env.RESEND_API_KEY && process.env.NODE_ENV === 'production') {
    monitor.error('notify.unconfigured', new Error(UNCONFIGURED_ERROR), { notification_type, recipient: maskEmail(recipient) })
    const row = await writeLog({
      organizationId, userId, notification_type, channel, status: 'failed',
      ...minimizedFailureLog({ recipient, error: UNCONFIGURED_ERROR }),
    })
    return { ...row, status: 'failed', reason: 'unconfigured', detail: UNCONFIGURED_ERROR }
  }
  // R299-1: in production a no-email notification is a push-only intent.
  // No stub row stands in for it; notify() awaits a bounded push outcome
  // and records that on a push-channel log row instead.
  if (!recipient && process.env.NODE_ENV === 'production') return { status: 'push_only' }
  if (!process.env.RESEND_API_KEY || !recipient) {
    return dispatchStub({ organizationId, userId, recipient, notification_type, channel, subject, body })
  }

  // Address health, checked before every live send. A hard-bounced or
  // complaining address is not retried — the provider would accept the
  // message, charge it against the sending domain all the parishes share,
  // and deliver it nowhere. The row still gets written so the admin log
  // shows what was withheld and why; silence here would look identical to
  // a send that worked.
  const blocked = await suppressionFor(recipient)
  if (blocked) {
    const detail = `address suppressed (${blocked.reason})`
    const row = await writeLog({
      organizationId, userId, recipient, notification_type, channel,
      subject, body, status: 'suppressed', error: detail,
    })
    // R299-2: an intentional no-send, not a delivery and not a failure.
    return { ...row, status: 'suppressed', reason: 'suppressed', detail }
  }

  // R286-3 (fda17292 follow-up): the suppression lookup above is awaited,
  // so a closure, deactivation or HOLD can commit during it. Re-read HOLD,
  // recipient and claimed-row admission as the LAST awaited step; the
  // provider call below follows with no await in between. Plain reads, no
  // locks taken, so no lock-ordering change. A request already handed to
  // the provider cannot be recalled.
  const late = await admissionRefusal({ organizationId, userId, recipient, scheduledId, notification_type, withDetail: true })
  if (late?.reason === 'organization_held') return { status: 'skipped', reason: 'organization_held' }
  if (late?.reason === 'recipient_inactive') {
    const row = await writeLog({
      organizationId, userId, recipient, notification_type, channel,
      subject: null, body: null, status: 'skipped', error: late.detail,
    })
    return { ...row, status: 'skipped', reason: 'recipient_inactive', detail: late.detail }
  }
  try {
    const sent = await sendEmail({ to: recipient, subject, text: body, headers })
    return writeLog({
      organizationId, userId, recipient, notification_type, channel,
      subject, body, status: 'sent',
      // The provider's id is the only handle a later bounce webhook has
      // to find this row. Without it the log keeps saying 'sent' forever.
      providerMessageId: sent?.id ?? null,
    })
  } catch (err) {
    // S-F1 / TARS 319 residuals: a provider error can echo the address and
    // the message (truncated, scrubbed or not). The closed diagnostic is the
    // only provider-failure text that leaves this function: it is the log
    // error, the monitor event message (and so any forwarded Sentry event),
    // and the returned detail, which the scheduler persists as the queue
    // row's error. The provider's own text is not read beyond its fixed
    // prefix and status (failureDiagnostic).
    const diagnostic = failureDiagnostic(err)
    monitor.error('notify.dispatch', new Error(diagnostic), { notification_type, recipient: maskEmail(recipient) })
    // TARS 317-a / R319-1: the failed row is minimized like the unconfigured
    // one, and its error is the closed diagnostic, not the provider text.
    const row = await writeLog({
      organizationId, userId, notification_type, channel, status: 'failed',
      ...minimizedFailureLog({ recipient, error: diagnostic }),
    })
    // P-1: a provider failure must never be settled as sent upstream. The
    // status and reason are unchanged; only the detail text is closed.
    return { ...row, status: 'failed', reason: 'provider_failed', detail: diagnostic }
  }
}

// List-Unsubscribe headers (RFC 2369 + RFC 8058).
//
// The in-app per-template toggle is the substantive opt-out and it works;
// these headers are what make it reachable from the place people actually
// decide to stop — the message itself. Gmail and Outlook surface a native
// "Unsubscribe" control when they see them, and its absence on recurring
// mail is read as a sender-quality signal against the whole domain. Every
// parish shares one sending domain, so that cost is not paid by whoever
// caused it.
//
// Returns undefined when there is no userId. An anonymous recipient has
// no prefs row to write, so an unsubscribe link would render a page that
// promises something it cannot do. No header is more honest than a broken
// one — and those sends are one-off transactional mail, not the recurring
// kind these headers exist for.
//
// BASE_URL and not CLIENT_URL: this is a server route. Pointing it at the
// front end would produce a link that 404s, which is the specific failure
// this whole change exists to prevent.
//
// apiBase() returns null when it cannot produce an absolute origin, and
// for a header the right answer to that is to send nothing. `</api/…>`
// unsubscribes nobody while still telling Gmail this sender offers
// one-click, which is worse than no header at all.
function unsubscribeHeaders(userId, notification_type) {
  if (!userId) return undefined
  const base = apiBase()
  if (!base) {
    monitor.warn('notify.unsubscribe_base',
      'BASE_URL is not an absolute http(s) URL; List-Unsubscribe headers are being omitted.')
    return undefined
  }
  const url = `${base}/api/unsubscribe/${signUnsubscribe(userId, notification_type)}`
  return {
    'List-Unsubscribe': `<${url}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  }
}

// Public API. All dispatch-side complexity is private to this module.
//
// Required:
//   organizationId  — tenant scope. Stamped on every log row.
//   notification_type — string id matching a TEMPLATES key.
//
// Recommended:
//   userId    — the recipient's ochr_users.id, used for prefs lookup.
//   recipient — destination identifier (email address for now).
//   vars      — object substituted into the template's {{vars}}.
//
// Optional:
//   channel   — defaults to 'email'. Future-proofing for SMS/push.
//   push      — { url?, tag? } overrides for the companion Web Push.
//               url defaults to the SW's '/' fallback; tag defaults to
//               `${notification_type}:${userId}` so re-sent reminders
//               collapse on the device instead of stacking.
// Which language this person reads. Resolved in one place so every caller
// gets it without having to remember, and so a new notification type cannot
// quietly ship English-only to a Spanish-speaking parish.
//
// Order: an explicit `lang` from the caller (rare — the caller usually knows
// less than the database does), then the member record matched by email, then
// English. A lookup failure resolves to English rather than throwing: a
// notification must not fail because we could not determine a preference.
export async function languageFor({ organizationId, recipient, lang = null }) {
  if (lang) return lang
  if (!recipient) return 'en'
  try {
    return (await memberLanguage(organizationId, recipient)) === 'es' ? 'es' : 'en'
  } catch (err) {
    // English, still — a notification must not fail because we could not
    // determine a preference. But the bare `catch { return 'en' }` this
    // replaces made two very different situations produce the same answer:
    //
    //   the member has stated no preference    → English, correct
    //   the lookup itself failed               → English, and nobody knows
    //
    // A Spanish-speaking parishioner receiving English looks identical to a
    // Spanish-speaking parishioner who never asked for Spanish. NOT MEASURED
    // is not NONE. The fallback stays; the silence does not.
    monitor.error('notify.language_lookup', err, { organizationId })
    return 'en'
  }
}

export async function notify({
  organizationId,
  userId      = null,
  recipient   = null,
  notification_type,
  vars        = {},
  channel     = 'email',
  lang        = null,
  push        = {},
  scheduledId = null, // internal: the claimed queue row this send is for
}) {
  if (!organizationId) throw new Error('organizationId is required')
  if (!notification_type) throw new Error('notification_type is required')

  // Recheck the known tenant at dispatch time: queued or in-flight work
  // admitted before HOLD must not reach email or push providers.
  const { rows: activeOrg } = await pool.query(
    'SELECT id FROM ochr_organizations WHERE id = $1 AND held_at IS NULL',
    [organizationId],
  )
  if (!activeOrg.length) return { status: 'skipped', reason: 'organization_held' }

  const template = getTemplate(notification_type) // throws on unknown type

  // Respect the user's preference. Disabled = log a 'skipped' row
  // (so admins still see what would have been sent) and return.
  // The pref toggle short-circuits BOTH email and push — it's a
  // per-template opt-out, not a per-channel one.
  if (!(await isEnabled(userId, notification_type))) {
    const row = await writeLog({
      organizationId, userId, recipient, notification_type, channel,
      subject: null, body: null, status: 'skipped',
    })
    // R299-2: an intentional no-send; the scheduler must not settle it sent.
    return { ...row, status: 'skipped', reason: 'opted_out', detail: 'recipient opted out of this notification type' }
  }

  const language = await languageFor({ organizationId, recipient, lang })
  const { subject, body_text } = render(template, vars, language)

  const result = await dispatch({
    organizationId, userId, recipient, notification_type, channel,
    subject, body: body_text,
    headers: unsubscribeHeaders(userId, notification_type),
    scheduledId,
  })

  // R299-1: push-only intent (production, no email address). Await the
  // push outcome, bounded, and record it on a 'push' channel log row. Only
  // an observed provider acceptance (sent > 0) is a send; no user, no
  // VAPID, no subscriptions, all endpoints failed, or no answer within the
  // bound is not. This reports acceptance by the push service, not device
  // receipt. sendPushToUser re-reads HOLD/closure at its own boundary.
  if (result?.status === 'push_only') {
    const pushBody = (body_text ?? '').split('\n')[0].trim().slice(0, 140)
    let timer
    const outcome = await Promise.race([
      sendPushToUser(userId, {
        title: subject, body: pushBody, url: push.url,
        tag: push.tag ?? `${notification_type}:${userId}`,
      }).catch((err) => {
        monitor.error('push.dispatch', err, { userId, notification_type })
        return { status: 'error', sent: 0 }
      }),
      new Promise(r => { timer = setTimeout(() => r({ status: 'no_answer_within_bound', sent: 0 }), PUSH_SETTLE_MS) }),
    ]).finally(() => clearTimeout(timer))
    const accepted = Number(outcome?.sent) > 0
    const detail = accepted ? null : `push_not_accepted: ${outcome?.status ?? 'unknown'}`
    // TARS 319 residuals: a push that was not accepted is a failed or
    // unconfirmed outcome, so its row is an accounting record like a failed
    // email row: no subject or body. An accepted push keeps them, as sent
    // rows do. The detail is built from push.js's own fixed status codes.
    const row = await writeLog({
      organizationId, userId, recipient: null, notification_type, channel: 'push',
      subject: accepted ? subject : null, body: accepted ? body_text : null,
      status: accepted ? 'sent' : 'failed', error: detail,
    })
    return accepted
      ? { ...row, status: 'sent', channel: 'push' }
      : { ...row, status: 'failed', channel: 'push', reason: 'push_not_accepted', detail }
  }

  // Companion Web Push. The email log row above is the canonical
  // record; push is best-effort and is NEVER awaited at the request
  // hot path. Anything that escapes sendPushToUser's internal handling
  // flows to the monitor so an admin can see it without it surfacing
  // to the caller.
  // R299-3: a suppressed address blocks the companion push too, the same
  // way opt-out blocks both channels. Email failures still allow it.
  if (userId && result?.reason !== 'organization_held' && result?.reason !== 'recipient_inactive'
      && result?.reason !== 'suppressed') {
    const pushBody = (body_text ?? '').split('\n')[0].trim().slice(0, 140)
    const pushTag  = push.tag ?? `${notification_type}:${userId}`
    sendPushToUser(userId, {
      title: subject,
      body:  pushBody,
      url:   push.url,
      tag:   pushTag,
    }).catch((err) => monitor.error('push.dispatch', err, { userId, notification_type }))
  }

  return result
}
