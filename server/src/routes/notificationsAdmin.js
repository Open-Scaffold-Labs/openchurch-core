// Admin-only operational endpoints for the notification queue.
//
// POST /api/admin/notifications/drain
//   Picks up to ?batchSize= due rows from ochr_scheduled_notifications,
//   runs each through notify() via the scheduler, and returns counts.
//   Manual today; once Vercel cron lands, the cron config flips this
//   from operator-poked to scheduled (1-5 minute interval).
//
// Mounted under requireRole('admin') in app.js so non-admins can't
// trigger an unbounded drain.

import { Router } from 'express'
import pool from '../db.js'
import { processDueNotifications } from '../notifications/scheduler.js'
import { enqueueDailyBirthdayReminders } from '../notifications/birthdays.js'
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
router.post('/enqueue-birthdays', async (req, res) => {
  try {
    const result = await enqueueDailyBirthdayReminders()
    res.json(result)
  } catch (err) {
    monitor.error('notifications-admin.enqueue-birthdays', err)
    res.status(500).json({ error: 'Birthday enqueue failed' })
  }
})

router.post('/drain', async (req, res) => {
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
