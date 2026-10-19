import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import crypto from 'crypto'
import pool from '../db.js'
import { monitor } from '../monitoring/index.js'
import { notify } from '../notifications/transport.js'

// VS.2 — token-based magic-link swap requests.
//
// Members don't have login accounts in v1, so each ochr_clients row
// carries a per-member swap_token (admins rotate it via the admin
// router below — same shape as the calendar_token already in use for
// the ICS subscription feed). Public endpoints under /by-token/:token
// resolve the caller from the token alone; no JWT, no role gate.
//
// Flow:
//   1. Admin rotates a swap_token for a member, copies the resulting
//      /p/swap/:token link, sends it to them (email, SMS, paper).
//   2. Member opens the link, sees upcoming assignments + a roster
//      picker, files a swap request → notify(target).
//   3. Target opens their own swap link, accepts → assigned_to is
//      rewritten atomically and the request becomes 'accepted'.
//      Declines / requester cancels are simple status flips.
//
// Design choices:
//   - Future events only. Backfilling a swap onto a past event isn't
//     meaningful and would surprise both parties.
//   - The accept handler revalidates inside a transaction — the
//     requester might have been moved off the event by an admin
//     between the request and the accept; we 409 cleanly instead of
//     silently rewriting state.
//   - Atomic swap: requester comes off assigned_to, target goes on,
//     in a single UPDATE. If the target was already on the roster
//     (e.g. as a co-server in a different role), we leave them there
//     and just remove the requester.

const TOKEN_RX = /^[A-Za-z0-9_-]{16,}$/

function generateToken() {
  // 24 random bytes → base64url = 32 url-safe chars. Plenty entropic;
  // matches the calendar_token shape so the admin UI can render both
  // with the same component if we later consolidate.
  return crypto.randomBytes(24).toString('base64url')
}

async function resolveToken(client, token) {
  if (!TOKEN_RX.test(token ?? '')) return null
  const { rows } = await client.query(
    `SELECT c.id, c.organization_id, c.name, c.email, c.reminders_opt_out,
            o.locale AS organization_locale
       FROM ochr_clients c
       JOIN ochr_organizations o ON o.id = c.organization_id
      WHERE c.swap_token = $1 AND o.held_at IS NULL`,
    [token]
  )
  return rows[0] ?? null
}

async function futureEvent(client, eventId, orgId) {
  const { rows } = await client.query(
    `SELECT id, organization_id, title, date, start_time, end_time, assigned_to
       FROM ochr_calendar_events
      WHERE id = $1 AND organization_id = $2
        AND date >= CURRENT_DATE`,
    [eventId, orgId]
  )
  return rows[0] ?? null
}

// ─── Public token-gated router ───────────────────────────────
export const swapPublicRouter = Router()

// GET /api/swap/by-token/:token
//   Returns: { me, upcoming_assignments, swap_requests, roster }.
//   Drives the public parishioner page in one round-trip.
// Swap links live in text messages and email, so they get forwarded. The
// token itself is strong — 24 random bytes, 192 bits, not guessable — but
// nothing bounded what a valid one could be used FOR. These two limiters and
// the typeahead below are the difference between "a link somebody can use"
// and "a link somebody can mine".
const swapLinkLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests from this device. Please wait a moment.' },
})

const swapSearchLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many lookups from this device. Please wait a moment.' },
})

// GET /api/swap/by-token/:token/members?q=<name>
// Typeahead for "who do you want to swap with". Two characters minimum, ten
// results, active members only, id and name only — the same shape the kiosk
// uses. A member types the name of the person they already have in mind;
// nobody needs to read the whole parish to arrange a swap.
swapPublicRouter.get('/by-token/:token/members', swapSearchLimiter, async (req, res) => {
  const c = await pool.connect()
  try {
    const me = await resolveToken(c, req.params.token)
    if (!me) return res.status(404).json({ error: 'Unknown link' })

    const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''
    if (q.length < 2) return res.json({ members: [] })

    // Escape LIKE metacharacters so somebody typing '%' cannot turn their
    // query into a wildcard that matches the directory after all.
    const escaped = q.replace(/\\/g, '\\\\').replace(/[%_]/g, ch => `\\${ch}`)
    const { rows } = await c.query(
      `SELECT id, name
         FROM ochr_clients
        WHERE organization_id = $1
          AND status = 'active'
          AND id <> $2
          AND name ILIKE $3
        ORDER BY name ASC
        LIMIT 10`,
      [me.organization_id, me.id, `%${escaped}%`]
    )
    res.json({ members: rows })
  } catch (err) {
    monitor.error('swap.byToken.members', err)
    res.status(500).json({ error: 'Failed to search members' })
  } finally {
    c.release()
  }
})

swapPublicRouter.get('/by-token/:token', swapLinkLimiter, async (req, res) => {
  const c = await pool.connect()
  try {
    const me = await resolveToken(c, req.params.token)
    if (!me) return res.status(404).json({ error: 'Unknown link' })

    const { rows: assignments } = await c.query(
      `SELECT id, title, date, start_time, end_time, type, assigned_to
         FROM ochr_calendar_events
        WHERE organization_id = $1
          AND date >= CURRENT_DATE
          AND assigned_to @> to_jsonb(ARRAY[$2::int])
        ORDER BY date ASC, start_time ASC
        LIMIT 50`,
      [me.organization_id, me.id]
    )

    const { rows: requests } = await c.query(
      `SELECT r.id, r.calendar_event_id, r.requester_client_id, r.target_client_id,
              r.note, r.status, r.created_at, r.decided_at,
              e.title       AS event_title,
              e.date        AS event_date,
              e.start_time  AS event_start_time,
              rc.name       AS requester_name,
              tc.name       AS target_name
         FROM ochr_swap_requests r
         JOIN ochr_calendar_events e ON e.id  = r.calendar_event_id
         JOIN ochr_clients rc        ON rc.id = r.requester_client_id
         JOIN ochr_clients tc        ON tc.id = r.target_client_id
        WHERE r.organization_id = $1
          AND (r.requester_client_id = $2 OR r.target_client_id = $2)
        ORDER BY r.created_at DESC
        LIMIT 50`,
      [me.organization_id, me.id]
    )

    // NO ROSTER. This used to return every active member — id, name and role
    // — with no LIMIT and no rate limit, to anyone holding one member's link.
    // Swap links are designed to be texted and forwarded, which is their
    // whole point, so one shared link handed over the parish directory
    // repeatedly and forever, until an admin thought to rotate that specific
    // member's token. Forty rapid requests returned forty complete copies.
    //
    // The kiosk router had already solved exactly this and said why: members
    // come from a query-gated typeahead so a token holder cannot slurp the
    // directory in one request. Two routers, same threat, opposite answers.
    // This one now matches the kiosk.
    //
    // `roster: []` stays in the shape so an older cached page degrades to an
    // empty picker rather than throwing on undefined.
    res.json({
      me: {
        id: me.id, name: me.name, organization_id: me.organization_id,
        reminders_opt_out: me.reminders_opt_out === true,
      },
      // The parish's language. A volunteer following a swap link is not
      // signed in, so nothing else on this page can tell the client which
      // language to speak.
      org: { locale: me.organization_locale ?? 'en' },
      upcoming_assignments: assignments,
      swap_requests:        requests,
      roster: [],
    })
  } catch (err) {
    monitor.error('swap.byToken.get', err)
    res.status(500).json({ error: 'Failed to load swap link' })
  } finally {
    c.release()
  }
})

// PATCH /api/swap/by-token/:token/reminders
//   Body: { opt_out: boolean }
//   Lets a member turn their serving reminders off/on from their own
//   token page — no login required (RM.2). The reminder sync skips any
//   member with reminders_opt_out set.
swapPublicRouter.patch('/by-token/:token/reminders', swapLinkLimiter, async (req, res) => {
  const optOut = req.body?.opt_out
  if (typeof optOut !== 'boolean') {
    return res.status(400).json({ error: 'opt_out must be a boolean' })
  }
  try {
    const me = await resolveToken(pool, req.params.token)
    if (!me) return res.status(404).json({ error: 'Unknown link' })
    await pool.query(
      `UPDATE ochr_clients SET reminders_opt_out = $1 WHERE id = $2 AND organization_id = $3`,
      [optOut, me.id, me.organization_id]
    )
    res.json({ reminders_opt_out: optOut })
  } catch (err) {
    monitor.error('swap.byToken.reminders', err)
    res.status(500).json({ error: 'Failed to update preference' })
  }
})

// POST /api/swap/by-token/:token/request
//   Body: { calendar_event_id, target_client_id, note? }
swapPublicRouter.post('/by-token/:token/request', swapLinkLimiter, async (req, res) => {
  const c = await pool.connect()
  try {
    const me = await resolveToken(c, req.params.token)
    if (!me) return res.status(404).json({ error: 'Unknown link' })

    const eventId  = Number(req.body?.calendar_event_id)
    const targetId = Number(req.body?.target_client_id)
    const note     = (req.body?.note ?? '').toString().slice(0, 500)
    if (!Number.isInteger(eventId) || eventId < 1)
      return res.status(400).json({ error: 'calendar_event_id is required' })
    if (!Number.isInteger(targetId) || targetId < 1 || targetId === me.id)
      return res.status(400).json({ error: 'target_client_id is required and must be a different member' })

    const ev = await futureEvent(c, eventId, me.organization_id)
    if (!ev) return res.status(404).json({ error: 'Event not found or already past' })
    const assigned = Array.isArray(ev.assigned_to) ? ev.assigned_to : []
    if (!assigned.includes(me.id))
      return res.status(400).json({ error: 'You are not currently assigned to that event' })
    if (assigned.includes(targetId))
      return res.status(400).json({ error: 'Target is already assigned to this event' })

    const { rows: trows } = await c.query(
      `SELECT id, name, email FROM ochr_clients
        WHERE id = $1 AND organization_id = $2 AND status = 'active'`,
      [targetId, me.organization_id]
    )
    if (trows.length === 0)
      return res.status(404).json({ error: 'Target member not found' })

    // Prevent dup pending requests for the same triple.
    const { rows: dupe } = await c.query(
      `SELECT id FROM ochr_swap_requests
        WHERE organization_id = $1 AND calendar_event_id = $2
          AND requester_client_id = $3 AND target_client_id = $4
          AND status = 'pending'`,
      [me.organization_id, eventId, me.id, targetId]
    )
    if (dupe.length)
      return res.status(409).json({ error: 'A pending request for this swap already exists' })

    // The SELECT above gives the friendly message; the partial unique
    // index uq_swap_requests_pending (055) closes the race two
    // concurrent submits can still win against it.
    const { rows: created, rowCount } = await c.query(
      `INSERT INTO ochr_swap_requests
         (organization_id, calendar_event_id, requester_client_id, target_client_id, note, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       ON CONFLICT (organization_id, calendar_event_id, requester_client_id, target_client_id)
       WHERE status = 'pending'
       DO NOTHING
       RETURNING id, status, created_at`,
      [me.organization_id, eventId, me.id, targetId, note || null]
    )
    if (rowCount === 0)
      return res.status(409).json({ error: 'A pending request for this swap already exists' })

    // Notify target — fire-and-forget; failures land in monitor.
    notify({
      organizationId:    me.organization_id,
      recipient:         trows[0].email ?? null,
      notification_type: 'swap_requested',
      vars: {
        requester_name: me.name,
        target_name:    trows[0].name,
        event_title:    ev.title,
        event_date:     ev.date,
        event_time:     ev.start_time,
        note:           note || '',
      },
    }).catch(err => monitor.error('notify.swap_requested', err))

    res.status(201).json({ id: created[0].id, status: created[0].status })
  } catch (err) {
    monitor.error('swap.byToken.request', err)
    res.status(500).json({ error: 'Failed to create swap request' })
  } finally {
    c.release()
  }
})

// POST /api/swap/by-token/:token/accept
//   Body: { request_id }. Token must be the TARGET's. Atomically
//   rewrites assigned_to and marks the request 'accepted'.
swapPublicRouter.post('/by-token/:token/accept', swapLinkLimiter, async (req, res) => {
  const c = await pool.connect()
  let inTransaction = false
  try {
    const me = await resolveToken(c, req.params.token)
    if (!me) return res.status(404).json({ error: 'Unknown link' })

    const requestId = Number(req.body?.request_id)
    if (!Number.isInteger(requestId) || requestId < 1)
      return res.status(400).json({ error: 'request_id is required' })

    await c.query('BEGIN'); inTransaction = true

    const { rows: rrows } = await c.query(
      `SELECT id, calendar_event_id, requester_client_id, target_client_id, status
         FROM ochr_swap_requests
        WHERE id = $1 AND organization_id = $2
        FOR UPDATE`,
      [requestId, me.organization_id]
    )
    if (rrows.length === 0) {
      await c.query('ROLLBACK'); inTransaction = false
      return res.status(404).json({ error: 'Swap request not found' })
    }
    const r = rrows[0]
    if (r.target_client_id !== me.id) {
      await c.query('ROLLBACK'); inTransaction = false
      return res.status(403).json({ error: 'This swap is not addressed to you' })
    }
    if (r.status !== 'pending') {
      await c.query('ROLLBACK'); inTransaction = false
      return res.status(409).json({ error: `Already ${r.status}` })
    }

    const { rows: erows } = await c.query(
      `SELECT id, assigned_to FROM ochr_calendar_events
        WHERE id = $1 AND organization_id = $2
        FOR UPDATE`,
      [r.calendar_event_id, me.organization_id]
    )
    if (erows.length === 0) {
      await c.query('ROLLBACK'); inTransaction = false
      return res.status(404).json({ error: 'Event no longer exists' })
    }
    const assigned = Array.isArray(erows[0].assigned_to) ? erows[0].assigned_to : []
    if (!assigned.includes(r.requester_client_id)) {
      await c.query('ROLLBACK'); inTransaction = false
      return res.status(409).json({ error: 'Requester is no longer assigned to this event' })
    }
    const next = assigned.filter(id => id !== r.requester_client_id)
    if (!next.includes(me.id)) next.push(me.id)

    await c.query(
      `UPDATE ochr_calendar_events SET assigned_to = $1
        WHERE id = $2 AND organization_id = $3`,
      [JSON.stringify(next), r.calendar_event_id, me.organization_id]
    )
    await c.query(
      `UPDATE ochr_swap_requests
          SET status = 'accepted', decided_at = NOW()
        WHERE id = $1
        -- tenancy: r.id came from a row fetched and org-scoped earlier in this same transaction.`,
      [r.id]
    )
    await c.query('COMMIT'); inTransaction = false

    const { rows: req2 } = await c.query(
      `SELECT email FROM ochr_clients WHERE id = $1
       -- tenancy: the client id comes from a swap row this handler already
       -- scoped to the caller's organization; used only to address a notification.`,
      [r.requester_client_id]
    )
    notify({
      organizationId:    me.organization_id,
      recipient:         req2[0]?.email ?? null,
      notification_type: 'swap_accepted',
      vars: { target_name: me.name },
    }).catch(err => monitor.error('notify.swap_accepted', err))

    res.json({ id: r.id, status: 'accepted' })
  } catch (err) {
    if (inTransaction) await c.query('ROLLBACK').catch(() => {})
    monitor.error('swap.byToken.accept', err)
    res.status(500).json({ error: 'Failed to accept swap' })
  } finally {
    c.release()
  }
})

// POST /api/swap/by-token/:token/decline
swapPublicRouter.post('/by-token/:token/decline', swapLinkLimiter, async (req, res) => {
  const c = await pool.connect()
  try {
    const me = await resolveToken(c, req.params.token)
    if (!me) return res.status(404).json({ error: 'Unknown link' })
    const requestId = Number(req.body?.request_id)
    if (!Number.isInteger(requestId) || requestId < 1)
      return res.status(400).json({ error: 'request_id is required' })

    const { rows: rrows } = await c.query(
      `UPDATE ochr_swap_requests
          SET status = 'declined', decided_at = NOW()
        WHERE id = $1 AND organization_id = $2
          AND target_client_id = $3 AND status = 'pending'
        RETURNING id, requester_client_id`,
      [requestId, me.organization_id, me.id]
    )
    if (rrows.length === 0)
      return res.status(404).json({ error: 'No pending request for you with that id' })

    const { rows: req2 } = await c.query(
      `SELECT email FROM ochr_clients WHERE id = $1
       -- tenancy: the client id comes from a swap row this handler already
       -- scoped to the caller's organization; used only to address a notification.`,
      [rrows[0].requester_client_id]
    )
    notify({
      organizationId:    me.organization_id,
      recipient:         req2[0]?.email ?? null,
      notification_type: 'swap_declined',
      vars: { target_name: me.name },
    }).catch(err => monitor.error('notify.swap_declined', err))

    res.json({ id: rrows[0].id, status: 'declined' })
  } catch (err) {
    monitor.error('swap.byToken.decline', err)
    res.status(500).json({ error: 'Failed to decline swap' })
  } finally {
    c.release()
  }
})

// POST /api/swap/by-token/:token/cancel
swapPublicRouter.post('/by-token/:token/cancel', swapLinkLimiter, async (req, res) => {
  const c = await pool.connect()
  try {
    const me = await resolveToken(c, req.params.token)
    if (!me) return res.status(404).json({ error: 'Unknown link' })
    const requestId = Number(req.body?.request_id)
    if (!Number.isInteger(requestId) || requestId < 1)
      return res.status(400).json({ error: 'request_id is required' })

    const { rows: rrows } = await c.query(
      `UPDATE ochr_swap_requests
          SET status = 'cancelled', decided_at = NOW()
        WHERE id = $1 AND organization_id = $2
          AND requester_client_id = $3 AND status = 'pending'
        RETURNING id, target_client_id`,
      [requestId, me.organization_id, me.id]
    )
    if (rrows.length === 0)
      return res.status(404).json({ error: 'No pending request from you with that id' })

    const { rows: tgt } = await c.query(
      `SELECT email FROM ochr_clients WHERE id = $1
       -- tenancy: the client id comes from a swap row this handler already
       -- scoped to the caller's organization; used only to address a notification.`,
      [rrows[0].target_client_id]
    )
    notify({
      organizationId:    me.organization_id,
      recipient:         tgt[0]?.email ?? null,
      notification_type: 'swap_cancelled',
      vars: { requester_name: me.name },
    }).catch(err => monitor.error('notify.swap_cancelled', err))

    res.json({ id: rrows[0].id, status: 'cancelled' })
  } catch (err) {
    monitor.error('swap.byToken.cancel', err)
    res.status(500).json({ error: 'Failed to cancel swap' })
  } finally {
    c.release()
  }
})

// ─── Admin router (mounted under requireAuth + writeGate) ────
export const swapAdminRouter = Router()

// POST /api/swap-admin/clients/:id/rotate-token
//   Generates a new swap_token for a client (or replaces an existing
//   one). Returns the new token so the admin UI can build the magic
//   link to copy / SMS / email.
swapAdminRouter.post('/clients/:id/rotate-token', async (req, res) => {
  const clientId = Number(req.params.id)
  if (!Number.isInteger(clientId) || clientId < 1)
    return res.status(400).json({ error: 'Invalid client id' })

  const token = generateToken()
  try {
    const { rows } = await pool.query(
      `UPDATE ochr_clients
          SET swap_token = $1
        WHERE id = $2 AND organization_id = $3
        RETURNING id, swap_token`,
      [token, clientId, req.organizationId]
    )
    if (rows.length === 0)
      return res.status(404).json({ error: 'Member not found' })
    res.json({ id: rows[0].id, swap_token: rows[0].swap_token })
  } catch (err) {
    monitor.error('swap.admin.rotateToken', err)
    res.status(500).json({ error: 'Failed to rotate swap token' })
  }
})

// GET /api/swap-admin/requests
//   Org-wide swap-request list for admin visibility / audit.
swapAdminRouter.get('/requests', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.id, r.calendar_event_id, r.requester_client_id, r.target_client_id,
              r.note, r.status, r.created_at, r.decided_at,
              e.title    AS event_title,
              e.date     AS event_date,
              rc.name    AS requester_name,
              tc.name    AS target_name
         FROM ochr_swap_requests r
         JOIN ochr_calendar_events e ON e.id  = r.calendar_event_id
         JOIN ochr_clients rc        ON rc.id = r.requester_client_id
         JOIN ochr_clients tc        ON tc.id = r.target_client_id
        WHERE r.organization_id = $1
        ORDER BY r.created_at DESC
        LIMIT 200`,
      [req.organizationId]
    )
    res.json({ requests: rows })
  } catch (err) {
    monitor.error('swap.admin.list', err)
    res.status(500).json({ error: 'Failed to list swap requests' })
  }
})
