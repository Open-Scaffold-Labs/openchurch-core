// Daily operational checklists (OPS.1) — templates + today's runs.
//
//   GET    /api/checklists/templates       → the org's routines
//   POST   /api/checklists/templates       → { title, items: [string] }
//   PATCH  /api/checklists/templates/:id   → { title?, items?, active? }
//   DELETE /api/checklists/templates/:id
//   GET    /api/checklists/today           → today's runs (lazily created
//                                            from active templates, in the
//                                            org's own timezone)
//   PATCH  /api/checklists/runs/:id        → { index, done } — tick one item
//
// Runs snapshot the template at creation, so yesterday's completed list
// never rewrites under a template edit. "Today" is the org's timezone
// (040), not the server's — a sacristan in California should not get
// tomorrow's checklist at 5 PM.

import { Router } from 'express'
import pool from '../db.js'
import { requireIntParam } from '../utils/params.js'
import { monitor } from '../monitoring/index.js'

const router = Router()

const MAX_ITEMS = 50

function cleanItems(raw) {
  if (!Array.isArray(raw)) return null
  const items = raw.map(i => String(i ?? '').trim()).filter(Boolean)
  if (items.length === 0 || items.length > MAX_ITEMS) return null
  if (items.some(i => i.length > 300)) return null
  return items
}

async function orgToday(orgId) {
  const { rows } = await pool.query(
    `SELECT to_char(NOW() AT TIME ZONE COALESCE(timezone, 'UTC'), 'YYYY-MM-DD') AS today
       FROM ochr_organizations WHERE id = $1`,
    [orgId]
  )
  return rows[0]?.today
}

// GET /api/checklists/templates
router.get('/templates', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, title, items, active, sort_order
         FROM ochr_checklist_templates
        WHERE organization_id = $1
        ORDER BY sort_order, id`,
      [req.organizationId]
    )
    res.json({ templates: rows })
  } catch (err) {
    monitor.error('checklists.templates.list', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load checklists' })
  }
})

// POST /api/checklists/templates
router.post('/templates', async (req, res) => {
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : ''
  const items = cleanItems(req.body?.items)
  if (!title || title.length > 120) return res.status(400).json({ error: 'A title is required (max 120 characters)' })
  if (!items) return res.status(400).json({ error: `Provide 1–${MAX_ITEMS} checklist items` })
  try {
    const { rows } = await pool.query(
      `INSERT INTO ochr_checklist_templates (organization_id, title, items)
       VALUES ($1, $2, $3)
       RETURNING id, title, items, active, sort_order`,
      [req.organizationId, title, JSON.stringify(items)]
    )
    res.status(201).json(rows[0])
  } catch (err) {
    monitor.error('checklists.templates.create', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to save the checklist' })
  }
})

// PATCH /api/checklists/templates/:id
router.patch('/templates/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  const sets = []
  const params = []
  if (Object.prototype.hasOwnProperty.call(req.body ?? {}, 'title')) {
    const title = String(req.body.title ?? '').trim()
    if (!title || title.length > 120) return res.status(400).json({ error: 'Invalid title' })
    params.push(title); sets.push(`title = $${params.length}`)
  }
  if (Object.prototype.hasOwnProperty.call(req.body ?? {}, 'items')) {
    const items = cleanItems(req.body.items)
    if (!items) return res.status(400).json({ error: `Provide 1–${MAX_ITEMS} checklist items` })
    params.push(JSON.stringify(items)); sets.push(`items = $${params.length}`)
  }
  if (Object.prototype.hasOwnProperty.call(req.body ?? {}, 'active')) {
    params.push(Boolean(req.body.active)); sets.push(`active = $${params.length}`)
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' })
  try {
    params.push(id, req.organizationId)
    const { rows } = await pool.query(
      `UPDATE ochr_checklist_templates SET ${sets.join(', ')}
        WHERE id = $${params.length - 1} AND organization_id = $${params.length}
        RETURNING id, title, items, active, sort_order`,
      params
    )
    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (err) {
    monitor.error('checklists.templates.patch', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to update the checklist' })
  }
})

// DELETE /api/checklists/templates/:id
router.delete('/templates/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM ochr_checklist_templates WHERE id = $1 AND organization_id = $2',
      [id, req.organizationId]
    )
    if (!rowCount) return res.status(404).json({ error: 'Not found' })
    res.status(204).end()
  } catch (err) {
    monitor.error('checklists.templates.delete', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to delete the checklist' })
  }
})

// GET /api/checklists/today — lazily materialize today's runs.
// ON CONFLICT DO NOTHING makes concurrent morning page-loads safe; the
// select afterwards returns whichever writer won.
router.get('/today', async (req, res) => {
  try {
    const today = await orgToday(req.organizationId)
    await pool.query(
      `INSERT INTO ochr_checklist_runs (organization_id, template_id, run_date, title, items)
       SELECT t.organization_id, t.id, $2::date, t.title,
              (SELECT COALESCE(jsonb_agg(jsonb_build_object('text', i, 'done', false)), '[]'::jsonb)
                 FROM jsonb_array_elements_text(t.items) AS i)
         FROM ochr_checklist_templates t
        WHERE t.organization_id = $1 AND t.active
       ON CONFLICT (template_id, run_date) DO NOTHING`,
      [req.organizationId, today]
    )
    const { rows } = await pool.query(
      `SELECT r.id, r.title, r.items, r.template_id,
              to_char(r.run_date, 'YYYY-MM-DD') AS run_date
         FROM ochr_checklist_runs r
         JOIN ochr_checklist_templates t ON t.id = r.template_id
        WHERE r.organization_id = $1 AND r.run_date = $2::date
        ORDER BY t.sort_order, t.id`,
      [req.organizationId, today]
    )
    res.json({ date: today, runs: rows })
  } catch (err) {
    monitor.error('checklists.today', err, { orgId: req.organizationId })
    res.status(500).json({ error: "Failed to load today's checklists" })
  }
})

// PATCH /api/checklists/runs/:id — { index, done }
router.patch('/runs/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  const index = Number(req.body?.index)
  const done = Boolean(req.body?.done)
  if (!Number.isInteger(index) || index < 0 || index >= MAX_ITEMS) {
    return res.status(400).json({ error: 'Invalid item index' })
  }
  try {
    // jsonb_set on the single item — atomic, no read-modify-write race
    // between two staff ticking different items at once.
    const { rows } = await pool.query(
      `UPDATE ochr_checklist_runs
          SET items = jsonb_set(items, ARRAY[$1::text, 'done'], to_jsonb($2::boolean)),
              updated_at = NOW()
        WHERE id = $3 AND organization_id = $4
          AND jsonb_array_length(items) > $1
        RETURNING id, title, items, to_char(run_date, 'YYYY-MM-DD') AS run_date`,
      [index, done, id, req.organizationId]
    )
    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (err) {
    monitor.error('checklists.runs.patch', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to update the checklist item' })
  }
})

export default router
