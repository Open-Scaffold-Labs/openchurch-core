// Operational endpoints for the notification queue, with two DIFFERENT
// authorization scopes.
//
//   GET  /scheduled, /log  — tenant-admin. Scoped to the caller's own
//     organization_id: what is queued / what went out for THIS parish.
//
//   POST /enqueue-birthdays, /drain — GLOBAL operator actions. The services
//     they invoke are NOT tenant-scoped: enqueue walks every organization,
//     and drain claims and sends any organization's pending mail. An ordinary
//     parish or diocesan admin must not reach across tenants that way, so
//     these two are gated by requireSuperAdmin — the env-identified operator
//     boundary, fail-closed to a route-hiding 404 — on top of the
//     requireAuth + requireRole('admin') the router is mounted behind in
//     app.js (OC-OP-1 / OC-OP-2 containment). The same underlying functions
//     also run behind CRON_SECRET on /api/cron/* for the scheduled path.

import { Router } from 'express'
import pool from '../db.js'
import { processDueNotifications } from '../notifications/scheduler.js'
import { enqueueDailyBirthdayReminders } from '../notifications/birthdays.js'
import { requireSuperAdmin } from '../middleware/superAdmin.js'
import { monitor } from '../monitoring/index.js'

const router = Router()

// GET /api/admin/notifications/scheduled — upcoming queued notifications
// for this org (NV.1). "What's about to go out" — e.g. serving reminders
// waiting on their send_at.
router.get('/scheduled', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, recipient_email, notification_type, send_at, status, created_at
         FROM ochr_scheduled_notifications
        WHERE organization_id = $1 AND status = 'pending'
        ORDER BY send_at ASC
        LIMIT 100`,
      [req.organizationId]
    )
    res.json({ scheduled: rows })
  } catch (err) {
    monitor.error('notifications-admin.scheduled', err)
    res.status(500).json({ error: 'Failed to load scheduled notifications' })
  }
})

// GET /api/admin/notifications/log — recent dispatched notifications for
// this org (NV.1). "What went out" — type, recipient, status.
router.get('/log', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, recipient_email, notification_type, channel, subject, status, error, created_at
         FROM ochr_notification_log
        WHERE organization_id = $1
        ORDER BY created_at DESC
        LIMIT 100`,
      [req.organizationId]
    )
    res.json({ log: rows })
  } catch (err) {
    monitor.error('notifications-admin.log', err)
    res.status(500).json({ error: 'Failed to load notification log' })
  }
})

// POST /api/admin/notifications/enqueue-birthdays
//   Walks every org once, schedules one member_birthday /
//   member_anniversary notification per admin per match for tomorrow.
//   Vercel cron will hit this once a day when wired; manual today.
//
// Returns { orgs_scanned, birthdays_enqueued, anniversaries_enqueued }.
// Global (walks every org) → requireSuperAdmin. See header (OC-OP-1).
router.post('/enqueue-birthdays', requireSuperAdmin, async (req, res) => {
  try {
    const result = await enqueueDailyBirthdayReminders()
    res.json(result)
  } catch (err) {
    monitor.error('notifications-admin.enqueue-birthdays', err)
    res.status(500).json({ error: 'Birthday enqueue failed' })
  }
})

// Global (claims/sends any org's pending) → requireSuperAdmin. See header (OC-OP-2).
router.post('/drain', requireSuperAdmin, async (req, res) => {
  const requested = Number(req.query.batchSize)
  const batchSize = Number.isInteger(requested) && requested > 0 && requested <= 500
    ? requested
    : 50
  try {
    const result = await processDueNotifications({ batchSize })
    res.json(result)
  } catch (err) {
    monitor.error('notifications-admin.drain', err)
    res.status(500).json({ error: 'Drain failed' })
  }
})

export default router
