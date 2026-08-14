// Vercel-cron-callable endpoints. Mounted at /api/cron in app.js
// behind requireCronAuth (CRON_SECRET env var match), NOT behind
// requireAuth + requireRole — there's no JWT on a cron invocation.
//
// The same underlying functions back the existing manual-poke
// /api/admin/... endpoints, so flipping cron on/off doesn't change
// how operators trigger these from the UI today.
//
// Vercel cron schedule lives in vercel.json. To activate:
//   1. Set CRON_SECRET on the Vercel project (any random hex string)
//   2. Push — Vercel reads vercel.json and registers the schedule
//   3. Vercel sends Authorization: Bearer ${CRON_SECRET} on each invocation

import { Router } from 'express'
import { requireCronAuth } from '../middleware/cronAuth.js'
import { pruneOldRecords } from '../services/retention.js'
import { enqueueDailyBirthdayReminders } from '../notifications/birthdays.js'
import { processDueNotifications } from '../notifications/scheduler.js'
import { chargeDueRecurringGifts } from '../services/recurringGifts.js'
import { sendWeeklyServingDigests } from '../notifications/servingDigest.js'
import { nudgePendingSwaps } from '../services/swapNudge.js'
import { enqueueSacramentAnniversaryDigests } from '../notifications/sacramentAnniversaries.js'
import { runWeeklyBackupDigest } from '../services/backupDigest.js'
import { monitor } from '../monitoring/index.js'

const router = Router()

router.use(requireCronAuth)

// Vercel Cron invokes these via GET; our smoke tests and the admin
// manual-poke UI use POST. Register both so a real scheduled invocation
// (GET) and a test/operator poke (POST) both hit the same handler.
const cronRoute = (path, handler) => {
  router.get(path, handler)
  router.post(path, handler)
}

cronRoute('/retention-prune', async (req, res) => {
  try {
    const result = await pruneOldRecords()
    res.json(result)
  } catch (err) {
    monitor.error('cron.retention-prune', err)
    res.status(500).json({ error: 'Retention prune failed' })
  }
})

cronRoute('/enqueue-birthdays', async (req, res) => {
  try {
    const result = await enqueueDailyBirthdayReminders()
    res.json(result)
  } catch (err) {
    monitor.error('cron.enqueue-birthdays', err)
    res.status(500).json({ error: 'Birthday enqueue failed' })
  }
})

cronRoute('/drain-notifications', async (req, res) => {
  // Larger batch on the cron path than the admin path — the cron
  // is the actual production drainer; the admin endpoint is for
  // operator pokes.
  const batchSize = 200
  try {
    const result = await processDueNotifications({ batchSize })
    res.json(result)
  } catch (err) {
    monitor.error('cron.drain-notifications', err)
    res.status(500).json({ error: 'Drain failed' })
  }
})

cronRoute('/charge-recurring', async (req, res) => {
  try {
    const result = await chargeDueRecurringGifts()
    res.json(result)
  } catch (err) {
    monitor.error('cron.charge-recurring', err)
    res.status(500).json({ error: 'Recurring charge run failed' })
  }
})

cronRoute('/weekly-serving-digest', async (req, res) => {
  try {
    const result = await sendWeeklyServingDigests()
    res.json(result)
  } catch (err) {
    monitor.error('cron.weekly-serving-digest', err)
    res.status(500).json({ error: 'Weekly digest run failed' })
  }
})

cronRoute('/enqueue-sacrament-anniversaries', async (req, res) => {
  try {
    const result = await enqueueSacramentAnniversaryDigests()
    res.json(result)
  } catch (err) {
    monitor.error('cron.enqueue-sacrament-anniversaries', err)
    res.status(500).json({ error: 'Sacrament anniversary enqueue failed' })
  }
})

cronRoute('/backup-digest', async (req, res) => {
  try {
    const result = await runWeeklyBackupDigest()
    res.json(result)
  } catch (err) {
    monitor.error('cron.backup-digest', err)
    res.status(500).json({ error: 'Backup digest failed' })
  }
})

cronRoute('/nudge-swaps', async (req, res) => {
  try {
    const result = await nudgePendingSwaps()
    res.json(result)
  } catch (err) {
    monitor.error('cron.nudge-swaps', err)
    res.status(500).json({ error: 'Swap nudge run failed' })
  }
})

export default router
