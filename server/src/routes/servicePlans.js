// Service Planner — order-of-worship CRUD (SVC.1).
//
//   GET    /api/service-plans                     → plans (date DESC) + element counts
//   GET    /api/service-plans/:id                 → plan + ordered elements (w/ assignee name)
//   POST   /api/service-plans                     → create a plan
//   PATCH  /api/service-plans/:id                 → update plan fields
//   DELETE /api/service-plans/:id                 → delete plan (+ its elements)
//
//   POST   /api/service-plans/:id/elements        → append an element
//   PATCH  /api/service-plans/:id/elements/:eid   → update an element
//   DELETE /api/service-plans/:id/elements/:eid   → remove an element
//   PUT    /api/service-plans/:id/elements/reorder { ids: [...] } → set order
//
// Tenant-scoped on organization_id throughout. Linked calendar_event_id
// and assigned_client_id are validated to the caller's org before they
// land, so a crafted id can't point at another church's row.

import { Router } from 'express'
import pool from '../db.js'
import { requireIntParam } from '../utils/params.js'
import { monitor } from '../monitoring/index.js'

const router = Router()

const KINDS = new Set(['hymn', 'reading', 'psalm', 'prayer', 'rite', 'sermon', 'music', 'announcement', 'other'])
const DATE_RX = /^\d{4}-\d{2}-\d{2}$/

function cleanStr(v, max) {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t ? t.slice(0, max) : null
}

// Validate an optional id belongs to the caller's org. Returns the id
// when valid, null otherwise (so a stale/foreign id silently clears
// rather than failing the write).
async function ownedId(table, id, orgId) {
  const n = id != null ? Number(id) : null
  if (!Number.isInteger(n) || n < 1) return null
  const { rows } = await pool.query(`SELECT 1 FROM ${table} WHERE id = $1 AND organization_id = $2`, [n, orgId])
  return rows.length ? n : null
}

// ── Plans ────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.id, to_char(p.date, 'YYYY-MM-DD') AS date, p.title, p.calendar_event_id,
              p.notes, p.created_at, p.updated_at,
              COUNT(e.id)::int AS element_count
         FROM ochr_service_plans p
         LEFT JOIN ochr_service_elements e ON e.plan_id = p.id
        WHERE p.organization_id = $1
        GROUP BY p.id
        ORDER BY p.date DESC, p.id DESC`,
      [req.organizationId]
    )
    res.json({ plans: rows })
  } catch (err) {
    monitor.error('servicePlans.list', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load service plans' })
  }
})

router.get('/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    const { rows: planRows } = await pool.query(
      `SELECT id, to_char(date, 'YYYY-MM-DD') AS date, title, calendar_event_id, notes, created_at, updated_at
         FROM ochr_service_plans WHERE id = $1 AND organization_id = $2`,
      [id, req.organizationId]
    )
    if (!planRows.length) return res.status(404).json({ error: 'Not found' })

    const { rows: elements } = await pool.query(
      `SELECT e.id, e.position, e.kind, e.title, e.reference, e.assigned_client_id,
              e.notes, c.name AS assigned_name
         FROM ochr_service_elements e
         LEFT JOIN ochr_clients c ON c.id = e.assigned_client_id
        WHERE e.plan_id = $1 AND e.organization_id = $2
        ORDER BY e.position ASC, e.id ASC`,
      [id, req.organizationId]
    )
    res.json({ ...planRows[0], elements })
  } catch (err) {
    monitor.error('servicePlans.get', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to load service plan' })
  }
})

router.post('/', async (req, res) => {
  const date = typeof req.body?.date === 'string' ? req.body.date.trim() : ''
  if (!DATE_RX.test(date)) return res.status(400).json({ error: 'A valid date (YYYY-MM-DD) is required' })
  const title = cleanStr(req.body?.title, 120) || 'Service'
  const notes = cleanStr(req.body?.notes, 4000)
  try {
    const eventId = await ownedId('ochr_calendar_events', req.body?.calendar_event_id, req.organizationId)
    const { rows } = await pool.query(
      `INSERT INTO ochr_service_plans (organization_id, date, title, calendar_event_id, notes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, to_char(date, 'YYYY-MM-DD') AS date, title, calendar_event_id, notes, created_at, updated_at`,
      [req.organizationId, date, title, eventId, notes]
    )
    res.status(201).json({ ...rows[0], elements: [] })
  } catch (err) {
    monitor.error('servicePlans.create', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to create service plan' })
  }
})

router.patch('/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  const updates = {}
  if (req.body?.title !== undefined)  updates.title = cleanStr(req.body.title, 120) || 'Service'
  if (req.body?.notes !== undefined)  updates.notes = cleanStr(req.body.notes, 4000)
  if (req.body?.date !== undefined) {
    const d = typeof req.body.date === 'string' ? req.body.date.trim() : ''
    if (!DATE_RX.test(d)) return res.status(400).json({ error: 'Invalid date' })
    updates.date = d
  }
  if (req.body?.calendar_event_id !== undefined) {
    updates.calendar_event_id = await ownedId('ochr_calendar_events', req.body.calendar_event_id, req.organizationId)
  }
  const keys = Object.keys(updates)
  if (!keys.length) return res.status(400).json({ error: 'No editable fields in body' })
  const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ')
  const params = keys.map(k => updates[k]); params.push(id, req.organizationId)
  try {
    const { rows } = await pool.query(
      `UPDATE ochr_service_plans SET ${sets}, updated_at = NOW()
        WHERE id = $${keys.length + 1} AND organization_id = $${keys.length + 2}
        RETURNING id, to_char(date, 'YYYY-MM-DD') AS date, title, calendar_event_id, notes, created_at, updated_at`,
      params
    )
    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (err) {
    monitor.error('servicePlans.update', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to update service plan' })
  }
})

router.delete('/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM ochr_service_plans WHERE id = $1 AND organization_id = $2',
      [id, req.organizationId]
    )
    if (!rowCount) return res.status(404).json({ error: 'Not found' })
    res.status(204).end()
  } catch (err) {
    monitor.error('servicePlans.delete', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to delete service plan' })
  }
})

// ── Elements ─────────────────────────────────────────────────

// Confirm the plan exists in this org; returns true/false.
async function planInOrg(planId, orgId) {
  const { rows } = await pool.query('SELECT 1 FROM ochr_service_plans WHERE id = $1 AND organization_id = $2', [planId, orgId])
  return rows.length > 0
}

router.post('/:id/elements', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  if (!(await planInOrg(id, req.organizationId))) return res.status(404).json({ error: 'Plan not found' })

  const title = cleanStr(req.body?.title, 200)
  if (!title) return res.status(400).json({ error: 'An element title is required' })
  const kind = KINDS.has(req.body?.kind) ? req.body.kind : 'other'
  const reference = cleanStr(req.body?.reference, 200)
  const notes = cleanStr(req.body?.notes, 2000)
  try {
    const assigned = await ownedId('ochr_clients', req.body?.assigned_client_id, req.organizationId)
    // Append: position = current max + 1.
    const { rows: posRows } = await pool.query(
      'SELECT COALESCE(MAX(position), -1) + 1 AS next FROM ochr_service_elements WHERE plan_id = $1',
      [id]
    )
    const position = posRows[0].next
    const { rows } = await pool.query(
      `INSERT INTO ochr_service_elements
         (organization_id, plan_id, position, kind, title, reference, assigned_client_id, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, position, kind, title, reference, assigned_client_id, notes`,
      [req.organizationId, id, position, kind, title, reference, assigned, notes]
    )
    res.status(201).json(rows[0])
  } catch (err) {
    monitor.error('servicePlans.addElement', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to add element' })
  }
})

router.patch('/:id/elements/:eid', async (req, res) => {
  const id = Number(req.params.id), eid = Number(req.params.eid)
  if (!Number.isInteger(id) || !Number.isInteger(eid)) return res.status(400).json({ error: 'Invalid id' })

  const updates = {}
  if (req.body?.title !== undefined) {
    const t = cleanStr(req.body.title, 200)
    if (!t) return res.status(400).json({ error: 'Title cannot be empty' })
    updates.title = t
  }
  if (req.body?.kind !== undefined)      updates.kind = KINDS.has(req.body.kind) ? req.body.kind : 'other'
  if (req.body?.reference !== undefined) updates.reference = cleanStr(req.body.reference, 200)
  if (req.body?.notes !== undefined)     updates.notes = cleanStr(req.body.notes, 2000)
  if (req.body?.assigned_client_id !== undefined) {
    updates.assigned_client_id = await ownedId('ochr_clients', req.body.assigned_client_id, req.organizationId)
  }
  const keys = Object.keys(updates)
  if (!keys.length) return res.status(400).json({ error: 'No editable fields in body' })
  const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ')
  const params = keys.map(k => updates[k]); params.push(eid, id, req.organizationId)
  try {
    const { rows } = await pool.query(
      `UPDATE ochr_service_elements SET ${sets}
        WHERE id = $${keys.length + 1} AND plan_id = $${keys.length + 2} AND organization_id = $${keys.length + 3}
        RETURNING id, position, kind, title, reference, assigned_client_id, notes`,
      params
    )
    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (err) {
    monitor.error('servicePlans.updateElement', err, { orgId: req.organizationId, id, eid })
    res.status(500).json({ error: 'Failed to update element' })
  }
})

router.delete('/:id/elements/:eid', async (req, res) => {
  const id = Number(req.params.id), eid = Number(req.params.eid)
  if (!Number.isInteger(id) || !Number.isInteger(eid)) return res.status(400).json({ error: 'Invalid id' })
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM ochr_service_elements WHERE id = $1 AND plan_id = $2 AND organization_id = $3',
      [eid, id, req.organizationId]
    )
    if (!rowCount) return res.status(404).json({ error: 'Not found' })
    res.status(204).end()
  } catch (err) {
    monitor.error('servicePlans.deleteElement', err, { orgId: req.organizationId, id, eid })
    res.status(500).json({ error: 'Failed to delete element' })
  }
})

// PUT /:id/elements/reorder  { ids: [orderedElementIds] }
// Sets position = array index for the given elements (drag-to-reorder).
// Only elements belonging to this plan + org are touched.
router.put('/:id/elements/reorder', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  if (!(await planInOrg(id, req.organizationId))) return res.status(404).json({ error: 'Plan not found' })
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(n => Number.isInteger(n)) : null
  if (!ids || !ids.length) return res.status(400).json({ error: 'ids array is required' })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // The submitted order must cover exactly this plan's elements — no missing
    // ids (which would leave stale, colliding positions) and no foreign or
    // duplicate ids. Otherwise the stored ordering is ambiguous.
    const { rows: existing } = await client.query(
      'SELECT id FROM ochr_service_elements WHERE plan_id = $1 AND organization_id = $2',
      [id, req.organizationId]
    )
    // id is BIGSERIAL → pg returns it as a string; normalize to Number to
    // match `ids` (already mapped through Number) for the set comparison.
    const have = new Set(existing.map(r => Number(r.id)))
    const got  = new Set(ids)
    if (got.size !== ids.length || got.size !== have.size || [...have].some(x => !got.has(x))) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'ids must list every element of this plan exactly once' })
    }
    for (let i = 0; i < ids.length; i++) {
      await client.query(
        'UPDATE ochr_service_elements SET position = $1 WHERE id = $2 AND plan_id = $3 AND organization_id = $4',
        [i, ids[i], id, req.organizationId]
      )
    }
    await client.query('COMMIT')
    res.status(204).end()
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    monitor.error('servicePlans.reorder', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to reorder elements' })
  } finally {
    client.release()
  }
})

export default router
