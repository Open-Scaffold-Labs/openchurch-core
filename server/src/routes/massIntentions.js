// Mass intention routes (MI.1). Tenant-scoped book of requested Mass
// intentions.
//
//   GET    /api/mass-intentions           → the book (paginated, ?status=, ?q=)
//   GET    /api/mass-intentions/:id        → one entry
//   POST   /api/mass-intentions            → add a request
//   PATCH  /api/mass-intentions/:id        → edit allowlisted fields
//   DELETE /api/mass-intentions/:id        → remove
//
// All queries scope on organization_id. Writes are staff/admin (writeGate at
// the mount); viewers read. A linked requester (requested_by_client_id) is
// validated against the caller's org before write.

import { Router } from 'express'
import pool from '../db.js'
import { requireIntParam, parsePagination } from '../utils/params.js'
import { monitor } from '../monitoring/index.js'

const router = Router()

export const MI_STATUSES = new Set(['open', 'scheduled', 'fulfilled', 'cancelled'])

// Columns a PATCH may touch, and how to read each from the body. Closed
// allowlist so organization_id / unknown columns can never be set.
const EDITABLE = {
  intention:    v => (typeof v === 'string' && v.trim() ? v.trim() : undefined),
  requested_by: v => (v == null ? null : String(v).trim() || null),
  mass_date:    v => (v === null || v === '' ? null : String(v)),
  note:         v => (v == null ? null : String(v).trim() || null),
  status:       v => (MI_STATUSES.has(v) ? v : undefined),
  stipend:      v => {
    if (v === null || v === '') return null
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 ? n : undefined
  },
}

async function clientInOrg(clientId, orgId) {
  const { rows } = await pool.query(
    'SELECT 1 FROM ochr_clients WHERE id = $1 AND organization_id = $2',
    [clientId, orgId]
  )
  return rows.length > 0
}

async function eventInOrg(eventId, orgId) {
  const { rows } = await pool.query(
    'SELECT 1 FROM ochr_calendar_events WHERE id = $1 AND organization_id = $2',
    [eventId, orgId]
  )
  return rows.length > 0
}

const SELECT_COLS = `s.id, s.intention, s.requested_by, s.requested_by_client_id,
                     to_char(s.mass_date, 'YYYY-MM-DD') AS mass_date,
                     s.calendar_event_id, s.stipend, s.status, s.note,
                     s.created_at, s.updated_at, c.name AS requester_name,
                     e.title AS mass_title, to_char(e.start_time, 'HH24:MI') AS mass_time`

const FROM_JOIN = `FROM ochr_mass_intentions s
                   LEFT JOIN ochr_clients c
                     ON c.id = s.requested_by_client_id AND c.organization_id = s.organization_id
                   LEFT JOIN ochr_calendar_events e
                     ON e.id = s.calendar_event_id AND e.organization_id = s.organization_id`

// GET /api/mass-intentions?status=&q=  (the book)
router.get('/', async (req, res) => {
  const { limit, offset } = parsePagination(req.query)
  const statusFilter = typeof req.query.status === 'string' && MI_STATUSES.has(req.query.status)
    ? req.query.status : null

  try {
    const where = ['s.organization_id = $1']
    const params = [req.organizationId]
    if (statusFilter) { params.push(statusFilter); where.push(`s.status = $${params.length}`) }

    const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''
    if (q) {
      const escaped = q.replace(/[\\%_]/g, ch => `\\${ch}`)
      params.push(`%${escaped}%`)
      const p = `$${params.length}`
      where.push(`(s.intention ILIKE ${p} OR s.requested_by ILIKE ${p} OR c.name ILIKE ${p})`)
    }
    params.push(limit, offset)

    const { rows } = await pool.query(
      `SELECT ${SELECT_COLS} ${FROM_JOIN}
        WHERE ${where.join(' AND ')}
        ORDER BY s.mass_date ASC NULLS FIRST, s.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    )
    res.json({ intentions: rows })
  } catch (err) {
    monitor.error('massIntentions.list', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load Mass intentions' })
  }
})

// GET /api/mass-intentions/weekly?start=YYYY-MM-DD&end=YYYY-MM-DD (MI.2)
// The sacristy manifest: scheduled intentions for a date range, from the
// read-optimized ochr_sacristy_weekly_manifest view. Defaults to the
// next 7 days; the range is capped at 31 days. Defined BEFORE '/:id' so
// the literal path isn't swallowed by the id param.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
router.get('/weekly', async (req, res) => {
  const startQ = typeof req.query.start === 'string' && ISO_DATE.test(req.query.start) ? req.query.start : null
  const endQ   = typeof req.query.end   === 'string' && ISO_DATE.test(req.query.end)   ? req.query.end   : null

  // Default window: today → +6 days (a liturgical week's worth of Masses).
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const pad = n => String(n).padStart(2, '0')
  const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const start = startQ ?? iso(today)
  const end   = endQ   ?? iso(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 6))

  if (end < start) return res.status(400).json({ error: 'end must be on or after start' })
  const spanDays = (Date.parse(end) - Date.parse(start)) / 86400000
  if (spanDays > 31) return res.status(400).json({ error: 'Range is capped at 31 days' })

  try {
    const { rows } = await pool.query(
      `SELECT id, to_char(mass_date, 'YYYY-MM-DD') AS mass_date, mass_title,
              to_char(mass_time, 'HH24:MI') AS mass_time, formatted_intention,
              requested_by, requester_name, stipend, status, note,
              calendar_event_id
         FROM ochr_sacristy_weekly_manifest
        WHERE organization_id = $1 AND mass_date BETWEEN $2 AND $3
        ORDER BY mass_date ASC, mass_time ASC NULLS LAST, id ASC
        LIMIT 500`,
      [req.organizationId, start, end]
    )
    res.json({ start, end, intentions: rows })
  } catch (err) {
    monitor.error('massIntentions.weekly', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load the weekly manifest' })
  }
})

// GET /api/mass-intentions/:id
router.get('/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    const { rows } = await pool.query(
      `SELECT ${SELECT_COLS} ${FROM_JOIN} WHERE s.id = $1 AND s.organization_id = $2`,
      [id, req.organizationId]
    )
    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (err) {
    monitor.error('massIntentions.get', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to load Mass intention' })
  }
})

// POST /api/mass-intentions
router.post('/', async (req, res) => {
  const intention = typeof req.body?.intention === 'string' ? req.body.intention.trim() : ''
  if (!intention) return res.status(400).json({ error: 'An intention is required' })

  const requestedBy = req.body?.requested_by != null ? String(req.body.requested_by).trim() || null : null
  const massDate = req.body?.mass_date ? String(req.body.mass_date) : null
  const note = req.body?.note != null ? String(req.body.note).trim() || null : null
  const status = MI_STATUSES.has(req.body?.status) ? req.body.status : 'open'
  const clientId = req.body?.requested_by_client_id != null ? Number(req.body.requested_by_client_id) : null
  const eventId = req.body?.calendar_event_id != null && req.body.calendar_event_id !== ''
    ? Number(req.body.calendar_event_id) : null

  let stipend = null
  if (req.body?.stipend != null && req.body.stipend !== '') {
    const n = Number(req.body.stipend)
    if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: 'Stipend must be a non-negative number' })
    stipend = n
  }

  try {
    let resolvedClientId = null
    if (Number.isInteger(clientId) && clientId > 0) {
      if (!(await clientInOrg(clientId, req.organizationId))) {
        return res.status(404).json({ error: 'Member not found in your church' })
      }
      resolvedClientId = clientId
    }

    let resolvedEventId = null
    if (eventId != null) {
      if (!Number.isInteger(eventId) || eventId <= 0 || !(await eventInOrg(eventId, req.organizationId))) {
        return res.status(404).json({ error: 'Mass not found on your calendar' })
      }
      resolvedEventId = eventId
    }

    const { rows } = await pool.query(
      `INSERT INTO ochr_mass_intentions
         (organization_id, intention, requested_by, requested_by_client_id, mass_date, stipend, status, note, calendar_event_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [req.organizationId, intention, requestedBy, resolvedClientId, massDate, stipend, status, note, resolvedEventId]
    )
    const { rows: full } = await pool.query(
      `SELECT ${SELECT_COLS} ${FROM_JOIN} WHERE s.id = $1 AND s.organization_id = $2`,
      [rows[0].id, req.organizationId]
    )
    res.status(201).json(full[0])
  } catch (err) {
    monitor.error('massIntentions.create', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to save Mass intention' })
  }
})

// PATCH /api/mass-intentions/:id
router.patch('/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return

  const sets = []
  const params = []
  for (const [col, read] of Object.entries(EDITABLE)) {
    if (Object.prototype.hasOwnProperty.call(req.body ?? {}, col)) {
      const val = read(req.body[col])
      if (val === undefined) return res.status(400).json({ error: `Invalid value for ${col}` })
      params.push(val); sets.push(`${col} = $${params.length}`)
    }
  }

  try {
    if (Object.prototype.hasOwnProperty.call(req.body ?? {}, 'calendar_event_id')) {
      const eid = req.body.calendar_event_id != null && req.body.calendar_event_id !== ''
        ? Number(req.body.calendar_event_id) : null
      if (eid == null) {
        params.push(null); sets.push(`calendar_event_id = $${params.length}`)
      } else if (Number.isInteger(eid) && eid > 0 && (await eventInOrg(eid, req.organizationId))) {
        params.push(eid); sets.push(`calendar_event_id = $${params.length}`)
      } else {
        return res.status(404).json({ error: 'Mass not found on your calendar' })
      }
    }

    if (Object.prototype.hasOwnProperty.call(req.body ?? {}, 'requested_by_client_id')) {
      const cid = req.body.requested_by_client_id != null ? Number(req.body.requested_by_client_id) : null
      if (cid == null) {
        params.push(null); sets.push(`requested_by_client_id = $${params.length}`)
      } else if (Number.isInteger(cid) && cid > 0 && (await clientInOrg(cid, req.organizationId))) {
        params.push(cid); sets.push(`requested_by_client_id = $${params.length}`)
      } else {
        return res.status(404).json({ error: 'Member not found in your church' })
      }
    }

    if (sets.length === 0) return res.status(400).json({ error: 'No editable fields provided' })
    sets.push(`updated_at = NOW()`)

    params.push(id, req.organizationId)
    const { rows } = await pool.query(
      `UPDATE ochr_mass_intentions SET ${sets.join(', ')}
        WHERE id = $${params.length - 1} AND organization_id = $${params.length}
        RETURNING id`,
      params
    )
    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    const { rows: full } = await pool.query(
      `SELECT ${SELECT_COLS} ${FROM_JOIN} WHERE s.id = $1 AND s.organization_id = $2`,
      [id, req.organizationId]
    )
    res.json(full[0])
  } catch (err) {
    monitor.error('massIntentions.update', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to update Mass intention' })
  }
})

// DELETE /api/mass-intentions/:id
router.delete('/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM ochr_mass_intentions WHERE id = $1 AND organization_id = $2',
      [id, req.organizationId]
    )
    if (!rowCount) return res.status(404).json({ error: 'Not found' })
    res.status(204).end()
  } catch (err) {
    monitor.error('massIntentions.delete', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to delete Mass intention' })
  }
})

export default router
