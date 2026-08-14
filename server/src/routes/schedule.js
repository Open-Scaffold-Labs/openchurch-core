import { Router } from 'express'
import pool from '../db.js'
import { requireIntParam } from '../utils/params.js'

const router = Router()

const DAY_ORDER = `CASE day_of_week
  WHEN 'Sunday'    THEN 0 WHEN 'Monday'   THEN 1 WHEN 'Tuesday' THEN 2
  WHEN 'Wednesday' THEN 3 WHEN 'Thursday' THEN 4 WHEN 'Friday'  THEN 5
  WHEN 'Saturday'  THEN 6 ELSE 7 END`

// GET /api/schedule?search=
router.get('/', async (req, res) => {
  try {
    const { search } = req.query
    const { rows } = search
      ? await pool.query(
          `SELECT * FROM ochr_schedule
           WHERE organization_id = $1
             AND (title ILIKE $2 OR service_type ILIKE $2 OR location ILIKE $2 OR day_of_week ILIKE $2)
           ORDER BY ${DAY_ORDER}, start_time`,
          [req.organizationId, `%${search}%`]
        )
      : await pool.query(
          `SELECT * FROM ochr_schedule WHERE organization_id = $1 ORDER BY ${DAY_ORDER}, start_time`,
          [req.organizationId]
        )
    res.json(rows)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to load schedule' })
  }
})

// POST /api/schedule
router.post('/', async (req, res) => {
  try {
    const { title, service_type, day_of_week, start_time, end_time, recurrence, specific_date, location, notes } = req.body
    if (!title?.trim()) return res.status(400).json({ error: 'Title is required' })
    const { rows } = await pool.query(
      `INSERT INTO ochr_schedule (organization_id, title, service_type, day_of_week, start_time, end_time, recurrence, specific_date, location, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [req.organizationId, title, service_type, day_of_week, start_time || null, end_time || null, recurrence, specific_date || null, location, notes]
    )
    res.status(201).json(rows[0])
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to create schedule entry' })
  }
})

// PATCH /api/schedule/:id
router.patch('/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    // Partial-update semantics (audit H1): only fields present in the
    // body are written. Allowlist is hardcoded — nothing from the
    // request reaches the SQL text.
    const PATCHABLE = ['title', 'service_type', 'day_of_week', 'start_time', 'end_time', 'recurrence', 'specific_date', 'location', 'notes']
    const sets = []
    const vals = []
    for (const col of PATCHABLE) {
      if (req.body[col] !== undefined) {
        vals.push(req.body[col] === '' ? null : req.body[col])
        sets.push(`${col} = $${vals.length}`)
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'No fields to update' })

    const { rows } = await pool.query(
      `UPDATE ochr_schedule SET ${sets.join(', ')}
        WHERE id = $${vals.length + 1} AND organization_id = $${vals.length + 2} RETURNING *`,
      [...vals, id, req.organizationId]
    )
    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to update schedule entry' })
  }
})

// DELETE /api/schedule/:id
router.delete('/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    const result = await pool.query(
      'DELETE FROM ochr_schedule WHERE id = $1 AND organization_id = $2',
      [id, req.organizationId]
    )
    if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' })
    res.status(204).end()
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to delete schedule entry' })
  }
})

export default router
