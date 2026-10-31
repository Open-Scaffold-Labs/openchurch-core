// SP-079. Display name for roles that print the order of worship.
//
// GET /api/organization stays admin-only: it carries letterhead, EIN,
// and the signatory. Staff who may print were refused that whole block,
// so the sheet said the parish name did not load and a reload could not
// fix it. This read returns the name and nothing else.
//
// The organization id is the caller's, from the session. A query or body
// organization id is ignored.

import { Router } from 'express'
import pool from '../db.js'
import { monitor } from '../monitoring/index.js'

const router = Router()

router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT name
         FROM ochr_organizations
        WHERE id = $1`,
      [req.organizationId]
    )
    if (!rows.length) return res.status(404).json({ error: 'Organization not found' })
    const name = rows[0].name
    if (typeof name !== 'string' || name.trim() === '') {
      return res.status(404).json({ error: 'Organization not found' })
    }
    // R346-1. This URL is the same for every parish, and the response
    // carries the caller's name. private,max-age would let one browser
    // profile reuse the previous parish's name after a login switch.
    // Keep the API no-store policy; do not replace it.
    res.set('Cache-Control', 'no-store')
    res.json({ name })
  } catch (err) {
    monitor.error('organization.displayName', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load the parish name' })
  }
})

export default router
