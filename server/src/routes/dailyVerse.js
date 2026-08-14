// Daily verse — read-only route that hands back today's cached verse,
// or a freshly-randomized verse when ?random=true (for the refresh
// button on the Dashboard card).
//
// Mounted behind requireAuth in app.js. The verse is the same for
// every user on a given day, so this isn't tenant-scoped — but
// requiring auth keeps bible-api.com costs from being a free
// resource for unauthenticated traffic.

import { Router } from 'express'
import { getTodaysVerse, fetchRandomVerse } from '../services/dailyVerse.js'
import { monitor } from '../monitoring/index.js'

const router = Router()

router.get('/', async (req, res) => {
  try {
    const verse = req.query.random === 'true'
      ? await fetchRandomVerse()
      : await getTodaysVerse()
    res.json(verse)
  } catch (err) {
    // getTodaysVerse / fetchRandomVerse already wrap their failures
    // and return the fallback verse, so this catch is belt-and-
    // suspenders. If we get here something genuinely unexpected
    // happened — return the fallback shape rather than a 500 so the
    // Dashboard always has something to render.
    monitor.error('daily-verse.handler', err)
    res.json({
      text:      'Be still, and know that I am God.',
      reference: 'Psalm 46:10',
    })
  }
})

export default router
