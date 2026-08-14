// Admin-only operational endpoints for keeping the database tidy.
// Mounted at /api/admin/maintenance behind requireAuth +
// requireRole('admin') in app.js.
//
// Today the only endpoint here is the retention prune. It's
// operator-poked; once Vercel cron lands, the cron config flips it
// from manual to scheduled (1 line in vercel.json).

import { Router } from 'express'
import { pruneOldRecords } from '../services/retention.js'
import { monitor } from '../monitoring/index.js'

const router = Router()

router.post('/retention-prune', async (req, res) => {
  try {
    const result = await pruneOldRecords()
    res.json(result)
  } catch (err) {
    monitor.error('maintenance.retention-prune', err)
    res.status(500).json({ error: 'Retention prune failed' })
  }
})

export default router
