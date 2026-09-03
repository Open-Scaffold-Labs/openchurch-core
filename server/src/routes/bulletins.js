// Weekly bulletin — admin CRUD (BUL.1).
//
//   GET    /api/bulletins          → this org's bulletins, newest first
//   GET    /api/bulletins/:id      → one bulletin
//   POST   /api/bulletins          → create (or update the one for a date)
//   PATCH  /api/bulletins/:id      → update
//   DELETE /api/bulletins/:id      → remove
//
// One bulletin per (org, date) — POSTing an existing date updates it
// rather than erroring, so the editor can "save" idempotently. The
// liturgical day and the week's services are NOT stored here; the editor
// and the print view pull those live from /api/liturgical and
// /api/calendar. Admin-only (mounted with requireRole('admin')).

import { Router } from 'express'
import pool from '../db.js'
import { requireIntParam } from '../utils/params.js'
import { monitor } from '../monitoring/index.js'
import { protectedDelete } from '../vault/deleteRoute.js'

const router = Router()

const DATE_RX = /^\d{4}-\d{2}-\d{2}$/
const SELECT_COLS = `id, to_char(date, 'YYYY-MM-DD') AS date, title, announcements,
                     readings, intentions, pastor_note, published, created_at, updated_at`

// Free-text fields an editor may set. Soft length caps keep the table
// tidy without getting in the way of a long announcements block.
const TEXT_FIELDS = {
  title:         200,
  announcements: 8000,
  readings:      4000,
  intentions:    4000,
  pastor_note:   4000,
}

function cleanText(v, max) {
  if (v === undefined) return undefined
  if (v === null) return null
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  if (!t) return null
  return t.slice(0, max)
}

router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${SELECT_COLS} FROM ochr_bulletins
        WHERE organization_id = $1
        ORDER BY date DESC`,
      [req.organizationId]
    )
    res.json({ bulletins: rows })
  } catch (err) {
    monitor.error('bulletins.list', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load bulletins' })
  }
})

router.get('/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    const { rows } = await pool.query(
      `SELECT ${SELECT_COLS} FROM ochr_bulletins WHERE id = $1 AND organization_id = $2`,
      [id, req.organizationId]
    )
    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (err) {
    monitor.error('bulletins.get', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to load bulletin' })
  }
})

router.post('/', async (req, res) => {
  const date = typeof req.body?.date === 'string' ? req.body.date.trim() : ''
  if (!DATE_RX.test(date)) return res.status(400).json({ error: 'A valid date (YYYY-MM-DD) is required' })

  const title         = cleanText(req.body?.title, TEXT_FIELDS.title)
  const announcements = cleanText(req.body?.announcements, TEXT_FIELDS.announcements)
  const readings      = cleanText(req.body?.readings, TEXT_FIELDS.readings)
  const intentions    = cleanText(req.body?.intentions, TEXT_FIELDS.intentions)
  const pastorNote    = cleanText(req.body?.pastor_note, TEXT_FIELDS.pastor_note)
  const published     = req.body?.published === true || req.body?.published === 'true'

  try {
    // One bulletin per (org, date): re-posting the same date updates it.
    const { rows } = await pool.query(
      `INSERT INTO ochr_bulletins
         (organization_id, date, title, announcements, readings, intentions, pastor_note, published)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (organization_id, date) DO UPDATE SET
         title = EXCLUDED.title, announcements = EXCLUDED.announcements,
         readings = EXCLUDED.readings, intentions = EXCLUDED.intentions,
         pastor_note = EXCLUDED.pastor_note, published = EXCLUDED.published,
         updated_at = NOW()
       RETURNING ${SELECT_COLS}`,
      [req.organizationId, date, title ?? null, announcements ?? null, readings ?? null, intentions ?? null, pastorNote ?? null, published]
    )
    res.status(201).json(rows[0])
  } catch (err) {
    monitor.error('bulletins.upsert', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to save bulletin' })
  }
})

router.patch('/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return

  const updates = {}
  for (const [k, max] of Object.entries(TEXT_FIELDS)) {
    const v = cleanText(req.body?.[k], max)
    if (v !== undefined) updates[k] = v
  }
  if (req.body?.published !== undefined) {
    updates.published = req.body.published === true || req.body.published === 'true'
  }
  const keys = Object.keys(updates)
  if (!keys.length) return res.status(400).json({ error: 'No editable fields in body' })

  const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ')
  const params = keys.map(k => updates[k]); params.push(id, req.organizationId)
  try {
    const { rows } = await pool.query(
      `UPDATE ochr_bulletins SET ${sets}, updated_at = NOW()
        WHERE id = $${keys.length + 1} AND organization_id = $${keys.length + 2}
        RETURNING ${SELECT_COLS}`,
      params
    )
    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (err) {
    monitor.error('bulletins.update', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to update bulletin' })
  }
})

// Protected by the Continuity Vault — a bulletin is a written artifact of
// a particular Sunday, and nobody rewrites one from memory.
router.delete('/:id', protectedDelete('bulletin', { failure: 'Failed to delete bulletin' }))

export default router
