// Parish feasts — tenant-scoped liturgical overrides (LIT.5).
//
//   GET    /api/parish-feasts        → this org's feasts (date ASC)
//   POST   /api/parish-feasts        → add/replace a feast for a date
//   DELETE /api/parish-feasts/:id    → remove one
//
// A parish feast names a day the universal calendar doesn't — the
// patronal feast, the dedication anniversary, a locally-kept saint. It
// layers over ochr_liturgical_calendar (see routes/liturgical.js) and is
// stamped onto events at create/update time. Writes are admin-only
// (gated at the mount in app.js); reads stay open to any
// authenticated org member.

import { Router } from 'express'
import pool from '../db.js'
import { requireIntParam } from '../utils/params.js'
import { monitor } from '../monitoring/index.js'

const router = Router()

// The five canonical liturgical colors. A parish feast may recolor its
// day; anything else is rejected so the chip maps stay predictable.
const COLORS = new Set(['White', 'Red', 'Green', 'Purple', 'Gold'])
const DATE_RX = /^\d{4}-\d{2}-\d{2}$/

router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, to_char(date, 'YYYY-MM-DD') AS date, feast_name, liturgical_color, created_at
         FROM ochr_parish_feasts
        WHERE organization_id = $1
        ORDER BY date ASC`,
      [req.organizationId]
    )
    res.json({ feasts: rows })
  } catch (err) {
    monitor.error('parishFeasts.list', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load parish feasts' })
  }
})

router.post('/', async (req, res) => {
  const date  = typeof req.body?.date === 'string' ? req.body.date.trim() : ''
  const name  = typeof req.body?.feast_name === 'string' ? req.body.feast_name.trim() : ''
  let   color = req.body?.liturgical_color
  color = typeof color === 'string' && color.trim() ? color.trim() : null

  if (!DATE_RX.test(date)) return res.status(400).json({ error: 'A valid date (YYYY-MM-DD) is required' })
  if (!name) return res.status(400).json({ error: 'A feast name is required' })
  if (name.length > 120) return res.status(400).json({ error: 'Feast name is too long' })
  if (color && !COLORS.has(color)) {
    return res.status(400).json({ error: `Color must be one of: ${[...COLORS].join(', ')}` })
  }

  try {
    // One feast per (org, date): re-posting the same date updates it.
    const { rows } = await pool.query(
      `INSERT INTO ochr_parish_feasts (organization_id, date, feast_name, liturgical_color)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (organization_id, date)
         DO UPDATE SET feast_name = EXCLUDED.feast_name,
                       liturgical_color = COALESCE(EXCLUDED.liturgical_color, ochr_parish_feasts.liturgical_color)
       RETURNING id, to_char(date, 'YYYY-MM-DD') AS date, feast_name, liturgical_color, created_at`,
      [req.organizationId, date, name, color]
    )
    res.status(201).json(rows[0])
  } catch (err) {
    monitor.error('parishFeasts.upsert', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to save parish feast' })
  }
})

router.delete('/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM ochr_parish_feasts WHERE id = $1 AND organization_id = $2',
      [id, req.organizationId]
    )
    if (!rowCount) return res.status(404).json({ error: 'Not found' })
    res.status(204).end()
  } catch (err) {
    monitor.error('parishFeasts.delete', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to delete parish feast' })
  }
})

export default router
