import { Router } from 'express'
import pool from '../db.js'
import { requireIntParam } from '../utils/params.js'
import { VIEWER_OPTIONS } from '../middleware/viewerScope.js'

const router = Router()

// GET /api/notifications
router.get('/', async (req, res) => {
  // Jarvis R9: this is the parish's staff activity feed (task and event
  // assignments, with titles and member names), not a per-login inbox.
  // Viewers may not read Events or Daily Tasks (VIEWER_OPTIONS.eventsTasks),
  // so they get an empty bell rather than those titles. Flip that option
  // and the feed opens with the pages it describes.
  if (req.user?.role === 'viewer' && !VIEWER_OPTIONS.eventsTasks) return res.json([])
  try {
    const { rows } = await pool.query(`
      SELECT n.*, c.name AS member_name
      FROM ochr_notifications n
      LEFT JOIN ochr_clients c ON n.member_id = c.id
      WHERE n.organization_id = $1
      ORDER BY n.created_at DESC
      LIMIT 50
    `, [req.organizationId])
    res.json(rows)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to load notifications' })
  }
})

// PATCH /api/notifications/read-all
router.patch('/read-all', async (req, res) => {
  try {
    await pool.query(
      'UPDATE ochr_notifications SET read = TRUE WHERE organization_id = $1',
      [req.organizationId]
    )
    res.status(204).end()
  } catch (err) {
    res.status(500).json({ error: 'Failed to mark all read' })
  }
})

// PATCH /api/notifications/:id/read
router.patch('/:id/read', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    await pool.query(
      'UPDATE ochr_notifications SET read = TRUE WHERE id = $1 AND organization_id = $2',
      [id, req.organizationId]
    )
    res.status(204).end()
  } catch (err) {
    res.status(500).json({ error: 'Failed to mark read' })
  }
})

export default router
