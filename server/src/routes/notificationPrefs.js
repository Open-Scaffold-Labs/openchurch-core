// Per-user notification preferences. Self-serve — every authenticated
// user manages their own toggles, no admin gate. Viewers included
// because they may still receive task assignments / event roster
// changes that they want to opt out of.
//
// GET   /api/notification-prefs   → merged shape (template defaults
//                                   overlaid with stored rows)
// PATCH /api/notification-prefs   → upsert a single (type, enabled) row
//
// The merged shape returned by GET is what the UI binds against — it
// always knows about every notification type, regardless of whether
// the user has interacted with that type yet.

import { Router } from 'express'
import pool from '../db.js'
import { TEMPLATES, NOTIFICATION_TYPES } from '../notifications/templates.js'
import { monitor } from '../monitoring/index.js'

const router = Router()

// GET /api/notification-prefs
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT notification_type, enabled
         FROM ochr_notification_prefs
        WHERE user_id = $1`,
      [req.user.id]
    )
    const stored = new Map(rows.map(r => [r.notification_type, r.enabled]))

    // Build the merged shape: every template, with the stored value
    // when present and the template default otherwise.
    const prefs = NOTIFICATION_TYPES.map(t => ({
      notification_type: t.notification_type,
      label:             t.label,
      description:       t.description,
      default_enabled:   t.default_enabled,
      enabled:           stored.has(t.notification_type)
                          ? stored.get(t.notification_type)
                          : t.default_enabled,
    }))

    res.json({ prefs })
  } catch (err) {
    monitor.error('notification-prefs.list', err, { userId: req.user?.id })
    res.status(500).json({ error: 'Failed to load notification preferences' })
  }
})

// PATCH /api/notification-prefs
//   body: { notification_type, enabled }
router.patch('/', async (req, res) => {
  const { notification_type, enabled } = req.body ?? {}
  if (!notification_type || !TEMPLATES[notification_type]) {
    return res.status(400).json({ error: 'Unknown notification_type' })
  }
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: '`enabled` must be a boolean' })
  }
  try {
    await pool.query(
      `INSERT INTO ochr_notification_prefs (user_id, notification_type, enabled)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, notification_type)
       DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW()`,
      [req.user.id, notification_type, enabled]
    )
    res.json({ notification_type, enabled })
  } catch (err) {
    monitor.error('notification-prefs.upsert', err, { userId: req.user?.id, notification_type })
    res.status(500).json({ error: 'Failed to save notification preference' })
  }
})

export default router
