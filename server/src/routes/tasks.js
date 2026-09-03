import { Router } from 'express'
import pool from '../db.js'
import { parsePagination } from '../utils/params.js'
import { TASK_COLUMNS, EVENT_COLUMNS } from './publicColumns.js'

const router = Router()

// A task row is not a task response. ochr_tasks carries a GENERATED
// `search_vec` — the stemmed tokens of title and description — and every
// `SELECT t.*` / `RETURNING *` in this file was shipping it. Reproduced
// 27 Aug: GET /api/tasks and PATCH /api/tasks/:id/checklist both returned it.
// Named columns make a future column a decision instead of an accident.
const TASK_PUBLIC_COLUMNS = TASK_COLUMNS.list

// Task categories, and why this is a closed set rather than free text.
//
// EVIDENCE, not preference. ochr_tasks.category is `TEXT NOT NULL` with NO
// DEFAULT, on a table where the author gave `priority TEXT DEFAULT 'MEDIUM'`
// and `status TEXT DEFAULT 'PENDING'` two lines away — defaults were supplied
// where defaults were intended, and deliberately withheld here. The client's
// task form has always sent one (`emptyForm` sets DAILY_OPS) from a <select>
// over a closed list, and both seeders always supply one. So: required,
// from a fixed vocabulary.
//
// The API validated neither, which produced two defects. Omitting category
// reached the NOT NULL constraint and came back as a bare 500 'Failed to
// create task' — a constraint violation dressed as a server fault. And any
// string was accepted, so a typo became a permanent bogus group on the
// Tasks board, where `CATEGORY_META[task.category] ?? { label: task.category }`
// renders whatever it is told.
//
// This list mirrors CATEGORIES in client/src/pages/Tasks.jsx. Two
// declarations of one vocabulary is the shape Pass 6 flagged in the API
// contracts; it is pinned by a test here rather than left to drift.
// COMMUNICATIONS was found by the test below, not by reading. The sample-org
// seeder ships "[Sample] Send weekly newsletter" under it, so it is live in
// real tenants — while the client's CATEGORIES list omitted it, which means
// that task has never been filterable on the Tasks board and renders through
// the unknown-category fallback. A validator built from the client list alone
// would have rejected the product's own seed data. Added to both.
export const TASK_CATEGORIES = new Set([
  'OPENING', 'CLOSING', 'DAILY_OPS', 'CLEANING', 'SERVICE_PREP', 'MAINTENANCE',
  'COMMUNICATIONS',
])

export const categoryError = (value) => {
  if (value == null || String(value).trim() === '') {
    return 'category is required'
  }
  if (!TASK_CATEGORIES.has(value)) {
    return `category must be one of: ${[...TASK_CATEGORIES].join(', ')}`
  }
  return null
}


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
      SELECT ${TASK_PUBLIC_COLUMNS.split(', ').map(c => 't.' + c).join(', ')}, c.name AS assigned_member_name
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
      // `SELECT e.*` here shipped ochr_events.search_vec on every linked
      // event — measured 27 Aug against a real fixture. The list endpoint in
      // events.js has projected since Pass 5; this sibling did not.
      `SELECT ${EVENT_COLUMNS.prefixed('e')}
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
    const catErr = categoryError(category)
    if (catErr) return res.status(400).json({ error: catErr })
    const orgId  = req.organizationId
    const taskId = id || `task-${Date.now()}`
    const safeMemberId = await validateMember(pool, assigned_member_id, orgId)

    const { rows } = await pool.query(
      `INSERT INTO ochr_tasks (organization_id, id, title, description, category, assigned_to, priority, status, recurring_freq, checklist, due_date, assigned_member_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING ${TASK_PUBLIC_COLUMNS}`,
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

    // EXISTENCE BEFORE VALIDATION, and the order is the point. Validating
    // the body first answered another tenant's PATCH with 400 instead of
    // 404 — telling a caller their input was wrong about a record they are
    // not allowed to know exists. The smoke suite pins 404 here, and it was
    // right to: a tenant boundary should give the same answer whatever the
    // body says.
    const { rows: prev } = await pool.query(
      'SELECT assigned_member_id FROM ochr_tasks WHERE id = $1 AND organization_id = $2',
      [req.params.id, orgId]
    )
    if (!prev.length) return res.status(404).json({ error: 'Not found' })

    const catErr = categoryError(category)
    if (catErr) return res.status(400).json({ error: catErr })
    const prevMemberId = prev[0].assigned_member_id ?? null
    const newMemberId  = await validateMember(pool, assigned_member_id, orgId)

    const { rows } = await pool.query(
      `UPDATE ochr_tasks SET
        title=$1, description=$2, category=$3, assigned_to=$4,
        priority=$5, status=$6, recurring_freq=$7, checklist=$8, due_date=$9,
        assigned_member_id=$10,
        completed_at = CASE WHEN $6 = 'COMPLETED' THEN NOW() ELSE NULL END
       WHERE id = $11 AND organization_id = $12
       RETURNING ${TASK_PUBLIC_COLUMNS}`,
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
       WHERE id = $2 AND organization_id = $3
       RETURNING ${TASK_PUBLIC_COLUMNS}`,
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
      `UPDATE ochr_tasks SET checklist = $1 WHERE id = $2 AND organization_id = $3
         RETURNING ${TASK_PUBLIC_COLUMNS}`,
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
