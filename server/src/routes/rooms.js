// Rooms / classes — admin CRUD (CHK.6).
//
//   GET    /api/rooms            → all rooms (or ?active=true)
//   POST   /api/rooms            → create
//   PATCH  /api/rooms/:id        → update name/capacity/active/order
//   DELETE /api/rooms/:id        → remove
//
// Rooms are the spaces check-ins can be assigned to. Tenant-scoped.

import { Router } from 'express'
import pool from '../db.js'
import { monitor } from '../monitoring/index.js'

const router = Router()

const SELECT_COLS = 'id, name, capacity, active, sort_order, created_at'
const PATCHABLE = new Set(['name', 'capacity', 'active', 'sort_order'])

router.get('/', async (req, res) => {
  const activeOnly = req.query.active === 'true'
  try {
    const { rows } = await pool.query(
      `SELECT ${SELECT_COLS} FROM ochr_rooms
        WHERE organization_id = $1 ${activeOnly ? 'AND active = TRUE' : ''}
        ORDER BY sort_order ASC, name ASC`,
      [req.organizationId]
    )
    res.json({ rooms: rows })
  } catch (err) {
    monitor.error('rooms.list', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load rooms' })
  }
})

router.post('/', async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
  const capacity = Number.isInteger(req.body?.capacity) && req.body.capacity > 0 ? req.body.capacity : null
  if (!name) return res.status(400).json({ error: 'Room name is required' })
  if (name.length > 80) return res.status(400).json({ error: 'Room name is too long' })
  try {
    const { rows } = await pool.query(
      `INSERT INTO ochr_rooms (organization_id, name, capacity)
       VALUES ($1, $2, $3) RETURNING ${SELECT_COLS}`,
      [req.organizationId, name, capacity]
    )
    res.status(201).json(rows[0])
  } catch (err) {
    monitor.error('rooms.create', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to create room' })
  }
})

router.patch('/:id', async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid id' })
  const updates = {}
  for (const k of Object.keys(req.body ?? {})) {
    if (!PATCHABLE.has(k)) continue
    let v = req.body[k]
    if (k === 'active') updates[k] = v === true || v === 'true'
    else if (k === 'capacity') updates[k] = (Number.isInteger(v) && v > 0) ? v : null
    else if (k === 'sort_order') { if (!Number.isInteger(v)) return res.status(400).json({ error: 'sort_order must be an integer' }); updates[k] = v }
    else { if (typeof v === 'string') v = v.trim(); if (k === 'name' && !v) return res.status(400).json({ error: 'Room name cannot be empty' }); updates[k] = v }
  }
  const keys = Object.keys(updates)
  if (!keys.length) return res.status(400).json({ error: 'No editable fields in body' })
  const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ')
  const params = keys.map(k => updates[k]); params.push(id, req.organizationId)
  try {
    const { rows } = await pool.query(
      `UPDATE ochr_rooms SET ${sets}
        WHERE id = $${keys.length + 1} AND organization_id = $${keys.length + 2}
        RETURNING ${SELECT_COLS}`,
      params
    )
    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (err) {
    monitor.error('rooms.update', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to update room' })
  }
})

router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid id' })
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM ochr_rooms WHERE id = $1 AND organization_id = $2',
      [id, req.organizationId]
    )
    if (!rowCount) return res.status(404).json({ error: 'Not found' })
    res.status(204).end()
  } catch (err) {
    monitor.error('rooms.delete', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to delete room' })
  }
})

export default router
