// Self-serve kiosk (CHK.7 / Sprint 4).
//
// Two routers, mirroring the swap-token split (routes/swap.js):
//
//   kioskAdminRouter  (authed, admin-only)
//     GET    /api/kiosk-admin          → current org's kiosk token (or null)
//     POST   /api/kiosk-admin/rotate   → mint a fresh token (enables/re-keys)
//     DELETE /api/kiosk-admin          → revoke (token → null, kiosk off)
//
//   kioskPublicRouter (unauthenticated, token in the path)
//     GET    /api/kiosk/:token             → org + today's services + rooms
//     GET    /api/kiosk/:token/members?q=  → typeahead member search (rate-limited)
//     POST   /api/kiosk/:token/checkin     → self check-in (rate-limited)
//
// The token is a capability URL: unguessable, scoped to one org, and an
// admin can rotate it to revoke a tablet that walked off. A bad token
// 404s without revealing whether the org exists. Only the data a kiosk
// needs to render is exposed — today's services and active rooms up front,
// and members only via a query-gated typeahead (never the full roster in
// one shot), so an unauthenticated token holder can't scrape the directory.

import { Router } from 'express'
import crypto from 'crypto'
import rateLimit from 'express-rate-limit'
import pool from '../db.js'
import { genSecurityCode, hashSecurityCode } from '../utils/pickupCode.js'
import { monitor } from '../monitoring/index.js'

// base64url, 24 bytes — same shape as swap_token / calendar_token.
const TOKEN_RX = /^[A-Za-z0-9_-]{20,64}$/
function genToken() {
  return crypto.randomBytes(24).toString('base64url')
}

const KINDS = new Set(['member', 'guest', 'child'])

// Resolve an org id from a kiosk token, or null. Tight regex first so a
// junk path never reaches the DB. The org's timezone comes along so the
// "today" filters below mean the church's local day, not UTC (CHK.7).
async function orgForToken(token) {
  if (!TOKEN_RX.test(token ?? '')) return null
  const { rows } = await pool.query(
    'SELECT id, name, timezone, locale FROM ochr_organizations WHERE kiosk_token = $1',
    [token]
  )
  return rows[0] ?? null
}

// ─── Admin router ────────────────────────────────────────────
export const kioskAdminRouter = Router()

kioskAdminRouter.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT kiosk_token FROM ochr_organizations WHERE id = $1',
      [req.organizationId]
    )
    res.json({ kiosk_token: rows[0]?.kiosk_token ?? null })
  } catch (err) {
    monitor.error('kiosk.admin.get', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load kiosk token' })
  }
})

kioskAdminRouter.post('/rotate', async (req, res) => {
  try {
    const token = genToken()
    const { rows } = await pool.query(
      'UPDATE ochr_organizations SET kiosk_token = $1 WHERE id = $2 RETURNING kiosk_token',
      [token, req.organizationId]
    )
    if (!rows.length) return res.status(404).json({ error: 'Organization not found' })
    res.json({ kiosk_token: rows[0].kiosk_token })
  } catch (err) {
    monitor.error('kiosk.admin.rotate', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to rotate kiosk token' })
  }
})

kioskAdminRouter.delete('/', async (req, res) => {
  try {
    await pool.query(
      'UPDATE ochr_organizations SET kiosk_token = NULL WHERE id = $1',
      [req.organizationId]
    )
    res.status(204).end()
  } catch (err) {
    monitor.error('kiosk.admin.revoke', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to disable kiosk' })
  }
})

// ─── Public token-gated router ───────────────────────────────
export const kioskPublicRouter = Router()

// A kiosk runs on one tablet checking in a stream of people, so the
// limiter is roomy — 120 check-ins per 5 minutes per IP. Tight enough
// to blunt a script, loose enough for a busy Sunday line.
const checkinLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many check-ins from this device. Please wait a moment.' },
})

// GET /api/kiosk/:token — the kiosk shell: org name, today's services, and
// active rooms. Deliberately NO member roster — members come from the
// query-gated /:token/members typeahead so a token holder can't slurp the
// whole directory in one unauthenticated request.
kioskPublicRouter.get('/:token', async (req, res) => {
  try {
    const org = await orgForToken(req.params.token)
    if (!org) return res.status(404).json({ error: 'Kiosk not found' })

    const [services, rooms] = await Promise.all([
      pool.query(
        `SELECT id, title, date, start_time, end_time,
                liturgical_season, liturgical_color, feast_name
           FROM ochr_calendar_events
          WHERE organization_id = $1 AND date = (now() AT TIME ZONE $2)::date
          ORDER BY start_time ASC NULLS LAST, title ASC`,
        [org.id, org.timezone]
      ),
      pool.query(
        `SELECT id, name FROM ochr_rooms
          WHERE organization_id = $1 AND active = TRUE
          ORDER BY sort_order ASC, name ASC`,
        [org.id]
      ),
    ])

    res.json({
      org:      { name: org.name, locale: org.locale ?? 'en' },
      services: services.rows,
      rooms:    rooms.rows,
    })
  } catch (err) {
    monitor.error('kiosk.public.resolve', err)
    res.status(500).json({ error: 'Failed to load kiosk' })
  }
})

// A kiosk fires a typeahead as someone types their name, so the limiter is
// roomy — 60 lookups per 5 minutes per IP. Loose enough for a checking-in
// crowd, tight enough that the endpoint can't be used to page through the
// whole roster.
const memberSearchLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many lookups from this device. Please wait a moment.' },
})

// GET /api/kiosk/:token/members?q=<name> — typeahead member search. Requires
// at least 2 characters (a shorter/empty q returns []), matches active
// members by name, and caps at 10 rows so the kiosk never receives the full
// directory. Only id + name are exposed, same as the old inline roster.
kioskPublicRouter.get('/:token/members', memberSearchLimiter, async (req, res) => {
  try {
    const org = await orgForToken(req.params.token)
    if (!org) return res.status(404).json({ error: 'Kiosk not found' })

    const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''
    if (q.length < 2) return res.json({ members: [] })

    // Escape LIKE metacharacters so a member typing '%' or '_' can't turn
    // their name into a wildcard match. Backslash first, then % and _.
    const escaped = q.replace(/\\/g, '\\\\').replace(/[%_]/g, ch => `\\${ch}`)
    const { rows } = await pool.query(
      `SELECT id, name FROM ochr_clients
        WHERE organization_id = $1 AND status = 'active' AND name ILIKE $2
        ORDER BY name ASC
        LIMIT 10`,
      [org.id, `%${escaped}%`]
    )
    res.json({ members: rows })
  } catch (err) {
    monitor.error('kiosk.public.members', err)
    res.status(500).json({ error: 'Failed to search members' })
  }
})

// POST /api/kiosk/:token/checkin
//   { calendar_event_id, client_id?, person_name?, kind?, guardian_name?, room_id? }
// Self-serve check-in. Same tenancy rules as the authed route, but the
// org is resolved from the token, never from a JWT.
kioskPublicRouter.post('/:token/checkin', checkinLimiter, async (req, res) => {
  try {
    const org = await orgForToken(req.params.token)
    if (!org) return res.status(404).json({ error: 'Kiosk not found' })
    const orgId = org.id

    const eventId  = Number(req.body?.calendar_event_id)
    const clientId = req.body?.client_id != null ? Number(req.body.client_id) : null
    let   name     = typeof req.body?.person_name === 'string' ? req.body.person_name.trim() : ''
    const kind     = KINDS.has(req.body?.kind) ? req.body.kind : 'member'
    const guardian = typeof req.body?.guardian_name === 'string' ? req.body.guardian_name.trim() || null : null
    const roomReq  = req.body?.room_id != null ? Number(req.body.room_id) : null

    if (!Number.isInteger(eventId) || eventId < 1) {
      return res.status(400).json({ error: 'Please pick a service' })
    }

    // Event must belong to the org AND be today (in the org's own
    // timezone) — a kiosk can't be used to backfill arbitrary
    // past/future events.
    const ev = await pool.query(
      `SELECT 1 FROM ochr_calendar_events
        WHERE id = $1 AND organization_id = $2 AND date = (now() AT TIME ZONE $3)::date`,
      [eventId, orgId, org.timezone]
    )
    if (!ev.rows.length) return res.status(400).json({ error: 'That service is not available' })

    // Optional room, validated to the org; a stale id drops to null.
    let roomId = null
    if (Number.isInteger(roomReq) && roomReq > 0) {
      const r = await pool.query('SELECT 1 FROM ochr_rooms WHERE id = $1 AND organization_id = $2', [roomReq, orgId])
      if (r.rows.length) roomId = roomReq
    }

    // Member name resolution + tenancy check.
    let resolvedClientId = null
    if (Number.isInteger(clientId) && clientId > 0) {
      const c = await pool.query(
        "SELECT name FROM ochr_clients WHERE id = $1 AND organization_id = $2 AND status = 'active'",
        [clientId, orgId]
      )
      if (!c.rows.length) return res.status(400).json({ error: 'We could not find your name' })
      resolvedClientId = clientId
      if (!name) name = c.rows[0].name
    }

    if (!name) return res.status(400).json({ error: 'A name is required' })
    if (name.length > 120) return res.status(400).json({ error: 'Name is too long' })

    // Persist only the hash; the plaintext code is shown once on the kiosk
    // screen for the guardian and never stored (child-data safety, CHK.3).
    const securityCode = kind === 'child' ? genSecurityCode() : null
    const securityHash = hashSecurityCode(securityCode)

    // Double-tap safe (055): a second submit for the same member returns
    // the existing active check-in as success instead of a duplicate row.
    const { rows, rowCount } = await pool.query(
      `INSERT INTO ochr_checkins
         (organization_id, calendar_event_id, client_id, person_name, kind, guardian_name, security_code_hash, room_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (calendar_event_id, client_id)
       WHERE client_id IS NOT NULL AND checked_out_at IS NULL
       DO NOTHING
       RETURNING id, person_name, kind, room_id, checked_in_at`,
      [orgId, eventId, resolvedClientId, name, kind, guardian, securityHash, roomId]
    )
    if (rowCount === 0) {
      const { rows: existing } = await pool.query(
        `SELECT id, person_name, kind, room_id, checked_in_at
           FROM ochr_checkins
          WHERE organization_id = $1 AND calendar_event_id = $2 AND client_id = $3
            AND checked_out_at IS NULL`,
        [orgId, eventId, resolvedClientId]
      )
      return res.status(200).json({ ...existing[0], security_code: null, already_checked_in: true })
    }
    res.status(201).json({ ...rows[0], security_code: securityCode })
  } catch (err) {
    monitor.error('kiosk.public.checkin', err)
    res.status(500).json({ error: 'Failed to check in' })
  }
})
