// Member unavailability (blackout dates) — VS.4a.
//
//   GET    /api/availability?client_id=ID  → a member's blackout ranges
//   GET    /api/availability?date=YYYY-MM-DD → members unavailable that day
//   POST   /api/availability               → add a blackout range
//   DELETE /api/availability/:id           → remove one
//
// All tenant-scoped on organization_id. Dates are returned as
// 'YYYY-MM-DD' strings (to_char) so the client never has to undo a
// timezone shift from a JS Date.

import { Router } from 'express'
import pool from '../db.js'
import { monitor } from '../monitoring/index.js'

const router = Router()

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

// Shared column projection — dates as plain ISO strings.
const SELECT_COLS = `
  id, client_id,
  to_char(start_date, 'YYYY-MM-DD') AS start_date,
  to_char(end_date,   'YYYY-MM-DD') AS end_date,
  reason, created_at`

// GET /api/availability
//   ?client_id=ID    → that member's ranges (the per-member editor)
//   ?date=YYYY-MM-DD → everyone unavailable on that date (modal warning)
// Exactly one of the two is required.
router.get('/', async (req, res) => {
  const clientId = req.query.client_id ? Number(req.query.client_id) : null
  const date     = req.query.date ? String(req.query.date) : null

  try {
    if (clientId) {
      if (!Number.isInteger(clientId) || clientId < 1) {
        return res.status(400).json({ error: 'Invalid client_id' })
      }
      const { rows } = await pool.query(
        `SELECT ${SELECT_COLS}
           FROM ochr_member_unavailability
          WHERE organization_id = $1 AND client_id = $2
          ORDER BY start_date ASC`,
        [req.organizationId, clientId]
      )
      return res.json({ unavailability: rows })
    }

    if (date) {
      if (!ISO_DATE.test(date)) {
        return res.status(400).json({ error: 'date must be YYYY-MM-DD' })
      }
      const { rows } = await pool.query(
        `SELECT ${SELECT_COLS}
           FROM ochr_member_unavailability
          WHERE organization_id = $1
            AND start_date <= $2::date
            AND end_date   >= $2::date
          ORDER BY client_id ASC`,
        [req.organizationId, date]
      )
      return res.json({ unavailability: rows })
    }

    return res.status(400).json({ error: 'Provide client_id or date' })
  } catch (err) {
    monitor.error('availability.list', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load availability' })
  }
})

// POST /api/availability
//   { client_id, start_date, end_date?, reason? }
// end_date defaults to start_date (a single-day blackout).
router.post('/', async (req, res) => {
  const clientId  = Number(req.body?.client_id)
  const startDate = req.body?.start_date
  const endDate   = req.body?.end_date || req.body?.start_date
  const reason    = typeof req.body?.reason === 'string' ? req.body.reason.trim() || null : null

  if (!Number.isInteger(clientId) || clientId < 1) {
    return res.status(400).json({ error: 'client_id is required' })
  }
  if (!ISO_DATE.test(String(startDate)) || !ISO_DATE.test(String(endDate))) {
    return res.status(400).json({ error: 'start_date and end_date must be YYYY-MM-DD' })
  }
  if (endDate < startDate) {
    return res.status(400).json({ error: 'end_date must be on or after start_date' })
  }

  try {
    // Tenant guard — the member must belong to the caller's org.
    const { rows: owns } = await pool.query(
      'SELECT 1 FROM ochr_clients WHERE id = $1 AND organization_id = $2',
      [clientId, req.organizationId]
    )
    if (!owns.length) {
      return res.status(400).json({ error: 'Member not found in your church' })
    }

    const { rows } = await pool.query(
      `INSERT INTO ochr_member_unavailability
         (organization_id, client_id, start_date, end_date, reason)
       VALUES ($1, $2, $3::date, $4::date, $5)
       RETURNING ${SELECT_COLS}`,
      [req.organizationId, clientId, startDate, endDate, reason]
    )
    res.status(201).json(rows[0])
  } catch (err) {
    monitor.error('availability.create', err, { orgId: req.organizationId, clientId })
    res.status(500).json({ error: 'Failed to add unavailability' })
  }
})

// DELETE /api/availability/:id
router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Invalid id' })
  }
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM ochr_member_unavailability WHERE id = $1 AND organization_id = $2',
      [id, req.organizationId]
    )
    if (!rowCount) return res.status(404).json({ error: 'Not found' })
    res.status(204).end()
  } catch (err) {
    monitor.error('availability.delete', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to remove unavailability' })
  }
})

export default router
