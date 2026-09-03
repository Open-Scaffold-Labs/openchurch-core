// Delivery events from the email provider.
//
// Public and unauthenticated in the session sense — the provider has no
// account here. What authorises a request is the signature over its raw
// bytes, verified in the adapter. This endpoint can suppress any address
// it names, so an unsigned request must never reach the write path: a
// stranger who could POST here could stop a parish's mail entirely.
//
// Mounted BEFORE express.json() in app.js, alongside the billing webhook
// and for the same reason — the signature covers the exact bytes, and
// parsing then re-serialising changes them.
//
// Status codes are deliberate:
//   400 — bad signature, stale timestamp, malformed body. The provider
//         should NOT treat these as delivered; something is wrong.
//   503 — no signing secret configured. Distinct from 400 so that a
//         half-finished deploy is legible as a deploy problem rather than
//         looking like the provider is sending garbage.
//   200 — verified. Including events we ignore, and including failures
//         AFTER verification, because a 5xx makes the provider retry the
//         same event for hours and the retry will fail identically.

import { Router } from 'express'
import express from 'express'
import { verifySignature, interpret, WebhookError } from '../email/providers/resendWebhook.js'
import { suppress, markDelivery } from '../email/suppression.js'
import { monitor } from '../monitoring/index.js'

const router = Router()

router.post(
  '/webhook',
  express.raw({ type: '*/*', limit: '1mb' }),
  async (req, res) => {
    let event
    try {
      event = verifySignature({ rawBody: req.body, headers: req.headers })
    } catch (err) {
      const status = err instanceof WebhookError ? err.statusCode : 400
      // Deliberately not logged at error level for a plain signature
      // mismatch: an open endpoint on the public internet gets probed,
      // and a log that screams at every probe is a log nobody reads.
      monitor.warn('email.webhook.rejected', err.message, { status })
      return res.status(status).json({ received: false, error: err.message })
    }

    try {
      const e = interpret(event)

      switch (e.kind) {
        case 'hard_bounce':
          await suppress({
            email: e.email, reason: 'bounce', provider: 'resend',
            providerEventId: e.providerEventId, detail: e.detail,
          })
          await markDelivery({ providerMessageId: e.providerMessageId, status: 'bounced', detail: e.detail })
          monitor.warn('email.suppressed', 'hard bounce', { reason: 'bounce' })
          break

        case 'complaint':
          await suppress({
            email: e.email, reason: 'complaint', provider: 'resend',
            providerEventId: e.providerEventId, detail: e.detail,
          })
          await markDelivery({ providerMessageId: e.providerMessageId, status: 'complained', detail: e.detail })
          monitor.warn('email.suppressed', 'spam complaint', { reason: 'complaint' })
          break

        case 'soft_bounce':
          // Recorded, not suppressed. A full mailbox recovers, and
          // suppressing it would silently delete a real recipient.
          await markDelivery({ providerMessageId: e.providerMessageId, status: 'bounced', detail: e.detail })
          break

        case 'delivered':
          await markDelivery({ providerMessageId: e.providerMessageId, status: 'delivered' })
          break

        default:
          break // opens, clicks, sends — nothing to record
      }

      res.json({ received: true, kind: e.kind })
    } catch (err) {
      // Verified but unprocessable. 200 so the provider stops retrying an
      // event that will fail the same way every time; the monitor is where
      // this gets noticed.
      monitor.error('email.webhook.process', err)
      res.json({ received: true, processed: false })
    }
  }
)

export default router
