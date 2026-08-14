// Team-management endpoints. Admin-only — every route under this
// router runs requireRole('admin') applied at the app.js mount.
//
// "Users" here are OpenChurch login accounts (rows in ochr_users) —
// distinct from "members" (ochr_clients), which are the church's
// parishioners/volunteers/staff list.

import { Router } from 'express'
import bcrypt from 'bcryptjs'
import pool from '../db.js'
import { ROLES } from '../middleware/auth.js'
import { sendEmail } from '../email/send.js'
import { welcomeEmail } from '../email/templates.js'
import { requireIntParam } from '../utils/params.js'

const router = Router()

const MIN_PASSWORD = 8

function isEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim())
}

// Shape returned to the client. Never includes password_hash; only the
// fields the team page needs.
function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, created_at: u.created_at }
}

// Counts admins in the org *other than* the given user id. Used by
// last-admin protection — if this returns 0, the operation would
// leave the org without any admin and must be rejected.
async function otherAdminCount(orgId, excludeUserId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM ochr_users
      WHERE organization_id = $1 AND role = 'admin' AND id <> $2`,
    [orgId, excludeUserId]
  )
  return rows[0].n
}

// GET /api/users — list all users in the caller's org, sorted oldest-
// first so the original signup admin shows up at the top.
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, email, role, created_at
         FROM ochr_users
        WHERE organization_id = $1
        ORDER BY created_at ASC`,
      [req.organizationId]
    )
    res.json(rows.map(publicUser))
  } catch (err) {
    console.error('users list failed:', err)
    res.status(500).json({ error: 'Failed to load team' })
  }
})

// POST /api/users — admin manually creates a teammate. No email-based
// invite flow yet; the admin types a temporary password and shares it
// out-of-band, or directs the new user to /forgot to set their own.
// Triggers a welcome email so the new user knows the account exists.
router.post('/', async (req, res) => {
  try {
    const { name, email, password, role } = req.body ?? {}
    if (!name?.trim())              return res.status(400).json({ error: 'Name is required' })
    if (!isEmail(email))            return res.status(400).json({ error: 'Valid email is required' })
    if (!password || password.length < MIN_PASSWORD) {
      return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters` })
    }
    if (!ROLES.includes(role))      return res.status(400).json({ error: `Role must be one of: ${ROLES.join(', ')}` })

    const cleanEmail = email.trim().toLowerCase()

    // Email uniqueness is global across the app — same email can't
    // belong to two orgs. Check up front for a friendly error.
    const { rows: dupe } = await pool.query(
      'SELECT 1 FROM ochr_users WHERE email = $1',
      [cleanEmail]
    )
    if (dupe.length) return res.status(409).json({ error: 'An account with that email already exists' })

    const hash = await bcrypt.hash(password, 10)
    const { rows } = await pool.query(
      `INSERT INTO ochr_users (organization_id, email, password_hash, name, role)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.organizationId, cleanEmail, hash, name.trim(), role]
    )
    const user = rows[0]

    // Welcome email — fire-and-forget. Org name lookup so the message
    // matches what self-signup admins receive.
    try {
      const { rows: orgRows } = await pool.query(
        'SELECT name FROM ochr_organizations WHERE id = $1',
        [req.organizationId]
      )
      const orgName = orgRows[0]?.name || 'your church'
      const dashboardUrl = `${(process.env.CLIENT_URL || 'http://localhost:5202').replace(/\/$/, '')}/`
      await sendEmail({
        to: user.email,
        ...welcomeEmail({ name: user.name, organizationName: orgName, dashboardUrl }),
      })
    } catch (emailErr) {
      console.error('teammate welcome email failed:', emailErr)
    }

    res.status(201).json(publicUser(user))
  } catch (err) {
    console.error('user create failed:', err)
    res.status(500).json({ error: 'Failed to create user' })
  }
})

// PATCH /api/users/:id/role — admin changes a user's role. Last-admin
// protection prevents the org from being orphaned without an admin.
router.patch('/:id/role', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    const { role } = req.body ?? {}
    if (!ROLES.includes(role)) {
      return res.status(400).json({ error: `Role must be one of: ${ROLES.join(', ')}` })
    }

    // Confirm the target belongs to the caller's org and read their
    // current role so we know whether this is a demotion away from
    // admin (which needs the last-admin guard).
    const { rows: existing } = await pool.query(
      'SELECT id, role FROM ochr_users WHERE id = $1 AND organization_id = $2',
      [id, req.organizationId]
    )
    if (!existing.length) return res.status(404).json({ error: 'User not found' })
    const target = existing[0]

    // Demoting an admin: only allowed if at least one other admin
    // remains. Covers both "admin demotes self" and "admin demotes
    // the other admin in a 2-admin org."
    if (target.role === 'admin' && role !== 'admin') {
      const others = await otherAdminCount(req.organizationId, target.id)
      if (others === 0) {
        return res.status(400).json({ error: 'Cannot demote the only admin. Promote another user first.' })
      }
    }

    const { rows } = await pool.query(
      `UPDATE ochr_users SET role = $1 WHERE id = $2 AND organization_id = $3 RETURNING *`,
      [role, id, req.organizationId]
    )
    res.json(publicUser(rows[0]))
  } catch (err) {
    console.error('user role change failed:', err)
    res.status(500).json({ error: 'Failed to update role' })
  }
})

// DELETE /api/users/:id — admin removes a user. Same last-admin guard
// as role change. Self-deletion is permitted as long as another admin
// exists, since an admin should be able to leave their own org.
router.delete('/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    const { rows: existing } = await pool.query(
      'SELECT id, role FROM ochr_users WHERE id = $1 AND organization_id = $2',
      [id, req.organizationId]
    )
    if (!existing.length) return res.status(404).json({ error: 'User not found' })
    const target = existing[0]

    if (target.role === 'admin') {
      const others = await otherAdminCount(req.organizationId, target.id)
      if (others === 0) {
        return res.status(400).json({ error: 'Cannot remove the only admin. Promote another user first.' })
      }
    }

    await pool.query(
      'DELETE FROM ochr_users WHERE id = $1 AND organization_id = $2',
      [id, req.organizationId]
    )
    res.status(204).end()
  } catch (err) {
    console.error('user delete failed:', err)
    res.status(500).json({ error: 'Failed to remove user' })
  }
})

export default router
