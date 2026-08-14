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

import pool from '../db.js'
import { sendEmail } from '../email/send.js'
import { getTemplate, render } from './templates.js'
import { sendPushToUser } from './push.js'
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
  subject, body, status, error,
}) {
  const { rows } = await pool.query(
    `INSERT INTO ochr_notification_log
       (organization_id, user_id, recipient_email, notification_type,
        channel, subject, body, status, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, status`,
    [
      organizationId, userId ?? null, recipient ?? null, notification_type,
      channel, subject ?? null, body ?? null, status, error ?? null,
    ]
  )
  return rows[0]
}

// The stub transport — current default. Logs to console + writes a
// 'stubbed' log row so admins can see exactly what would have gone
// out. When a real provider is configured, this whole function gets
// replaced (or extended) and the calling code is unchanged.
async function dispatchStub({ organizationId, userId, recipient, notification_type, channel, subject, body }) {
  console.log(`[notify:stub] → ${recipient ?? '(no recipient)'} | ${notification_type} | ${subject}`)
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
async function dispatch({ organizationId, userId, recipient, notification_type, channel, subject, body }) {
  if (!process.env.RESEND_API_KEY || !recipient) {
    return dispatchStub({ organizationId, userId, recipient, notification_type, channel, subject, body })
  }
  try {
    await sendEmail({ to: recipient, subject, text: body })
    return writeLog({
      organizationId, userId, recipient, notification_type, channel,
      subject, body, status: 'sent',
    })
  } catch (err) {
    monitor.error('notify.dispatch', err, { notification_type, recipient })
    return writeLog({
      organizationId, userId, recipient, notification_type, channel,
      subject, body, status: 'failed', error: String(err?.message ?? err).slice(0, 500),
    })
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
export async function notify({
  organizationId,
  userId      = null,
  recipient   = null,
  notification_type,
  vars        = {},
  channel     = 'email',
  push        = {},
}) {
  if (!organizationId) throw new Error('organizationId is required')
  if (!notification_type) throw new Error('notification_type is required')

  const template = getTemplate(notification_type) // throws on unknown type

  // Respect the user's preference. Disabled = log a 'skipped' row
  // (so admins still see what would have been sent) and return.
  // The pref toggle short-circuits BOTH email and push — it's a
  // per-template opt-out, not a per-channel one.
  if (!(await isEnabled(userId, notification_type))) {
    return writeLog({
      organizationId, userId, recipient, notification_type, channel,
      subject: null, body: null, status: 'skipped',
    })
  }

  const { subject, body_text } = render(template, vars)

  const result = await dispatch({
    organizationId, userId, recipient, notification_type, channel,
    subject, body: body_text,
  })

  // Companion Web Push. The email log row above is the canonical
  // record; push is best-effort and is NEVER awaited at the request
  // hot path. Anything that escapes sendPushToUser's internal handling
  // flows to the monitor so an admin can see it without it surfacing
  // to the caller.
  if (userId) {
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
