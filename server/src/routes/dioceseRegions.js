// Deaneries and regions (PILOT.1).
//
// `ochr_diocese_regions` has existed since migration 074, and until now
// nothing could write to it. Parish Care joined it on every query, the
// parish record displayed it, the care brief printed it — against a table
// no route could populate. So every parish in every diocese has had a null
// deanery since the day the column shipped, and the feature looked like it
// worked because a LEFT JOIN against an empty table returns null rather
// than an error.
//
// A deanery is a name and nothing else. It carries no policy, no
// permissions, no roll-up of its own, and deliberately no comparison
// between the parishes inside it — grouping parishes is how a ranking gets
// built by accident, so this groups them for FINDING, and for nothing else.
//
// Retiring rather than deleting: a region a parish still belongs to cannot
// simply vanish, and the composite FK in 074 clears only `region_id` on
// delete. Retirement keeps the name readable in an old care brief while
// removing it from the pickers.

import { Router } from 'express'
import pool from '../db.js'
import { monitor } from '../monitoring/index.js'
import { requireIntParam } from '../utils/params.js'

const router = Router()

const name = (v) => {
  const s = typeof v === 'string' ? v.trim() : ''
  return s.length >= 2 && s.length <= 120 ? s : null
}

// GET /api/diocese/regions — with a count, so an empty deanery is visible
// as an empty deanery rather than as an absence.
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.id, r.name, r.created_at,
              (SELECT count(*)::int FROM ochr_diocese_affiliations a
                WHERE a.region_id = r.id AND a.diocese_org_id = $1
                  AND a.status IN ('active', 'suspended')) AS parish_count
         FROM ochr_diocese_regions r
        WHERE r.diocese_org_id = $1
        ORDER BY r.name`,
      [req.organizationId]
    )
    res.json({ regions: rows })
  } catch (err) {
    monitor.error('regions.list', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load deaneries' })
  }
})

// POST /api/diocese/regions — body: { name }
router.post('/', async (req, res) => {
  const n = name(req.body?.name)
  if (!n) return res.status(400).json({ error: 'A deanery needs a name of at least two characters' })
  try {
    const { rows } = await pool.query(
      `INSERT INTO ochr_diocese_regions (diocese_org_id, name) VALUES ($1, $2)
         RETURNING id, name, created_at`,
      [req.organizationId, n]
    )
    res.status(201).json({ region: { ...rows[0], parish_count: 0 } })
  } catch (err) {
    // The unique key is (diocese_org_id, name), so two dioceses may each
    // have a "Northern Deanery" and neither is told about the other.
    if (err?.code === '23505') {
      return res.status(409).json({ error: `There is already a deanery called “${n}”` })
    }
    monitor.error('regions.create', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to add the deanery' })
  }
})

// PATCH /api/diocese/regions/:id — body: { name }
router.patch('/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  const n = name(req.body?.name)
  if (!n) return res.status(400).json({ error: 'A deanery needs a name of at least two characters' })
  try {
    const { rows } = await pool.query(
      `UPDATE ochr_diocese_regions SET name = $1
        WHERE id = $2 AND diocese_org_id = $3
        RETURNING id, name, created_at`,
      [n, id, req.organizationId]
    )
    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    res.json({ region: rows[0] })
  } catch (err) {
    if (err?.code === '23505') {
      return res.status(409).json({ error: `There is already a deanery called “${n}”` })
    }
    monitor.error('regions.rename', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to rename the deanery' })
  }
})

// DELETE /api/diocese/regions/:id — refuses while parishes are in it.
//
// Refusing rather than cascading, for the same reason the register refuses
// a delete: the alternative silently detaches every parish in the deanery
// and nobody finds out until a brief prints without one. The response names
// the count so the next step is obvious.
router.delete('/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    const { rows: used } = await pool.query(
      `SELECT count(*)::int AS n FROM ochr_diocese_affiliations
        WHERE region_id = $1 AND diocese_org_id = $2 AND status IN ('active', 'suspended')`,
      [id, req.organizationId]
    )
    const n = used[0]?.n ?? 0
    if (n > 0) {
      return res.status(409).json({
        error: n === 1
          ? 'One parish is still in this deanery. Move it first, and then this can go.'
          : `${n} parishes are still in this deanery. Move them first, and then this can go.`,
        parish_count: n,
      })
    }
    const { rowCount } = await pool.query(
      `DELETE FROM ochr_diocese_regions WHERE id = $1 AND diocese_org_id = $2`,
      [id, req.organizationId]
    )
    if (!rowCount) return res.status(404).json({ error: 'Not found' })
    res.status(204).end()
  } catch (err) {
    monitor.error('regions.delete', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to remove the deanery' })
  }
})

// PATCH /api/diocese/regions/assign — body: { parish_org_id, region_id|null }
//
// On the region router rather than the parish one because it is a fact
// about diocesan structure, not about the parish: a parish does not know or
// care which deanery its diocese files it under, and nothing about this
// reaches the parish's own app.
router.patch('/assign/:parishOrgId', async (req, res) => {
  const parishOrgId = Number(req.params.parishOrgId)
  if (!Number.isInteger(parishOrgId)) return res.status(400).json({ error: 'Invalid parish' })
  const raw = req.body?.region_id
  const regionId = raw === null || raw === undefined || raw === '' ? null : Number(raw)
  if (regionId !== null && !Number.isInteger(regionId)) {
    return res.status(400).json({ error: 'region_id must be a deanery id, or null to clear it' })
  }
  try {
    // A deanery from another diocese must not be assignable, and the
    // composite FK would refuse it anyway — this turns a 500 into a
    // sentence.
    if (regionId !== null) {
      const { rows } = await pool.query(
        `SELECT 1 FROM ochr_diocese_regions WHERE id = $1 AND diocese_org_id = $2`,
        [regionId, req.organizationId])
      if (!rows.length) return res.status(400).json({ error: 'That deanery is not this diocese’s' })
    }
    const { rows } = await pool.query(
      `UPDATE ochr_diocese_affiliations SET region_id = $1, updated_at = NOW()
        WHERE parish_org_id = $2 AND diocese_org_id = $3
          AND status IN ('active', 'suspended')
        RETURNING id, region_id`,
      [regionId, parishOrgId, req.organizationId]
    )
    if (!rows.length) return res.status(404).json({ error: 'That parish is not affiliated with this diocese' })
    res.json({ affiliation: rows[0] })
  } catch (err) {
    monitor.error('regions.assign', err, { orgId: req.organizationId, parishOrgId })
    res.status(500).json({ error: 'Failed to move the parish' })
  }
})

export default router
