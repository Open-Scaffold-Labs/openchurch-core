// Team-management endpoints. Admin-only — every route under this
// router runs requireRole('admin') applied at the app.js mount.
//
// "Users" here are OpenChurch login accounts (rows in ochr_users) —
// distinct from "members" (ochr_clients), which are the church's
// parishioners/volunteers/staff list.

import { Router } from 'express'
import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import pool from '../db.js'
// One validator, not two. auth.js exports it precisely so this file does
// not keep its own copy to drift against.
import { isEmail } from './auth.js'
import { ROLES } from '../middleware/auth.js'
import { monitor } from '../monitoring/index.js'
import { sendEmail } from '../email/send.js'
import { welcomeEmail } from '../email/templates.js'
import { requireIntParam } from '../utils/params.js'

const router = Router()

const MIN_PASSWORD = 8


// PILOT.2 — one set-password link, reusing the reset-token table.
//
// A set-password link and a password-reset link are the same object with
// different words around them. A second token table would be two things to
// expire, revoke and audit correctly instead of one, and the second one is
// always the one that gets it wrong.
//
// Seven days rather than the reset flow's hour: a reset is answered by
// somebody sitting at the screen who just asked for it, an invitation is
// answered by somebody who has to notice an email first. It is still an
// expiry — an invitation that never dies is a standing key.
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000

// Which app the link opens.
//
// The first cut of this sent every invitation to CLIENT_URL, which is the
// PARISH app — so a chancery colleague clicking their invitation would
// land in the wrong product, sign in, and see a parish they have nothing
// to do with. A diocese and a parish are two front ends against one API,
// and an invitation has to know which one it belongs to.
function clientBaseFor(orgType) {
  const trim = (u) => String(u).replace(/\/$/, '')
  if (orgType === 'diocese') {
    return trim(process.env.DIOCESE_CLIENT_URL || 'http://localhost:5204')
  }
  return trim(process.env.CLIENT_URL || 'http://localhost:5202')
}

async function issueInviteLink(userId, orgType) {
  // Any earlier unused link dies. An invitation forwarded to the wrong
  // person stops working the moment it is resent.
  await pool.query(
    `UPDATE ochr_password_reset_tokens SET used_at = NOW()
      WHERE user_id = $1 AND used_at IS NULL`,
    [userId]
  )
  const raw = crypto.randomBytes(32).toString('base64url')
  const tokenHash = crypto.createHash('sha256').update(raw).digest('hex')
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS)
  await pool.query(
    `INSERT INTO ochr_password_reset_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, tokenHash, expiresAt]
  )
  return {
    url: `${clientBaseFor(orgType)}/accept-invite?token=${encodeURIComponent(raw)}`,
    expires_at: expiresAt,
  }
}

// Shape returned to the client. Never includes password_hash; only the
// fields the team page needs.
function publicUser(u) {
  return {
    id: u.id, name: u.name, email: u.email, role: u.role, created_at: u.created_at,
    // PILOT.2 — an unaccepted invitation is a visible state, not an
    // indistinguishable account. A chancery should be able to see at a
    // glance who has actually walked through the door.
    pending: u.invite_accepted_at == null,
    invited_at: u.invited_at ?? null,
    invited_by_name: u.invited_by_name ?? null,
    // CARE.3 — a permission, not a role. Surfaced so a chancery admin can
    // see at a glance who may read what the office keeps to itself.
    pastoral_lead: u.pastoral_lead === true,
  }
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
      `SELECT id, name, email, role, pastoral_lead, created_at,
              invited_at, invite_accepted_at, invited_by_name
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

// POST /api/users — admin creates a teammate directly, password and all.
//
// SUPERSEDED BY /invite (PILOT.2). Kept because existing clients and tests
// call it, but it is the credential-sharing path: whoever calls this knows
// the password of the account it makes. Prefer /invite for anything a real
// chancery touches.
//
// Historic note, which the following comment used to state as current: the
// admin types a temporary password and shares it
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
      `SELECT 1 FROM ochr_users WHERE email = $1
       -- tenancy: email uniqueness is global across the app by design — the same address cannot belong to two orgs — so this is deliberately unscoped.`,
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

// POST /api/users/invite (PILOT.2) — add a colleague without learning
// their password.
//
// The old path (POST /) creates the account AND sets its password, so the
// administrator had to invent one and convey it. That is credential sharing
// with a form around it. Here the account exists immediately, unusable, and
// the person sets their own password from a one-time link.
//
// The account is created with a hash of random bytes NOBODY HOLDS. Not a
// null password — a nullable password column makes "no password set" a
// state every login path must remember to check, and the one that forgets
// is a way in. This way the account simply cannot be signed into.
router.post('/invite', async (req, res) => {
  const { name, email, role } = req.body ?? {}
  const wantsLead = req.body?.pastoral_lead === true
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'A name is required' })
  if (!isEmail(email)) return res.status(400).json({ error: 'A valid email is required' })
  if (!ROLES.includes(role)) return res.status(400).json({ error: `Role must be one of: ${ROLES.join(', ')}` })

  const cleanEmail = String(email).trim().toLowerCase()
  try {
    // Unusable by construction. 32 random bytes hashed and discarded.
    const hash = await bcrypt.hash(crypto.randomBytes(32).toString('base64url'), 10)
    const { rows } = await pool.query(
      `INSERT INTO ochr_users
         (organization_id, email, password_hash, name, role, pastoral_lead,
          invited_at, invited_by_name)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7)
       RETURNING id, name, email, role, pastoral_lead, created_at,
                 invited_at, invite_accepted_at, invited_by_name`,
      [req.organizationId, cleanEmail, hash, String(name).trim(), role, wantsLead,
       req.user?.name ?? null]
    )
    const user = rows[0]
    const { rows: orgRows } = await pool.query(
      'SELECT org_type FROM ochr_organizations WHERE id = $1', [req.organizationId])
    const invite = await issueInviteLink(user.id, orgRows[0]?.org_type)
    res.status(201).json({ user: publicUser(user), invite })
  } catch (err) {
    if (err?.code === '23505') {
      return res.status(409).json({ error: 'Someone with that email already has an account' })
    }
    monitor.error('users.invite', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to send the invitation' })
  }
})

// POST /api/users/:id/invite/resend — a fresh link, and the old one dies.
//
// Reissuing invalidates every earlier unused token for that user, so an
// invitation forwarded to the wrong person stops working the moment it is
// resent. Same reasoning as the reset flow.
router.post('/:id/invite/resend', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.invite_accepted_at, o.org_type
         FROM ochr_users u
         JOIN ochr_organizations o ON o.id = u.organization_id
        WHERE u.id = $1 AND u.organization_id = $2`,
      [id, req.organizationId]
    )
    if (!rows.length) return res.status(404).json({ error: 'User not found' })
    if (rows[0].invite_accepted_at != null) {
      return res.status(409).json({
        error: 'That invitation has already been accepted. They can reset their own password from the sign-in page.',
      })
    }
    res.json({ invite: await issueInviteLink(id, rows[0].org_type) })
  } catch (err) {
    monitor.error('users.invite.resend', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to resend the invitation' })
  }
})

// PATCH /api/users/:id/pastoral-lead (CARE.3) — grant or withdraw the
// permission to read the office's internal notes about a parish.
//
// Deliberately NOT folded into the role. A canon may be `staff` and hold
// this; an operations admin may hold no pastoral responsibility at all and
// should not inherit a parish's confidences from managing the billing.
//
// Admin-only to change, and it is audited like any other write, because
// "who was allowed to read that, and since when" is a question a chancery
// may one day have to answer to a parish.
router.patch('/:id/pastoral-lead', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  const grant = req.body?.pastoral_lead
  if (typeof grant !== 'boolean') {
    return res.status(400).json({ error: 'pastoral_lead must be true or false' })
  }
  try {
    const { rows } = await pool.query(
      `UPDATE ochr_users SET pastoral_lead = $1
        WHERE id = $2 AND organization_id = $3
        RETURNING id, name, email, role, pastoral_lead, created_at`,
      [grant, id, req.organizationId]
    )
    if (!rows.length) return res.status(404).json({ error: 'User not found' })
    res.json({ user: publicUser(rows[0]) })
  } catch (err) {
    monitor.error('users.pastoralLead', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to update the permission' })
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

    // Bump token_version alongside the role, exactly as logout-everywhere,
    // password reset and password change already do (audit H5). requireAuth
    // checks token_version on every request, so this makes the change take
    // effect on the demoted user's NEXT request rather than whenever their
    // token happens to expire — which is up to seven days.
    //
    // Without it, a role change was a promise about the future rather than a
    // decision that took effect. It is a strange thing to tell an admin that
    // the person she just demoted still has access until next week, and it is
    // stranger still for that to be invisible.
    //
    // The cost is that the user is signed out and has to sign in again. For a
    // promotion that is a small annoyance; for a demotion it is the point.
    const { rows } = await pool.query(
      `UPDATE ochr_users
          SET role = $1, token_version = COALESCE(token_version, 1) + 1
        WHERE id = $2 AND organization_id = $3
        RETURNING *`,
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
