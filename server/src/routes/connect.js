// Connect-card admin queue — CC.1.
//
//   GET    /api/connect?status=pending|approved|declined|all → review queue
//   POST   /api/connect/:id/approve  → link/create the member + add to group
//   POST   /api/connect/:id/decline  → mark declined
//   DELETE /api/connect/:id          → remove an interest row
//
// Approval is the only non-trivial path: it resolves the interest to a
// member (an existing client matched by email, else a freshly created
// one), adds them to the requested group if any, and stamps the row.
// All tenant-scoped on organization_id.

import { Router } from 'express'
import pool from '../db.js'
import { monitor } from '../monitoring/index.js'
import { memberByEmail } from '../directory/memberIdentity.js'

const router = Router()

const LIST_STATUSES = new Set(['pending', 'approved', 'declined', 'all'])

// GET /api/connect?status=pending
router.get('/', async (req, res) => {
  const status = String(req.query.status || 'pending')
  if (!LIST_STATUSES.has(status)) {
    return res.status(400).json({ error: 'Invalid status filter' })
  }
  try {
    const params = [req.organizationId]
    let where = 'gi.organization_id = $1'
    if (status !== 'all') {
      params.push(status)
      where += ` AND gi.status = $2`
    }
    const { rows } = await pool.query(
      `SELECT gi.id, gi.group_id, gi.name, gi.email, gi.phone, gi.message,
              gi.status, gi.client_id, gi.created_at, gi.decided_at,
              g.name AS group_name
         FROM ochr_group_interests gi
         LEFT JOIN ochr_groups g ON g.id = gi.group_id
        WHERE ${where}
        ORDER BY gi.created_at DESC`,
      params
    )
    res.json({ interests: rows })
  } catch (err) {
    monitor.error('connect.list', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load interests' })
  }
})

// POST /api/connect/:id/approve
router.post('/:id/approve', async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Invalid id' })
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // Lock the interest row for the duration so a double-click can't
    // approve it twice into two members.
    const { rows: irows } = await client.query(
      `SELECT id, group_id, name, email, phone, status
         FROM ochr_group_interests
        WHERE id = $1 AND organization_id = $2
        FOR UPDATE`,
      [id, req.organizationId]
    )
    const interest = irows[0]
    if (!interest) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Not found' })
    }
    if (interest.status !== 'pending') {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: `Already ${interest.status}` })
    }

    // Resolve to a member: match an existing client by email (within
    // the org), else create one.
    let clientId = null
    if (interest.email) {
      // Same predicate as everywhere else, but on the TRANSACTION client —
      // this read and the insert below must see the same snapshot.
      const match = await memberByEmail(req.organizationId, interest.email, ['id'], client)
      if (match) clientId = match.id
    }
    if (!clientId) {
      const { rows: created } = await client.query(
        `INSERT INTO ochr_clients (organization_id, name, email, phone, role, status)
         VALUES ($1, $2, $3, $4, 'Member', 'active')
         RETURNING id`,
        [req.organizationId, interest.name, interest.email || null, interest.phone || null]
      )
      clientId = created[0].id
    }

    // Add to the requested group if one is still attached. Idempotent
    // via the UNIQUE(group_id, client_id) constraint.
    if (interest.group_id) {
      await client.query(
        `INSERT INTO ochr_group_members (group_id, organization_id, client_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (group_id, client_id) DO NOTHING`,
        [interest.group_id, req.organizationId, clientId]
      )
    }

    const { rows: updated } = await client.query(
      `UPDATE ochr_group_interests
          SET status = 'approved', client_id = $1, decided_at = NOW()
        WHERE id = $2 AND organization_id = $3
        RETURNING id, group_id, name, email, phone, status, client_id, decided_at`,
      [clientId, id, req.organizationId]
    )

    await client.query('COMMIT')
    res.json({ ...updated[0], client_id: clientId })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    monitor.error('connect.approve', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to approve' })
  } finally {
    client.release()
  }
})

// POST /api/connect/:id/decline
router.post('/:id/decline', async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Invalid id' })
  }
  try {
    const { rows } = await pool.query(
      `UPDATE ochr_group_interests
          SET status = 'declined', decided_at = NOW()
        WHERE id = $1 AND organization_id = $2 AND status = 'pending'
        RETURNING id, status, decided_at`,
      [id, req.organizationId]
    )
    if (!rows.length) {
      return res.status(404).json({ error: 'Not found or already decided' })
    }
    res.json(rows[0])
  } catch (err) {
    monitor.error('connect.decline', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to decline' })
  }
})

// DELETE /api/connect/:id
router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Invalid id' })
  }
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM ochr_group_interests WHERE id = $1 AND organization_id = $2',
      [id, req.organizationId]
    )
    if (!rowCount) return res.status(404).json({ error: 'Not found' })
    res.status(204).end()
  } catch (err) {
    monitor.error('connect.delete', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to delete' })
  }
})

export default router
