// Tradition-specific reporting (RPT.1).
//
//   GET /api/reports                          → what this tradition can run
//   GET /api/reports/:key?start=&end=         → run it
//   GET /api/reports/:key.csv?start=&end=     → the same, as a file
//
// Which reports exist depends on the org's tradition, because reports do.
// A Catholic parish has no Parochial Report and should not be offered one;
// what it files is the Status Animarum, to its own chancery, on a diocesan
// deadline — and until somebody has actually seen one, we do not have a
// definition for it and will not invent one.

import { Router } from 'express'
import { reportsForTradition, findReport } from '../reporting/definitions.js'
import { runReport, toCSV } from '../reporting/run.js'
import { traditionFor } from '../traditions/context.js'
import { monitor } from '../monitoring/index.js'

const router = Router()
const ISO = /^\d{4}-\d{2}-\d{2}$/

// Default to the calendar year, which is the period every annual church
// report we know of is scoped to.
function period(req) {
  const now = new Date()
  const year = now.getUTCFullYear()
  const start = ISO.test(req.query.start ?? '') ? req.query.start : `${year}-01-01`
  const end   = ISO.test(req.query.end ?? '')   ? req.query.end   : `${year}-12-31`
  if (end < start) return { error: 'end must not precede start' }
  return { start, end }
}

// GET /api/reports
router.get('/', async (req, res) => {
  try {
    const tradition = await traditionFor(req.organizationId)
    const available = reportsForTradition(tradition).map(r => ({
      key: r.key, title: r.title, subtitle: r.subtitle, period_hint: r.periodHint,
      field_count: r.fields.length,
      unverified_count: r.fields.filter(f => f.requirement !== 'verified').length,
    }))
    res.json({
      tradition,
      reports: available,
      // An empty list is an answer, not a gap. Say which tradition it is
      // an answer for, so a Catholic parish is not left wondering whether
      // the page is broken.
      note: available.length === 0
        ? `No report definitions exist for the ${tradition} tradition yet. We will not invent one — a report has to be read before it can be built.`
        : null,
    })
  } catch (err) {
    monitor.error('reports.list', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load reports' })
  }
})

async function handleRun(req, res, asCsv) {
  const key = String(req.params.key || '').replace(/\.csv$/, '')
  const p = period(req)
  if (p.error) return res.status(400).json({ error: p.error })

  try {
    const tradition = await traditionFor(req.organizationId)
    const report = findReport(key, tradition)
    if (!report) {
      return res.status(404).json({
        error: `No report "${key}" for the ${tradition} tradition`,
      })
    }
    const result = await runReport(report, { orgId: req.organizationId, start: p.start, end: p.end })

    if (asCsv) {
      res.set('Content-Type', 'text/csv; charset=utf-8')
      res.set('Content-Disposition', `attachment; filename="${key}-${p.start}-to-${p.end}.csv"`)
      return res.send(toCSV(result))
    }
    res.json({ ...result, tradition })
  } catch (err) {
    monitor.error('reports.run', err, { orgId: req.organizationId, key })
    res.status(500).json({ error: 'Failed to run report' })
  }
}

router.get('/:key.csv', (req, res) => handleRun(req, res, true))
router.get('/:key',     (req, res) => handleRun(req, res, false))

export default router
