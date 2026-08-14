// Giving funds — admin CRUD (GIV.1).
//
//   GET    /api/funds            → all funds (or ?active=true)
//   POST   /api/funds            → create a fund
//   PATCH  /api/funds/:id        → update name/description/active/order
//   DELETE /api/funds/:id        → remove a fund
//
// Funds are the designations the public give page offers. A church with
// no active funds isn't collecting online gifts yet. All tenant-scoped.

import { Router } from 'express'
import pool from '../db.js'
import { monitor } from '../monitoring/index.js'
import { paymentsProvider } from '../payments/index.js'

const router = Router()

const SELECT_COLS = 'id, name, description, active, sort_order, created_at'
const PATCHABLE = new Set(['name', 'description', 'active', 'sort_order'])

router.get('/', async (req, res) => {
  const activeOnly = req.query.active === 'true'
  try {
    const { rows } = await pool.query(
      `SELECT ${SELECT_COLS}
         FROM ochr_funds
        WHERE organization_id = $1
          ${activeOnly ? 'AND active = TRUE' : ''}
        ORDER BY sort_order ASC, name ASC`,
      [req.organizationId]
    )
    // `provider` lets the admin UI show whether online giving is live or
    // still on the stub ('stub' = test mode, no real charges).
    res.json({ funds: rows, provider: paymentsProvider() })
  } catch (err) {
    monitor.error('funds.list', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load funds' })
  }
})

router.post('/', async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
  const description = typeof req.body?.description === 'string' ? req.body.description.trim() || null : null
  const active = req.body?.active === undefined ? true : req.body.active === true || req.body.active === 'true'
  const sortOrder = Number.isInteger(req.body?.sort_order) ? req.body.sort_order : 0

  if (!name) return res.status(400).json({ error: 'Fund name is required' })
  if (name.length > 80) return res.status(400).json({ error: 'Fund name is too long' })

  try {
    const { rows } = await pool.query(
      `INSERT INTO ochr_funds (organization_id, name, description, active, sort_order)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${SELECT_COLS}`,
      [req.organizationId, name, description, active, sortOrder]
    )
    res.status(201).json(rows[0])
  } catch (err) {
    monitor.error('funds.create', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to create fund' })
  }
})

router.patch('/:id', async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid id' })

  const updates = {}
  for (const k of Object.keys(req.body ?? {})) {
    if (!PATCHABLE.has(k)) continue
    let v = req.body[k]
    if (k === 'active') {
      updates[k] = v === true || v === 'true'
    } else if (k === 'sort_order') {
      if (!Number.isInteger(v)) return res.status(400).json({ error: 'sort_order must be an integer' })
      updates[k] = v
    } else {
      if (typeof v === 'string') v = v.trim()
      if (k === 'name' && !v) return res.status(400).json({ error: 'Fund name cannot be empty' })
      if (k === 'name' && v.length > 80) return res.status(400).json({ error: 'Fund name is too long' })
      updates[k] = v || null
    }
  }
  const keys = Object.keys(updates)
  if (!keys.length) return res.status(400).json({ error: 'No editable fields in body' })

  const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ')
  const params = keys.map(k => updates[k])
  params.push(id, req.organizationId)

  try {
    const { rows } = await pool.query(
      `UPDATE ochr_funds SET ${sets}
        WHERE id = $${keys.length + 1} AND organization_id = $${keys.length + 2}
        RETURNING ${SELECT_COLS}`,
      params
    )
    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (err) {
    monitor.error('funds.update', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to update fund' })
  }
})

router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid id' })
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM ochr_funds WHERE id = $1 AND organization_id = $2',
      [id, req.organizationId]
    )
    if (!rowCount) return res.status(404).json({ error: 'Not found' })
    res.status(204).end()
  } catch (err) {
    monitor.error('funds.delete', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to delete fund' })
  }
})

export default router
