import { Router } from 'express'
import pool from '../db.js'
import { monitor } from '../monitoring/index.js'
import { protectedDelete } from '../vault/deleteRoute.js'

// Anchor 4 / A4.1 — Groups CRUD + member management.
//
// Flat model — each group has a name, category, optional description,
// optional designated leader, and a member list. Members are roster
// clients (ochr_clients), not login users, so adding a member to a
// group grants no auth — it just associates them with the roster.

const router = Router()

const CATEGORIES = new Set(['ministry', 'life_group', 'small_group', 'committee'])

// Normalize + validate a client-id list against the caller's org.
// Returns the de-duped list in the caller's order, dropping unknown
// ids. Empty input returns []; never throws.
async function validClientIds(client, ids, orgId) {
  const seen = new Set()
  const out  = []
  for (const v of (Array.isArray(ids) ? ids : [])) {
    const n = Number(v)
    if (Number.isInteger(n) && n > 0 && !seen.has(n)) { seen.add(n); out.push(n) }
  }
  if (out.length === 0) return []
  const { rows } = await client.query(
    `SELECT id FROM ochr_clients
      WHERE id = ANY($1::int[]) AND organization_id = $2`,
    [out, orgId]
  )
  const valid = new Set(rows.map(r => r.id))
  return out.filter(id => valid.has(id))
}

// GET /api/groups
//   Org-scoped list with member counts and leader name. One query;
//   member counts use a correlated subquery rather than a GROUP BY
//   so the leader join stays simple.
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT g.id, g.name, g.category, g.description, g.leader_client_id,
              g.created_at, g.updated_at,
              lc.name AS leader_name,
              (SELECT COUNT(*)::int FROM ochr_group_members gm
                WHERE gm.group_id = g.id) AS member_count
         FROM ochr_groups g
         LEFT JOIN ochr_clients lc ON lc.id = g.leader_client_id
        WHERE g.organization_id = $1
        ORDER BY g.name ASC`,
      [req.organizationId]
    )
    res.json({ groups: rows })
  } catch (err) {
    monitor.error('groups.list', err)
    res.status(500).json({ error: 'Failed to list groups' })
  }
})

// GET /api/groups/:id
//   Single group with its full member roster.
router.get('/:id', async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id < 1)
    return res.status(400).json({ error: 'Invalid group id' })
  try {
    const { rows: groups } = await pool.query(
      `SELECT g.id, g.name, g.category, g.description, g.leader_client_id,
              g.created_at, g.updated_at,
              lc.name AS leader_name
         FROM ochr_groups g
         LEFT JOIN ochr_clients lc ON lc.id = g.leader_client_id
        WHERE g.id = $1 AND g.organization_id = $2`,
      [id, req.organizationId]
    )
    if (groups.length === 0)
      return res.status(404).json({ error: 'Group not found' })

    const { rows: members } = await pool.query(
      `SELECT gm.id AS membership_id, gm.client_id, gm.joined_at,
              c.name, c.role
         FROM ochr_group_members gm
         JOIN ochr_clients c ON c.id = gm.client_id
        WHERE gm.group_id = $1 AND c.organization_id = $2
        ORDER BY c.name ASC`,
      [id, req.organizationId]
    )
    res.json({ ...groups[0], members })
  } catch (err) {
    monitor.error('groups.get', err)
    res.status(500).json({ error: 'Failed to load group' })
  }
})

// POST /api/groups
//   Body: { name, category?, description?, leader_client_id?, member_ids?: [int] }
//   The leader is automatically added to the member roster if not
//   already in member_ids — admins shouldn't have to list themselves
//   twice when assembling the initial group.
router.post('/', async (req, res) => {
  const {
    name,
    category    = 'ministry',
    description = null,
    leader_client_id = null,
    member_ids  = [],
  } = req.body ?? {}

  if (typeof name !== 'string' || !name.trim())
    return res.status(400).json({ error: 'name is required' })
  if (!CATEGORIES.has(category))
    return res.status(400).json({ error: `category must be one of: ${Array.from(CATEGORIES).join(', ')}` })

  const leaderId = leader_client_id === null || leader_client_id === undefined
    ? null
    : Number(leader_client_id)
  if (leaderId !== null && (!Number.isInteger(leaderId) || leaderId < 1))
    return res.status(400).json({ error: 'Invalid leader_client_id' })

  const c = await pool.connect()
  try {
    await c.query('BEGIN')

    // Validate leader belongs to the org.
    if (leaderId !== null) {
      const { rows } = await c.query(
        `SELECT id FROM ochr_clients WHERE id = $1 AND organization_id = $2`,
        [leaderId, req.organizationId]
      )
      if (rows.length === 0) {
        await c.query('ROLLBACK')
        return res.status(400).json({ error: 'leader_client_id not found in this org' })
      }
    }

    const memberIds = await validClientIds(c, member_ids, req.organizationId)

    const { rows: created } = await c.query(
      `INSERT INTO ochr_groups
         (organization_id, name, category, description, leader_client_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, category, description, leader_client_id, created_at, updated_at`,
      [req.organizationId, name.trim(), category, description, leaderId]
    )
    const group = created[0]

    // Auto-add the leader to the roster + every valid member.
    const toInsert = new Set(memberIds)
    if (leaderId !== null) toInsert.add(leaderId)
    for (const cid of toInsert) {
      await c.query(
        `INSERT INTO ochr_group_members (group_id, organization_id, client_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (group_id, client_id) DO NOTHING`,
        [group.id, req.organizationId, cid]
      )
    }

    await c.query('COMMIT')
    res.status(201).json(group)
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {})
    monitor.error('groups.create', err)
    res.status(500).json({ error: 'Failed to create group' })
  } finally {
    c.release()
  }
})

// PATCH /api/groups/:id
//   Body: any of { name, category, description, leader_client_id }
//   Member-roster changes go through the dedicated /members endpoints.
router.patch('/:id', async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id < 1)
    return res.status(400).json({ error: 'Invalid group id' })

  const { name, category, description, leader_client_id } = req.body ?? {}
  const setClauses = []
  const values     = []
  let p = 1

  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim())
      return res.status(400).json({ error: 'name must be a non-empty string' })
    setClauses.push(`name = $${p++}`); values.push(name.trim())
  }
  if (category !== undefined) {
    if (!CATEGORIES.has(category))
      return res.status(400).json({ error: `category must be one of: ${Array.from(CATEGORIES).join(', ')}` })
    setClauses.push(`category = $${p++}`); values.push(category)
  }
  if (description !== undefined) {
    setClauses.push(`description = $${p++}`); values.push(description)
  }
  if (leader_client_id !== undefined) {
    const lid = leader_client_id === null ? null : Number(leader_client_id)
    if (lid !== null && (!Number.isInteger(lid) || lid < 1))
      return res.status(400).json({ error: 'Invalid leader_client_id' })
    if (lid !== null) {
      const { rows } = await pool.query(
        `SELECT id FROM ochr_clients WHERE id = $1 AND organization_id = $2`,
        [lid, req.organizationId]
      )
      if (rows.length === 0)
        return res.status(400).json({ error: 'leader_client_id not found in this org' })
    }
    setClauses.push(`leader_client_id = $${p++}`); values.push(lid)
  }
  if (setClauses.length === 0)
    return res.status(400).json({ error: 'Nothing to update' })
  setClauses.push(`updated_at = NOW()`)
  values.push(id, req.organizationId)

  try {
    const { rows } = await pool.query(
      `UPDATE ochr_groups SET ${setClauses.join(', ')}
        WHERE id = $${p++} AND organization_id = $${p++}
        RETURNING id, name, category, description, leader_client_id, updated_at`,
      values
    )
    if (rows.length === 0)
      return res.status(404).json({ error: 'Group not found' })
    res.json(rows[0])
  } catch (err) {
    monitor.error('groups.update', err)
    res.status(500).json({ error: 'Failed to update group' })
  }
})

// DELETE /api/groups/:id
//   ON DELETE CASCADE on ochr_group_members takes the roster with it —
//   which is why this is protected by the Continuity Vault. A restore
//   brings the roster back, not just the group's name.
router.delete('/:id', protectedDelete('group', {
  notFound: 'Group not found', failure: 'Failed to delete group',
}))

// POST /api/groups/:id/members
//   Body: { client_id }
//   Tenant guards: the group AND the client must belong to req.organizationId.
router.post('/:id/members', async (req, res) => {
  const groupId  = Number(req.params.id)
  const clientId = Number(req.body?.client_id)
  if (!Number.isInteger(groupId) || groupId < 1)
    return res.status(400).json({ error: 'Invalid group id' })
  if (!Number.isInteger(clientId) || clientId < 1)
    return res.status(400).json({ error: 'client_id is required' })

  try {
    const { rows: groups } = await pool.query(
      `SELECT id FROM ochr_groups WHERE id = $1 AND organization_id = $2`,
      [groupId, req.organizationId]
    )
    if (groups.length === 0)
      return res.status(404).json({ error: 'Group not found' })

    const { rows: clients } = await pool.query(
      `SELECT id FROM ochr_clients WHERE id = $1 AND organization_id = $2`,
      [clientId, req.organizationId]
    )
    if (clients.length === 0)
      return res.status(404).json({ error: 'Member not found in this org' })

    const { rows } = await pool.query(
      `INSERT INTO ochr_group_members (group_id, organization_id, client_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (group_id, client_id) DO NOTHING
       RETURNING id, group_id, client_id, joined_at`,
      [groupId, req.organizationId, clientId]
    )
    if (rows.length === 0)
      return res.status(409).json({ error: 'Already a member of this group' })
    res.status(201).json(rows[0])
  } catch (err) {
    monitor.error('groups.addMember', err)
    res.status(500).json({ error: 'Failed to add member' })
  }
})

// DELETE /api/groups/:id/members/:client_id
//   Tenant scoping via subquery on ochr_groups — the membership row
//   itself doesn't carry organization_id.
router.delete('/:id/members/:client_id', async (req, res) => {
  const groupId  = Number(req.params.id)
  const clientId = Number(req.params.client_id)
  if (!Number.isInteger(groupId)  || groupId  < 1 ||
      !Number.isInteger(clientId) || clientId < 1)
    return res.status(400).json({ error: 'Invalid ids' })
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM ochr_group_members
        WHERE group_id  = $1
          AND client_id = $2
          AND group_id IN (SELECT id FROM ochr_groups WHERE organization_id = $3)`,
      [groupId, clientId, req.organizationId]
    )
    if (rowCount === 0)
      return res.status(404).json({ error: 'Membership not found' })
    res.status(204).end()
  } catch (err) {
    monitor.error('groups.removeMember', err)
    res.status(500).json({ error: 'Failed to remove member' })
  }
})

export default router
