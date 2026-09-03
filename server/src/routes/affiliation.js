// Parish-side affiliation routes (DIO.1). The parish's half of the
// diocese covenant — surfaced as a small panel in Settings, not a tab.
//
//   GET  /api/affiliation          → my org's live affiliation (or none)
//   POST /api/affiliation/accept   → accept the pending invite { grant_level }
//   POST /api/affiliation/decline  → decline the pending invite
//   PATCH /api/affiliation/grant   → change grant level while active
//   POST /api/affiliation/leave    → end an active/suspended affiliation
//   GET  /api/affiliation/standing → where we stand with the diocese (DIO.6)
//
// Mounted with gateMutations('admin'): staff/viewers can see the
// affiliation state; only an admin can change the org's relationship
// with its diocese. A parish has at most one live affiliation (partial
// unique index in 058), so the write routes operate on "my org's live
// row" rather than taking an id — nothing to enumerate, nothing to leak.

import { Router } from 'express'
import pool from '../db.js'
import { monitor } from '../monitoring/index.js'
import { standingFor } from '../affiliation/standing.js'

const router = Router()

const LIVE = ['invited', 'active', 'suspended']

const MY_AFFILIATION = `
  SELECT a.id, a.status, a.grant_level, a.accepted_at, a.created_at,
         d.name AS diocese_name, d.slug AS diocese_slug
    FROM ochr_diocese_affiliations a
    JOIN ochr_organizations d ON d.id = a.diocese_org_id
   WHERE a.parish_org_id = $1 AND a.status = ANY($2)
   ORDER BY a.created_at DESC
   LIMIT 1
`

async function liveRow(orgId) {
  const { rows } = await pool.query(MY_AFFILIATION, [orgId, LIVE])
  return rows[0] ?? null
}

// GET /api/affiliation
router.get('/', async (req, res) => {
  try {
    res.json({ affiliation: await liveRow(req.organizationId) })
  } catch (err) {
    monitor.error('affiliation.get', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load the diocese affiliation' })
  }
})

// GET /api/affiliation/standing (DIO.6) — the trickle-down.
//
// Deliberately NOT under /:id. A parish has at most one live affiliation,
// so there is no id to pass and therefore nothing to enumerate. The
// diocese is read from the parish's own live row, never from the request.
//
// An unaffiliated parish gets an empty standing and a 200, not a 404: "you
// are not affiliated" is a true and useful answer, and an error would make
// the ordinary case look like a fault.
router.get('/standing', async (req, res) => {
  try {
    const aff = await liveRow(req.organizationId)
    if (!aff || aff.status !== 'active') {
      return res.json({ affiliation: aff, standing: null })
    }
    const { rows } = await pool.query(
      `SELECT diocese_org_id FROM ochr_diocese_affiliations WHERE id = $1`, [aff.id])
    const dioceseOrgId = rows[0]?.diocese_org_id
    if (!dioceseOrgId) return res.json({ affiliation: aff, standing: null })

    res.json({
      affiliation: aff,
      standing: await standingFor(req.organizationId, dioceseOrgId),
    })
  } catch (err) {
    monitor.error('affiliation.standing', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load where things stand with the diocese' })
  }
})

// POST /api/affiliation/accept — body: { grant_level }
router.post('/accept', async (req, res) => {
  const grant = req.body?.grant_level
  if (!['summary', 'detail'].includes(grant)) {
    return res.status(400).json({ error: "grant_level must be 'summary' or 'detail'" })
  }
  try {
    const { rows } = await pool.query(
      `UPDATE ochr_diocese_affiliations
          SET status = 'active', grant_level = $1, accepted_by = $2,
              accepted_at = NOW(), updated_at = NOW()
        WHERE parish_org_id = $3 AND status = 'invited'
        RETURNING id`,
      [grant, req.user?.id ?? null, req.organizationId]
    )
    if (!rows.length) return res.status(404).json({ error: 'No pending diocese invitation to accept' })
    res.json({ affiliation: await liveRow(req.organizationId) })
  } catch (err) {
    monitor.error('affiliation.accept', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to accept the invitation' })
  }
})

// POST /api/affiliation/decline
router.post('/decline', async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `UPDATE ochr_diocese_affiliations
          SET status = 'ended', updated_at = NOW()
        WHERE parish_org_id = $1 AND status = 'invited'`,
      [req.organizationId]
    )
    if (!rowCount) return res.status(404).json({ error: 'No pending diocese invitation to decline' })
    res.json({ affiliation: null })
  } catch (err) {
    monitor.error('affiliation.decline', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to decline the invitation' })
  }
})

// PATCH /api/affiliation/grant — body: { grant_level }
router.patch('/grant', async (req, res) => {
  const grant = req.body?.grant_level
  if (!['summary', 'detail'].includes(grant)) {
    return res.status(400).json({ error: "grant_level must be 'summary' or 'detail'" })
  }
  try {
    const { rowCount } = await pool.query(
      `UPDATE ochr_diocese_affiliations
          SET grant_level = $1, updated_at = NOW()
        WHERE parish_org_id = $2 AND status = 'active'`,
      [grant, req.organizationId]
    )
    if (!rowCount) return res.status(404).json({ error: 'No active diocese affiliation' })
    res.json({ affiliation: await liveRow(req.organizationId) })
  } catch (err) {
    monitor.error('affiliation.grant', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to update the grant level' })
  }
})

// POST /api/affiliation/leave
router.post('/leave', async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `UPDATE ochr_diocese_affiliations
          SET status = 'ended', updated_at = NOW()
        WHERE parish_org_id = $1 AND status IN ('active', 'suspended')`,
      [req.organizationId]
    )
    if (!rowCount) return res.status(404).json({ error: 'No diocese affiliation to leave' })
    res.json({ affiliation: null })
  } catch (err) {
    monitor.error('affiliation.leave', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to leave the diocese' })
  }
})

export default router
