import { Router } from 'express'
import pool from '../db.js'
import { parsePagination } from '../utils/params.js'

const router = Router()

// Validate that `memberId` (if given) belongs to the caller's org before
// we attach it to a task. Returns the id if valid, null if missing or
// not-in-org, so the caller can treat both cases identically.
async function validateMember(db, memberId, orgId) {
  if (!memberId) return null
  const { rows } = await db.query(
    'SELECT id FROM ochr_clients WHERE id = $1 AND organization_id = $2',
    [memberId, orgId]
  )
  return rows[0]?.id ?? null
}

// GET /api/tasks?category=&status=&priority=
router.get('/', async (req, res) => {
  try {
    const { category, status, priority } = req.query
    const where  = ['t.organization_id = $1']
    const params = [req.organizationId]
    if (category) { params.push(category); where.push(`t.category = $${params.length}`) }
    if (status)   { params.push(status);   where.push(`t.status = $${params.length}`) }
    if (priority) { params.push(priority); where.push(`t.priority = $${params.length}`) }
    // Optional paging with a hard safety ceiling (see parsePagination) so
    // this list can never stream unbounded. Response stays a bare array —
    // clients/tests depend on that shape.
    const { limit, offset } = parsePagination(req.query)
    params.push(limit, offset)
    const sql = `
      SELECT t.*, c.name AS assigned_member_name
      FROM ochr_tasks t
      LEFT JOIN ochr_clients c ON t.assigned_member_id = c.id
      WHERE ${where.join(' AND ')}
      ORDER BY CASE t.priority WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END, t.created_at
      LIMIT $${params.length - 1} OFFSET $${params.length}`
    const { rows } = await pool.query(sql, params)
    res.json(rows)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to load tasks' })
  }
})

// GET /api/tasks/stats
router.get('/stats', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status = 'COMPLETED') AS completed,
        COUNT(*) FILTER (WHERE status = 'IN_PROGRESS') AS in_progress,
        COUNT(*) FILTER (WHERE status = 'PENDING') AS pending,
        COUNT(*) FILTER (WHERE priority = 'HIGH' AND status != 'COMPLETED') AS high_pending
      FROM ochr_tasks
      WHERE organization_id = $1
    `, [req.organizationId])
    res.json(rows[0])
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to load stats' })
  }
})

// GET /api/tasks/:id/events — events sharing this task's assigned member.
router.get('/:id/events', async (req, res) => {
  try {
    const { rows: taskRows } = await pool.query(
      'SELECT assigned_member_id FROM ochr_tasks WHERE id = $1 AND organization_id = $2',
      [req.params.id, req.organizationId]
    )
    if (!taskRows.length) return res.status(404).json({ error: 'Not found' })
    const memberId = taskRows[0].assigned_member_id
    if (!memberId) return res.json([])

    const { rows } = await pool.query(
      `SELECT e.*
         FROM ochr_events e
         JOIN ochr_event_members em ON em.event_id = e.id
        WHERE em.member_id = $1 AND e.organization_id = $2
        ORDER BY e.date NULLS LAST, e.time NULLS LAST, e.created_at`,
      [memberId, req.organizationId]
    )
    res.json(rows)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to load linked events' })
  }
})

// POST /api/tasks
router.post('/', async (req, res) => {
  try {
    const { id, title, description, category, assigned_to, priority, status, recurring_freq, checklist, due_date, assigned_member_id } = req.body
    if (!title?.trim()) return res.status(400).json({ error: 'Title is required' })
    const orgId  = req.organizationId
    const taskId = id || `task-${Date.now()}`
    const safeMemberId = await validateMember(pool, assigned_member_id, orgId)

    const { rows } = await pool.query(
      `INSERT INTO ochr_tasks (organization_id, id, title, description, category, assigned_to, priority, status, recurring_freq, checklist, due_date, assigned_member_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [orgId, taskId, title, description, category, assigned_to, priority || 'MEDIUM', status || 'PENDING', recurring_freq, JSON.stringify(checklist || []), due_date || null, safeMemberId]
    )
    if (safeMemberId) {
      await pool.query(
        `INSERT INTO ochr_notifications (organization_id, type, member_id, task_id, task_title, message)
         VALUES ($1, 'task', $2, $3, $4, $5)`,
        [orgId, safeMemberId, taskId, title, `You have been assigned a new task: "${title}"`]
      )
    }
    res.status(201).json(rows[0])
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to create task' })
  }
})

// PATCH /api/tasks/:id
router.patch('/:id', async (req, res) => {
  try {
    const { title, description, category, assigned_to, priority, status, recurring_freq, checklist, due_date, assigned_member_id } = req.body
    const orgId = req.organizationId

    const { rows: prev } = await pool.query(
      'SELECT assigned_member_id FROM ochr_tasks WHERE id = $1 AND organization_id = $2',
      [req.params.id, orgId]
    )
    if (!prev.length) return res.status(404).json({ error: 'Not found' })
    const prevMemberId = prev[0].assigned_member_id ?? null
    const newMemberId  = await validateMember(pool, assigned_member_id, orgId)

    const { rows } = await pool.query(
      `UPDATE ochr_tasks SET
        title=$1, description=$2, category=$3, assigned_to=$4,
        priority=$5, status=$6, recurring_freq=$7, checklist=$8, due_date=$9,
        assigned_member_id=$10,
        completed_at = CASE WHEN $6 = 'COMPLETED' THEN NOW() ELSE NULL END
       WHERE id = $11 AND organization_id = $12 RETURNING *`,
      [title, description, category, assigned_to, priority, status, recurring_freq, JSON.stringify(checklist || []), due_date || null, newMemberId, req.params.id, orgId]
    )
    if (!rows.length) return res.status(404).json({ error: 'Not found' })

    if (newMemberId && String(newMemberId) !== String(prevMemberId)) {
      await pool.query(
        `INSERT INTO ochr_notifications (organization_id, type, member_id, task_id, task_title, message)
         VALUES ($1, 'task', $2, $3, $4, $5)`,
        [orgId, newMemberId, req.params.id, title, `You have been assigned to a task: "${title}"`]
      )
    }
    res.json(rows[0])
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to update task' })
  }
})

// PATCH /api/tasks/:id/status  — quick status toggle
router.patch('/:id/status', async (req, res) => {
  try {
    const { status } = req.body
    const { rows } = await pool.query(
      `UPDATE ochr_tasks SET status=$1,
        completed_at = CASE WHEN $1 = 'COMPLETED' THEN NOW() ELSE NULL END
       WHERE id = $2 AND organization_id = $3 RETURNING *`,
      [status, req.params.id, req.organizationId]
    )
    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to update status' })
  }
})

// PATCH /api/tasks/:id/checklist — update just the checklist array.
router.patch('/:id/checklist', async (req, res) => {
  try {
    const { checklist } = req.body
    if (!Array.isArray(checklist)) {
      return res.status(400).json({ error: 'checklist must be an array' })
    }
    const { rows } = await pool.query(
      `UPDATE ochr_tasks SET checklist = $1 WHERE id = $2 AND organization_id = $3 RETURNING *`,
      [JSON.stringify(checklist), req.params.id, req.organizationId]
    )
    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to update checklist' })
  }
})

// DELETE /api/tasks/:id
router.delete('/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM ochr_tasks WHERE id = $1 AND organization_id = $2',
      [req.params.id, req.organizationId]
    )
    if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' })
    res.status(204).end()
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to delete task' })
  }
})

export default router
