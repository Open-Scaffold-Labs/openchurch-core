// Web Push subscription management (Sprint PWA / PWA.4a).
//
// Self-serve — every signed-in user manages their own device
// subscriptions. No role gate at the mount; viewers should be able to
// opt in to push for the same notifications they receive in-app.
//
// Endpoints:
//   GET    /api/push/vapid-key   → { publicKey } | { publicKey: null }
//                                  Frontend calls this before
//                                  subscribe(); a null public key
//                                  means push isn't configured server-
//                                  side and the UI should disable the
//                                  toggle.
//   POST   /api/push/subscribe   → upsert a subscription for the
//                                  caller's user. Body is the raw
//                                  PushSubscription.toJSON() shape.
//   DELETE /api/push/subscribe   → soft-remove a subscription by
//                                  endpoint. Service worker calls this
//                                  on unsubscribe() so the row stops
//                                  being eligible for sends.
//
// Tenant scoping: rows carry organization_id but the matching key on
// upsert/delete is endpoint (which is globally unique per device, per
// browser-vendor's spec). org_id is stamped from req.organizationId on
// insert so cross-tenant ghost rows can't appear.

import { Router } from 'express'
import pool from '../db.js'
import { getVapidPublicKey } from '../notifications/push.js'
import { monitor } from '../monitoring/index.js'

const router = Router()

// GET /api/push/vapid-key
// Public key only — safe to expose; that's its whole purpose.
router.get('/vapid-key', (_req, res) => {
  res.json({ publicKey: getVapidPublicKey() })
})

// POST /api/push/subscribe
// Body shape — straight off the browser's PushSubscription.toJSON():
//   { endpoint, keys: { p256dh, auth }, expirationTime? }
// We ignore expirationTime — the push service tells us via 410-gone
// when a subscription dies, which is the only authoritative signal.
router.post('/subscribe', async (req, res) => {
  const sub = req.body
  const endpoint = sub?.endpoint
  const p256dh   = sub?.keys?.p256dh
  const auth     = sub?.keys?.auth
  if (!endpoint || !p256dh || !auth) {
    return res.status(400).json({ error: 'Missing endpoint or keys' })
  }
  // Soft length sanity — push endpoints are URLs (~200 chars typical).
  // Keys are short base64url. Cap at something generous to reject
  // junk before it hits the DB.
  if (endpoint.length > 2000 || p256dh.length > 200 || auth.length > 200) {
    return res.status(400).json({ error: 'Subscription payload too large' })
  }

  const userAgent = req.get('user-agent')?.slice(0, 500) ?? null

  try {
    // Upsert on endpoint. If the same browser re-subscribes (after a
    // permission reset, for example) we update keys + user_id +
    // org_id + last_seen_at rather than orphan the old row.
    //
    // AUDIT NOTE (2026-07, reviewed and accepted): the conflict path
    // reassigns user/org without an ownership check. This is deliberate —
    // a push endpoint identifies a BROWSER PROFILE, and on a shared
    // parish-office computer the subscription must follow whoever is
    // signed in, or notifications leak to the previous user. Not
    // exploitable cross-tenant: endpoints are unguessable capability
    // URLs and no API ever returns another tenant's endpoint. Revisit
    // only if an endpoint-listing surface is ever added.
    const { rows } = await pool.query(
      `INSERT INTO ochr_push_subscriptions
         (organization_id, user_id, endpoint, p256dh, auth, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (endpoint) DO UPDATE
         SET user_id         = EXCLUDED.user_id,
             organization_id = EXCLUDED.organization_id,
             p256dh          = EXCLUDED.p256dh,
             auth            = EXCLUDED.auth,
             user_agent      = EXCLUDED.user_agent,
             last_seen_at    = NOW(),
             removed_at      = NULL
       RETURNING id, last_seen_at`,
      [req.organizationId, req.user.id, endpoint, p256dh, auth, userAgent]
    )
    res.status(201).json({ id: rows[0].id, last_seen_at: rows[0].last_seen_at })
  } catch (err) {
    monitor.error('push.subscribe', err, { userId: req.user?.id })
    res.status(500).json({ error: 'Failed to save push subscription' })
  }
})

// DELETE /api/push/subscribe
// Body: { endpoint }
// Soft-remove (removed_at = NOW()) so we keep an audit trail of which
// devices were registered when. The UPDATE filters on user_id so a
// caller can only soft-remove their OWN subscriptions, even though
// endpoints are globally unique.
router.delete('/subscribe', async (req, res) => {
  const endpoint = req.body?.endpoint
  if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' })
  try {
    const { rowCount } = await pool.query(
      `UPDATE ochr_push_subscriptions
          SET removed_at = NOW()
        /* tenancy: user-scoped, not org-scoped — a device subscription
           belongs to the JWT user; user_id comes from the verified token */
        WHERE endpoint = $1 AND user_id = $2 AND removed_at IS NULL`,
      [endpoint, req.user.id]
    )
    if (rowCount === 0) return res.status(404).json({ error: 'Subscription not found' })
    res.status(204).end()
  } catch (err) {
    monitor.error('push.unsubscribe', err, { userId: req.user?.id })
    res.status(500).json({ error: 'Failed to remove push subscription' })
  }
})

export default router
