// One-click unsubscribe — the endpoint behind the List-Unsubscribe
// header. Public by design: the whole point is that it works from a mail
// client with no session, no cookie, and no app login.
//
//   GET  /api/unsubscribe/:token  → a confirmation page. Changes nothing.
//   POST /api/unsubscribe/:token  → turns the notification type off.
//
// GET deliberately does NOT unsubscribe. Corporate mail scanners and
// link-preview bots fetch every URL in a message; if GET carried the
// side effect, those fetches would silently opt people out of mail they
// still wanted, and the symptom — "I stopped getting reminders and I
// never touched anything" — is close to undiagnosable. RFC 8058 exists
// for this reason: a compliant client POSTs with a List-Unsubscribe=One-Click
// body, and everyone else gets the confirmation page and presses a button.
//
// Both verbs answer the same way for a bad token: 400, no detail. There
// is nothing useful to tell a stranger holding a forged MAC.

import { Router } from 'express'
import pool from '../db.js'
import { verifyUnsubscribe } from '../notifications/unsubscribeToken.js'
import { TEMPLATES } from '../notifications/templates.js'
import { monitor } from '../monitoring/index.js'

const router = Router()

const CLIENT_URL = (process.env.CLIENT_URL || 'http://localhost:5202').replace(/\/$/, '')

const esc = (s) => String(s).replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
))

function page({ heading, body, action }) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${esc(heading)} — OpenChurch</title>
</head>
<body style="margin:0;padding:0;background:#FAF6EE;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#2A1F1A;">
  <div style="max-width:520px;margin:0 auto;padding:48px 16px;">
    <div style="background:#FFFDF7;border:1px solid rgba(123,45,38,0.12);border-radius:14px;padding:36px 32px;">
      <p style="margin:0 0 24px;font-family:Georgia,'Cormorant Garamond',serif;font-size:22px;font-weight:600;color:#7B2D26;letter-spacing:0.5px;">OpenChurch</p>
      <h1 style="margin:0 0 16px;font-family:Georgia,'Cormorant Garamond',serif;font-size:24px;font-weight:600;line-height:1.25;">${esc(heading)}</h1>
      <div style="font-size:15px;line-height:1.6;color:#3D2E26;">${body}</div>
      ${action || ''}
      <hr style="border:none;border-top:1px solid rgba(123,45,38,0.10);margin:32px 0 18px;" />
      <p style="margin:0;font-size:12px;line-height:1.5;color:#7A6A5F;">
        You can change any of your notification settings at
        <a href="${esc(CLIENT_URL)}/settings/notifications" style="color:#7B2D26;">${esc(CLIENT_URL)}/settings/notifications</a>.
      </p>
    </div>
  </div>
</body></html>`
}

// A valid MAC over a type that no longer has a template means the
// template was retired after the mail went out. Honour the intent —
// the row is just a (user, type) pair and costs nothing — but say so,
// because the person is looking at a name the app no longer shows.
function labelFor(type) {
  return TEMPLATES[type]?.label || type
}

function wantsHtml(req) {
  return String(req.headers.accept || '').includes('text/html')
}

// GET — confirmation only. No writes.
router.get('/:token', (req, res) => {
  const claim = verifyUnsubscribe(req.params.token)
  if (!claim) {
    return res.status(400).type('html').send(page({
      heading: 'That link isn’t valid',
      body: '<p style="margin:0;">This unsubscribe link is incomplete or has been altered in transit. Nothing has been changed.</p>',
    }))
  }
  const label = esc(labelFor(claim.notificationType))
  res.type('html').send(page({
    heading: 'Unsubscribe from these emails?',
    body: `<p style="margin:0;">You’re about to stop receiving <strong>${label}</strong> emails from OpenChurch.</p>
           <p style="margin:16px 0 0;">Nothing has changed yet.</p>`,
    action: `<form method="POST" action="/api/unsubscribe/${esc(req.params.token)}" style="margin:28px 0 0;">
        <button type="submit" style="display:inline-block;padding:12px 22px;background:#7B2D26;color:#FAF6EE;border:none;border-radius:8px;font-weight:600;font-size:14px;cursor:pointer;">
          Yes, unsubscribe me
        </button>
      </form>`,
  }))
})

// POST — the actual opt-out. Reached either by RFC 8058 one-click or by
// the button on the page above.
router.post('/:token', async (req, res) => {
  const claim = verifyUnsubscribe(req.params.token)
  if (!claim) {
    if (wantsHtml(req)) {
      return res.status(400).type('html').send(page({
        heading: 'That link isn’t valid',
        body: '<p style="margin:0;">This unsubscribe link is incomplete or has been altered in transit. Nothing has been changed.</p>',
      }))
    }
    return res.status(400).json({ error: 'Invalid unsubscribe token' })
  }

  try {
    // No organization_id here on purpose: a preference belongs to the
    // person, not to a tenant. The same human in two parishes who says
    // "stop" means stop.
    await pool.query(
      `INSERT INTO ochr_notification_prefs (user_id, notification_type, enabled)
       VALUES ($1, $2, FALSE)
       ON CONFLICT (user_id, notification_type)
       DO UPDATE SET enabled = FALSE, updated_at = NOW()`,
      [claim.userId, claim.notificationType]
    )
  } catch (err) {
    monitor.error('unsubscribe.write', err, { notification_type: claim.notificationType })
    if (wantsHtml(req)) {
      return res.status(500).type('html').send(page({
        heading: 'Something went wrong',
        body: '<p style="margin:0;">We couldn’t save that just now. Please try the link again in a moment.</p>',
      }))
    }
    return res.status(500).json({ error: 'Failed to unsubscribe' })
  }

  if (wantsHtml(req)) {
    const label = esc(labelFor(claim.notificationType))
    return res.type('html').send(page({
      heading: 'You’re unsubscribed',
      body: `<p style="margin:0;">You’ll no longer receive <strong>${label}</strong> emails.</p>
             <p style="margin:16px 0 0;">Other notifications are unaffected.</p>`,
    }))
  }
  res.json({ ok: true, notification_type: claim.notificationType })
})

export default router
