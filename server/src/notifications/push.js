// Web Push send helper (Sprint PWA / PWA.4a).
//
// Vendor-neutral by construction: VAPID-signed Web Push hits the
// browser-vendor's public push service directly (FCM, Mozilla autopush,
// Apple's APNS bridge). No third-party SaaS sits in the middle, so this
// works without waiting on the team-lead email-provider / monitoring-
// tool picks.
//
// Configuration is two env vars:
//   VAPID_PUBLIC_KEY   — exposed to the client via GET /api/push/vapid-key
//   VAPID_PRIVATE_KEY  — server only, signs every dispatch
//   VAPID_CONTACT      — optional mailto: per RFC8292; defaults to a
//                        generic ops mailbox. Browsers don't enforce
//                        this but spec-conformant push services may
//                        reject empty contact strings.
//
// If keys aren't set (dev without VAPID, CI smoke runs, fresh
// deployment), getVapidPublicKey() returns null and sendPushToUser()
// no-ops with status: 'no_vapid_configured'. That lets the rest of
// the feature ship — UI shows "push not configured yet" instead of
// blowing up.
//
// Sends are NEVER awaited at the request hot path. Callers fire-and-
// forget; failures here only matter to the log table.

import webpush from 'web-push'
import pool from '../db.js'
import { monitor } from '../monitoring/index.js'

let vapidConfigured = false

function configureIfNeeded() {
  if (vapidConfigured) return true
  const pub = process.env.VAPID_PUBLIC_KEY
  const priv = process.env.VAPID_PRIVATE_KEY
  if (!pub || !priv) return false
  const contact = process.env.VAPID_CONTACT || 'mailto:ops@openchurch.app'
  try {
    webpush.setVapidDetails(contact, pub, priv)
    vapidConfigured = true
    return true
  } catch (err) {
    monitor.error('push.configure', err)
    return false
  }
}

export function getVapidPublicKey() {
  // Returns the public key for client-side subscribe() — null when
  // VAPID isn't configured so the client can disable the toggle and
  // surface a clean "push is not set up on this server" state.
  return process.env.VAPID_PUBLIC_KEY || null
}

export function isPushConfigured() {
  return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY)
}

// Send one payload to every active subscription belonging to userId.
// payload: { title, body, url, tag? }
//   title — bold line (~50 chars). e.g. "Choir rehearsal in 30m"
//   body  — supporting line. e.g. "Saint Mary's, 6:00 PM"
//   url   — deep link. Service worker handles the click + focus.
//   tag   — optional dedupe key so a re-sent reminder collapses.
export async function sendPushToUser(userId, payload) {
  if (!userId) return { status: 'no_user' }
  if (!configureIfNeeded()) {
    // Configuration is missing — record the intent so an admin can
    // tell "what would have gone out" once VAPID lands.
    monitor.info?.('push.send.skipped', { reason: 'no_vapid', userId })
    return { status: 'no_vapid_configured', sent: 0 }
  }

  const { rows: activeUser } = await pool.query(
    `SELECT u.id FROM ochr_users u JOIN ochr_organizations o ON o.id = u.organization_id
      WHERE u.id = $1 AND o.held_at IS NULL
        AND u.closed_at IS NULL AND u.deactivated_at IS NULL`, [userId],
  )
  // R286-3: also refuses a closed/deactivated login, re-read at send time.
  if (!activeUser.length) return { status: 'recipient_inactive_or_held', sent: 0 }

  const { rows: subs } = await pool.query(
    `SELECT id, endpoint, p256dh, auth
       FROM ochr_push_subscriptions
      WHERE user_id = $1 AND removed_at IS NULL`,
    [userId]
  )
  if (subs.length === 0) return { status: 'no_subscriptions', sent: 0 }

  // R286-3 (fda17292 follow-up): the subscription lookup is awaited, so a
  // closure, deactivation or HOLD can commit during it. Re-read admission
  // here; everything from this check to sendNotification is synchronous.
  const { rows: stillActive } = await pool.query(
    `SELECT u.id FROM ochr_users u JOIN ochr_organizations o ON o.id = u.organization_id
      WHERE u.id = $1 AND o.held_at IS NULL
        AND u.closed_at IS NULL AND u.deactivated_at IS NULL`, [userId],
  )
  if (!stillActive.length) return { status: 'recipient_inactive_or_held', sent: 0 }

  const json = JSON.stringify({
    title: payload?.title ?? 'OpenChurch',
    body:  payload?.body  ?? '',
    url:   payload?.url   ?? '/',
    tag:   payload?.tag   ?? undefined,
  })

  let sent = 0
  let dropped = 0

  // Parallel dispatch — each push is independent; one 410 doesn't
  // block the others. Errors are caught per-sub so a single dead
  // endpoint doesn't poison the batch.
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        json
      )
      sent += 1
      // Touch last_seen_at so a long-idle device doesn't look stale.
      await pool.query(
        `UPDATE ochr_push_subscriptions SET last_seen_at = NOW() WHERE id = $1`,
        [s.id]
      )
    } catch (err) {
      // 404 / 410 from the push service = subscription is gone for
      // good. Mark removed_at so we stop trying.
      if (err?.statusCode === 404 || err?.statusCode === 410) {
        dropped += 1
        await pool.query(
          `UPDATE ochr_push_subscriptions SET removed_at = NOW() WHERE id = $1`,
          [s.id]
        )
      } else {
        monitor.error('push.send', err, { subscriptionId: s.id, statusCode: err?.statusCode })
      }
    }
  }))

  return { status: 'ok', sent, dropped, total: subs.length }
}
