// Check-in routes (CHK.1 / Sprint 4). Records people checking in to a
// Schedule event. A check-in is a known member (client_id) or a walk-in
// captured by name. All tenant-scoped on organization_id.
//
//   GET    /api/checkins?event_id=ID  → check-ins for an event
//   POST   /api/checkins              → check someone in
//   POST   /api/checkins/:id/checkout → stamp checked_out_at
//   DELETE /api/checkins/:id          → remove a mistaken check-in

import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import pool from '../db.js'
import { requireIntParam, parseDays } from '../utils/params.js'
import { genSecurityCode, hashSecurityCode, verifySecurityCode } from '../utils/pickupCode.js'
import { monitor } from '../monitoring/index.js'

const router = Router()

const KINDS = new Set(['member', 'guest', 'child'])

// Cap pickup-code guessing on checkout. The keyspace is small (~810k), so
// even behind staff auth an insider shouldn't be able to brute a target
// child's code — the limiter bounds attempts per device. Threshold is well
// above any legitimate release rate for one worker.
const checkoutLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many checkout attempts. Please wait a moment.' },
})

// GET /api/checkins/recent?days=N (CHK.4)
// Recent services with their attendance count — the org-level
// attendance report. Default 30 days, newest first.
router.get('/recent', async (req, res) => {
  const days = parseDays(req.query.days, 30)
  try {
    const { rows } = await pool.query(
      `SELECT e.id AS event_id, e.title, e.date,
              COUNT(ci.id)::int AS attendance
         FROM ochr_calendar_events e
         JOIN ochr_checkins ci ON ci.calendar_event_id = e.id AND ci.organization_id = $1
        WHERE e.organization_id = $1
          AND e.date >= CURRENT_DATE - ($2 || ' days')::interval
        GROUP BY e.id, e.title, e.date
        ORDER BY e.date DESC
        LIMIT 50`,
      [req.organizationId, days]
    )
    res.json({ services: rows })
  } catch (err) {
    monitor.error('checkins.recent', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load attendance report' })
  }
})

// GET /api/checkins?event_id=ID
router.get('/', async (req, res) => {
  const eventId = Number(req.query.event_id)
  if (!Number.isInteger(eventId) || eventId < 1) {
    return res.status(400).json({ error: 'event_id is required' })
  }
  try {
    const { rows } = await pool.query(
      `SELECT ci.id, ci.calendar_event_id, ci.client_id, ci.person_name, ci.kind,
              ci.guardian_name, ci.checked_in_at, ci.checked_out_at,
              ci.room_id, r.name AS room_name
         FROM ochr_checkins ci
         LEFT JOIN ochr_rooms r ON r.id = ci.room_id
        WHERE ci.organization_id = $1 AND ci.calendar_event_id = $2
        ORDER BY ci.checked_in_at DESC`,
      [req.organizationId, eventId]
    )
    const present = rows.filter(r => !r.checked_out_at).length
    res.json({ checkins: rows, count: rows.length, present })
  } catch (err) {
    monitor.error('checkins.list', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load check-ins' })
  }
})

// POST /api/checkins
//   { calendar_event_id, client_id?, person_name?, kind?, guardian_name? }
// client_id wins for the name when present; otherwise person_name is
// required (walk-in / child).
router.post('/', async (req, res) => {
  const eventId  = Number(req.body?.calendar_event_id)
  const clientId = req.body?.client_id != null ? Number(req.body.client_id) : null
  let   name     = typeof req.body?.person_name === 'string' ? req.body.person_name.trim() : ''
  const kind     = KINDS.has(req.body?.kind) ? req.body.kind : 'member'
  const guardian = typeof req.body?.guardian_name === 'string' ? req.body.guardian_name.trim() || null : null
  const roomReq  = req.body?.room_id != null ? Number(req.body.room_id) : null

  if (!Number.isInteger(eventId) || eventId < 1) {
    return res.status(400).json({ error: 'calendar_event_id is required' })
  }

  try {
    // Event must belong to the org.
    const ev = await pool.query(
      'SELECT 1 FROM ochr_calendar_events WHERE id = $1 AND organization_id = $2',
      [eventId, req.organizationId]
    )
    if (!ev.rows.length) return res.status(400).json({ error: 'Unknown event' })

    // Room (optional) must belong to the org; a stale/foreign id drops
    // to null rather than failing the check-in.
    let roomId = null
    if (Number.isInteger(roomReq) && roomReq > 0) {
      const r = await pool.query('SELECT 1 FROM ochr_rooms WHERE id = $1 AND organization_id = $2', [roomReq, req.organizationId])
      if (r.rows.length) roomId = roomReq
    }

    // Resolve a member's name (and validate tenancy) when client_id given.
    let resolvedClientId = null
    if (Number.isInteger(clientId) && clientId > 0) {
      const c = await pool.query(
        'SELECT name FROM ochr_clients WHERE id = $1 AND organization_id = $2',
        [clientId, req.organizationId]
      )
      if (!c.rows.length) return res.status(400).json({ error: 'Member not found in your church' })
      resolvedClientId = clientId
      if (!name) name = c.rows[0].name
    }

    if (!name) return res.status(400).json({ error: 'A name is required' })
    if (name.length > 120) return res.status(400).json({ error: 'Name is too long' })

    // Children get a one-time pickup code. We persist only its SHA-256
    // hash; the plaintext is returned here (shown once) and never stored.
    const securityCode = kind === 'child' ? genSecurityCode() : null
    const securityHash = hashSecurityCode(securityCode)

    // Idempotent on double-submit for members: the partial unique index
    // uq_checkins_active (055) makes a second concurrent check-in for
    // the same (event, member) conflict; we return the existing active
    // row as success — the person IS checked in, which is all the
    // double-tap was asking. Guests/children by name (client_id NULL)
    // are outside the guard and insert normally.
    const { rows, rowCount } = await pool.query(
      `INSERT INTO ochr_checkins
         (organization_id, calendar_event_id, client_id, person_name, kind, guardian_name, security_code_hash, room_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (calendar_event_id, client_id)
       WHERE client_id IS NOT NULL AND checked_out_at IS NULL
       DO NOTHING
       RETURNING id, calendar_event_id, client_id, person_name, kind, guardian_name,
                 room_id, checked_in_at, checked_out_at`,
      [req.organizationId, eventId, resolvedClientId, name, kind, guardian, securityHash, roomId]
    )
    if (rowCount === 0) {
      const { rows: existing } = await pool.query(
        `SELECT id, calendar_event_id, client_id, person_name, kind, guardian_name,
                room_id, checked_in_at, checked_out_at
           FROM ochr_checkins
          WHERE organization_id = $1 AND calendar_event_id = $2 AND client_id = $3
            AND checked_out_at IS NULL`,
        [req.organizationId, eventId, resolvedClientId]
      )
      return res.status(200).json({ ...existing[0], security_code: null, already_checked_in: true })
    }
    // Surface the plaintext code once in the response (never from the DB).
    res.status(201).json({ ...rows[0], security_code: securityCode })
  } catch (err) {
    monitor.error('checkins.create', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to check in' })
  }
})

// POST /api/checkins/:id/checkout   { code? }
// A check-in carrying a security_code (a child) requires the matching
// code to release — that's the pickup-safety gate (CHK.3).
router.post('/:id/checkout', checkoutLimiter, async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    const { rows: existing } = await pool.query(
      'SELECT security_code_hash, checked_out_at FROM ochr_checkins WHERE id = $1 AND organization_id = $2',
      [id, req.organizationId]
    )
    const c = existing[0]
    if (!c) return res.status(404).json({ error: 'Not found' })
    if (c.checked_out_at) return res.status(409).json({ error: 'Already checked out' })

    if (c.security_code_hash) {
      const provided = typeof req.body?.code === 'string' ? req.body.code.trim() : ''
      if (!provided) return res.status(400).json({ error: 'A pickup code is required' })
      // Compare keyed hashes in constant time, never plaintext — the code
      // isn't stored in the clear, and a timing leak of the stored hash would
      // be offline-reversible given the small keyspace.
      if (!verifySecurityCode(provided, c.security_code_hash)) {
        return res.status(403).json({ error: 'Pickup code does not match' })
      }
    }

    // Stamp checkout AND purge the (now-spent) code hash so it can't linger.
    const { rows } = await pool.query(
      `UPDATE ochr_checkins SET checked_out_at = NOW(), security_code_hash = NULL
        WHERE id = $1 AND organization_id = $2 AND checked_out_at IS NULL
        RETURNING id, checked_out_at`,
      [id, req.organizationId]
    )
    if (!rows.length) return res.status(404).json({ error: 'Not found or already checked out' })
    res.json(rows[0])
  } catch (err) {
    monitor.error('checkins.checkout', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to check out' })
  }
})

// DELETE /api/checkins/:id
router.delete('/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM ochr_checkins WHERE id = $1 AND organization_id = $2',
      [id, req.organizationId]
    )
    if (!rowCount) return res.status(404).json({ error: 'Not found' })
    res.status(204).end()
  } catch (err) {
    monitor.error('checkins.delete', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to remove check-in' })
  }
})

export default router
