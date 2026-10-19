import { viewerMayRead, isReadMethod, VIEWER_SCOPE_ERROR } from './viewerScope.js'
import jwt from 'jsonwebtoken'
import pool from '../db.js'
import { monitor } from '../monitoring/index.js'
import { extractSessionToken } from '../auth/sessionCookie.js'
import { resolvePlatformIdentity } from './superAdmin.js'

// Recognized roles. Keep in sync with the CHECK constraint in
// migrations/003-roles-check.js.
export const ROLES = ['admin', 'staff', 'viewer']

// JWT signing secret. Required in production — a missing secret there
// throws at module load (fail closed) rather than silently signing every
// token with a public, guessable fallback. In dev/test we keep the fallback
// but LOG a warning so it's obvious in the terminal.
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be set in production')
}
const SECRET = process.env.JWT_SECRET || 'dev-only-change-me-please'
if (!process.env.JWT_SECRET) {
  console.warn('[auth] JWT_SECRET not set — using insecure dev secret')
}

const TOKEN_EXPIRY = '7d'

export function signToken(payload) {
  return jwt.sign(payload, SECRET, { expiresIn: TOKEN_EXPIRY })
}

export function verifyToken(token) {
  return jwt.verify(token, SECRET)
}

// Express middleware: unwraps the session JWT from the httpOnly
// `ochr_session` cookie (production), or — outside production — from
// Authorization: Bearer <token> so the existing server suite can keep
// proving isolation without a 200-file rewrite. Verifies the JWT and
// attaches req.user + req.organizationId for downstream routes.
//
// Revocability (audit H5): every token carries a `tv` (token_version)
// claim; the live row's version must match. Bumping the version — on
// password reset or sign-out-everywhere — invalidates every outstanding
// token instantly instead of letting a stolen token ride out its 7-day
// expiry. Tokens issued before migration 055 have no `tv` and are
// treated as version 1 (the column default), so the deploy signs nobody
// out. The check is one indexed PK lookup; requireRole already pays the
// same cost for mutations. Fail closed on DB errors.
//
// On failure, responds 401 so the client knows to bounce back to /login.
export async function requireAuth(req, res, next) {
  const token = extractSessionToken(req)
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  let payload
  try {
    payload = verifyToken(token)
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }
  if (!payload?.userId || !payload?.organizationId) {
    return res.status(401).json({ error: 'Invalid token' })
  }

  let pastoralLead = false
  let liveRole = null
  let orgType = null
  let platform = { founder: false, vendor: false }
  try {
    const { rows } = await pool.query(
      // pastoral_lead is read HERE, not taken from the token. A permission
      // baked into a JWT survives its own revocation until the token
      // expires, and "we removed her access an hour ago" has to be true the
      // moment it is said. This query already runs on every request.
      `SELECT u.token_version, u.pastoral_lead, u.deactivated_at, u.closed_at,
              u.role, o.org_type
         FROM ochr_users u JOIN ochr_organizations o ON o.id = u.organization_id
        WHERE u.id = $1 AND u.organization_id = $2`,
      [payload.userId, payload.organizationId]
    )
    if (!rows.length) {
      return res.status(401).json({ error: 'User no longer exists' })
    }
    if (rows[0].closed_at != null) {
      return res.status(401).json({ error: 'This login is closed.' })
    }
    if (rows[0].deactivated_at != null) {
      return res.status(401).json({ error: 'This login is deactivated.' })
    }
    if ((payload.tv ?? 1) !== (rows[0].token_version ?? 1)) {
      return res.status(401).json({ error: 'Session expired — please sign in again' })
    }
    pastoralLead = rows[0].pastoral_lead === true
    liveRole = rows[0].role
    orgType = rows[0].org_type
    const { rows: organizations } = await pool.query('SELECT held_at FROM ochr_organizations WHERE id = $1', [payload.organizationId])
    if (!organizations.length || organizations[0].held_at != null) {
      return res.status(401).json({ error: 'This organization is on hold. Access is stopped; parish history remains.' })
    }
    // F-01: founder/vendor by this live row's id only (see superAdmin.js).
    // Runs after the closed/deactivated and HOLD refusals above.
    platform = await resolvePlatformIdentity(payload.userId)
  } catch (err) {
    monitor.error('auth.requireAuth', err, { userId: payload.userId, orgId: payload.organizationId })
    return res.status(500).json({ error: 'Authentication check failed' })
  }

  // SP-014..022: a parish Viewer reads only what the Help role table
  // promises. The live role decides, so a demotion applies at once.
  if (liveRole === 'viewer' && orgType !== 'diocese' && isReadMethod(req.method)
      && !viewerMayRead(req.originalUrl)) {
    return res.status(403).json({ error: VIEWER_SCOPE_ERROR, code: 'viewer_scope' })
  }

  req.user = {
    id: payload.userId, email: payload.email, name: payload.name, role: liveRole ?? payload.role,
    pastoral_lead: pastoralLead, platform,
  }
  req.organizationId = payload.organizationId
  next()
}

// Gates a route on the caller's *current* role from the database, not
// the role baked into the JWT. This matters because admins can demote
// users mid-session — without this DB check, the demoted user would
// keep admin powers until their token expires (up to 7 days).
//
// Usage:
//   router.delete('/:id', requireRole('admin'), handler)
//   router.post('/',      requireRole('admin', 'staff'), handler)
//
// Refreshes req.user.role to the live value so downstream handlers
// see the current permission level too.
export function requireRole(...allowed) {
  return async function (req, res, next) {
    if (!req.user?.id || !req.organizationId) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
    try {
      const { rows } = await pool.query(
        'SELECT role FROM ochr_users WHERE id = $1 AND organization_id = $2',
        [req.user.id, req.organizationId]
      )
      if (!rows.length) return res.status(401).json({ error: 'User no longer exists' })
      const currentRole = rows[0].role
      req.user.role = currentRole
      if (!allowed.includes(currentRole)) {
        return res.status(403).json({ error: 'Forbidden' })
      }
      next()
    } catch (err) {
      monitor.error('auth.requireRole', err, { userId: req.user?.id, orgId: req.organizationId })
      res.status(500).json({ error: 'Permission check failed' })
    }
  }
}

// Wraps an entire router so that mutating HTTP methods (POST, PATCH,
// PUT, DELETE) require one of the given roles, while reads (GET, HEAD,
// OPTIONS) pass through to the route's existing handlers. The result:
// viewers can read every list/detail page; only admins and staff can
// change anything.
//
// Mounted in app.js per router so the policy lives in one obvious place.
export function gateMutations(...allowed) {
  const isReadOnly = (m) => m === 'GET' || m === 'HEAD' || m === 'OPTIONS'
  const enforce = requireRole(...allowed)
  return (req, res, next) => {
    if (isReadOnly(req.method)) return next()
    return enforce(req, res, next)
  }
}

// Gates a mount on the caller org's *type* (DIO.1). A diocese is an
// ordinary organization with org_type = 'diocese'; diocese-only surfaces
// (/api/diocese/*) mount this after requireAuth. Reads the live value
// from the DB — same source-of-truth reasoning as requireRole.
export function requireOrgType(...allowed) {
  return async function (req, res, next) {
    if (!req.organizationId) {
      return res.status(401).json({ error: 'Authentication required' })
    }
    try {
      const { rows } = await pool.query(
        'SELECT org_type FROM ochr_organizations WHERE id = $1',
        [req.organizationId]
      )
      if (!rows.length) return res.status(401).json({ error: 'Organization not found' })
      if (!allowed.includes(rows[0].org_type)) {
        return res.status(403).json({ code: 'org_type_forbidden', error: 'This area is not available to your organization type' })
      }
      req.orgType = rows[0].org_type
      next()
    } catch (err) {
      monitor.error('auth.requireOrgType', err, { orgId: req.organizationId })
      return res.status(500).json({ error: 'Authorization check failed' })
    }
  }
}
