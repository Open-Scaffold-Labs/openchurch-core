// Feedback route (FB.1) — the founder's workbench.
//
//   POST /api/feedback   { category, message, route? }
//
// Mounted behind requireAuth only (NO writeGate) so every authenticated
// member of the cohort — including viewers — can send a note. The
// organization, submitter email, and role are taken from the verified JWT
// claims (req.user / req.organizationId), never from the request body, so a
// caller can't spoof who they are or which church they're in.

import { Router } from 'express'
import pool from '../db.js'
import { parsePagination } from '../utils/params.js'
import { monitor } from '../monitoring/index.js'

const router = Router()

const CATEGORIES = new Set(['bug', 'suggestion', 'pastoral_note'])
const MAX_MESSAGE = 5000
const MAX_ROUTE = 512

router.post('/', async (req, res) => {
  const category = req.body?.category
  if (!CATEGORIES.has(category)) {
    return res.status(400).json({ error: `category must be one of: ${[...CATEGORIES].join(', ')}` })
  }

  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : ''
  if (!message) return res.status(400).json({ error: 'A message is required' })
  if (message.length > MAX_MESSAGE) return res.status(400).json({ error: 'Message is too long' })

  // Client path the user was on (context for the note). Optional; capped.
  let route = typeof req.body?.route === 'string' ? req.body.route.trim() : null
  if (route && route.length > MAX_ROUTE) route = route.slice(0, MAX_ROUTE)

  try {
    const { rows } = await pool.query(
      `INSERT INTO ochr_feedback_ledger
         (organization_id, user_id, user_email, user_role, category, message, route)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, created_at`,
      [
        req.organizationId,
        req.user?.id ?? null,
        req.user?.email ?? null,
        req.user?.role ?? null,
        category,
        message,
        route,
      ]
    )
    res.status(201).json({ id: rows[0].id, created_at: rows[0].created_at })
  } catch (err) {
    monitor.error('feedback.create', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to send your message' })
  }
})

// ── Founder workbench (FB.2) ──────────────────────────────────────
// Cross-tenant BY DESIGN: the workbench is the founder's read over every
// parish's Inner Circle notes, mounted behind requireSuperAdmin (env-
// matched email, 404 otherwise) in app.js. These are the only queries in
// the codebase that may legitimately skip the organization_id scope.

export const adminRouter = Router()

const ADMIN_STATUSES = new Set(['open', 'replied'])

// GET /api/admin/feedback?status=open|replied  (default: all, newest first)
adminRouter.get('/', async (req, res) => {
  const { limit, offset } = parsePagination(req.query)
  const statusFilter = typeof req.query.status === 'string' && ADMIN_STATUSES.has(req.query.status)
    ? req.query.status : null

  try {
    const where = []
    const params = []
    if (statusFilter) { params.push(statusFilter); where.push(`f.status = $${params.length}`) }
    params.push(limit, offset)

    const { rows } = await pool.query(
      `SELECT f.id, f.organization_id, f.user_id, o.name AS organization,
              CASE WHEN u.closed_at IS NOT NULL THEN NULL ELSE f.user_email END AS user_email,
              (u.closed_at IS NOT NULL) AS actor_closed,
              f.user_role, f.category, f.message, f.route,
              f.status, f.created_at
         FROM ochr_feedback_ledger f
         JOIN ochr_organizations o ON o.id = f.organization_id
         LEFT JOIN ochr_users u
           ON u.id = f.user_id AND u.organization_id = f.organization_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY f.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    )
    res.json({ feedback: rows })
  } catch (err) {
    monitor.error('feedback.admin.list', err)
    res.status(500).json({ error: 'Failed to load feedback' })
  }
})

// PATCH /api/admin/feedback/:id  { status: 'open' | 'replied' }
adminRouter.patch('/:id', async (req, res) => {
  const id = Number.parseInt(req.params.id, 10)
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid id' })
  if (!ADMIN_STATUSES.has(req.body?.status)) {
    return res.status(400).json({ error: `status must be one of: ${[...ADMIN_STATUSES].join(', ')}` })
  }

  try {
    const { rows } = await pool.query(
      `UPDATE ochr_feedback_ledger SET status = $1
        /* tenancy: founder workbench — cross-parish by design, behind
           requireSuperAdmin (env-matched email, 404 otherwise) */
        WHERE id = $2
        RETURNING id, status`,
      [req.body.status, id]
    )
    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (err) {
    monitor.error('feedback.admin.update', err, { id })
    res.status(500).json({ error: 'Failed to update feedback' })
  }
})

export default router
