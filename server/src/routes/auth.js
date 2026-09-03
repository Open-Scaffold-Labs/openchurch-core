import { Router } from 'express'
import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import pool from '../db.js'
import { signToken, requireAuth } from '../middleware/auth.js'
import {
  loginAccountLimiter, loginIpLimiter,
  signupLimiter,
  forgotPasswordAccountLimiter, forgotPasswordIpLimiter,
  changePasswordLimiter,
} from '../middleware/rateLimit.js'
import { seedSampleData } from '../onboarding/sampleSeed.js'
import { sendEmail } from '../email/send.js'
import { welcomeEmail, passwordResetEmail } from '../email/templates.js'
// Used by the accept-invite catch block. Its absence made that handler's
// error path throw a ReferenceError of its own, so the real failure — on a
// pre-authentication credential route — never reached monitoring.
import { monitor } from '../monitoring/index.js'

// Where the client lives — used to build links in emails. Falls back
// to the local dev URL so dev "just works" without a env var set.
const CLIENT_URL = (process.env.CLIENT_URL || 'http://localhost:5202').replace(/\/$/, '')

// SHA-256 hash a raw token for safe storage. The user gets the raw
// token in their email; we only ever store the hash.
function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex')
}

const router = Router()

const MIN_PASSWORD = 8

// Very light email validation — not exhaustive, just to reject obvious
// garbage without pulling in a library. Server-side safety net only.
// Exported so the public giving route uses the SAME rule rather than a second
// copy that drifts. Two validators for one concept is how "valid here, junk
// there" happens.
export function isEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim())
}

// Normalize an org name into a URL-safe slug. Uniqueness is enforced by a
// DB unique index; on collision we append a short timestamp suffix so the
// user isn't bounced back to fix something trivial.
// Exported so the provisioning route (routes/maintenance.js) uses THIS
// function rather than a second copy of it — two slug rules that drift
// apart is how one org gets a slug the other path would have rejected.
export function slugify(name) {
  return (name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

// Shared shape for the token payload + /me response. Keeps the app's
// user object consistent whether you just signed up, just logged in,
// or rehydrated via /me on refresh.
function publicUser(user, org) {
  return {
    id:     user.id,
    email:  user.email,
    name:   user.name,
    role:   user.role,
    avatar: user.avatar ?? null,
    // tradition drives the client's vocabulary overlay and season names
    // (TRAD.1); locale is the parish default the i18n spine reads.
    //
    // Migration 093 gave locale a column with a NOT NULL default, so the
    // `?? 'en'` here is for a caller that built `org` from a query which
    // forgot to select it — which is exactly what happened for the eleven
    // months this field read `?? null` against a column that did not exist.
    // Three paths build this object (signup, login, /me) and only signup
    // gets new columns for free, via RETURNING *. The other two are listed
    // out by hand and are where a field goes missing.
    organization: {
      id: org.id, name: org.name, slug: org.slug,
      tradition: org.tradition ?? 'general',
      locale: org.locale ?? 'en',
      // PILOT.4 — carried through login and signup as well as /me, so a
      // client never has to guess from the name.
      is_demo: org.is_demo === true,
    },
  }
}

// POST /api/auth/signup
// Creates a new organization + its first (admin) user in one shot.
// Self-serve: no invite, no approval. The signer-up owns the new org.
router.post('/signup', signupLimiter, async (req, res) => {
  const { organizationName, name, email, password } = req.body ?? {}

  // A DIOCESE IS NOT SELF-SERVICE. THE SERVER DECIDES, NOT THE BODY.
  //
  // DIO.1 gave a diocese the same door as a parish, distinguished only by
  // organizationType in the request body. This endpoint is public and
  // unauthenticated, so anyone could create a chancery: stamp a diocese,
  // then invite any parish admin's address into it. The invitation reply
  // discloses that parish's name, slug and id, and — because a parish holds
  // at most one live affiliation (uq_affiliation_one_live_diocese, 058) —
  // a pending squat also blocks the real diocese's invitation until
  // somebody notices. A parish is a self-service customer; a diocese is a
  // relationship with an organisation, and the founder direction is that it
  // enters through a trusted path.
  //
  // Refused HERE rather than hidden in the client: the client is a
  // suggestion, and the attack is a direct POST. The trusted path is the
  // one that already exists — requireSuperAdmin / VENDOR_ADMIN_EMAILS,
  // env-identified with no cross-tenant role row (middleware/superAdmin.js)
  // — via POST /api/admin/maintenance/organizations below. Nothing new was
  // invented for this.
  //
  // 403 and not 404: unlike /api/admin/*, the existence of dioceses is not
  // a secret (the marketing site says so), and a would-be chancery
  // deserves to be told how to proceed rather than shown a wall.
  if (req.body?.organizationType != null && req.body.organizationType !== 'parish') {
    return res.status(403).json({
      error: 'Diocesan and chancery accounts are provisioned by OpenChurch rather than created here. Please contact us and we will set yours up.',
      code: 'org_type_not_self_service',
    })
  }
  const orgType = 'parish'
  // TRAD.1 — a congregation may name its tradition at signup. Anything
  // unrecognised becomes 'general' rather than an error: a bad value here
  // must not block someone creating an account, and 'general' is the one
  // tier that cannot be wrong in another tradition's vocabulary.
  const TRADITIONS_ALLOWED = new Set(['catholic', 'episcopal', 'lutheran', 'anglican', 'general'])
  const tradition = TRADITIONS_ALLOWED.has(req.body?.tradition) ? req.body.tradition : 'general'
  if (!organizationName?.trim()) return res.status(400).json({ error: 'Church name is required' })
  if (!name?.trim())             return res.status(400).json({ error: 'Your name is required' })
  if (!isEmail(email))           return res.status(400).json({ error: 'Valid email is required' })
  if (!password || password.length < MIN_PASSWORD) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters` })
  }

  const cleanEmail = email.trim().toLowerCase()

  // Reject duplicates up front so the client can show a friendly error
  // rather than a generic 500 from the unique constraint.
  const { rows: dupe } = await pool.query(`SELECT 1 FROM ochr_users WHERE email = $1
       -- tenancy: pre-authentication. Signup has no organization yet, and email is globally unique across the app, so this asks a question no org scope can express.`, [cleanEmail])
  if (dupe.length) return res.status(409).json({ error: 'An account with that email already exists' })

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // Generate a slug, retry once with a suffix if it collides.
    let slug = slugify(organizationName) || 'church'
    const { rows: slugDupe } = await client.query('SELECT 1 FROM ochr_organizations WHERE slug = $1', [slug])
    if (slugDupe.length) slug = `${slug}-${Date.now().toString(36).slice(-4)}`

    const { rows: orgRows } = await client.query(
      'INSERT INTO ochr_organizations (name, slug, org_type, tradition) VALUES ($1, $2, $3, $4) RETURNING *',
      [organizationName.trim(), slug, orgType, tradition]
    )
    const org = orgRows[0]

    const hash = await bcrypt.hash(password, 10)
    const { rows: userRows } = await client.query(
      // CARE.3 — the founding user of a CHANCERY is pastoral leadership.
      // A diocese whose first account cannot read its own pastoral notes is
      // a chancery nobody can work in, and the alternative is telling a new
      // customer to go grant themselves a permission before starting. They
      // can withdraw it from themselves later; they cannot bootstrap it.
      // Parish signups get nothing here — the permission is diocesan.
      `INSERT INTO ochr_users (organization_id, email, password_hash, name, role, pastoral_lead)
       VALUES ($1, $2, $3, $4, 'admin', $5) RETURNING *`,
      // Always false on this route now — a diocese cannot be created here,
      // and the founding-chancery pastoral_lead grant moved to the
      // provisioning route with the rest of the diocese path.
      [org.id, cleanEmail, hash, name.trim(), false]
    )
    const user = userRows[0]

    await client.query('COMMIT')

    const token = signToken({
      userId: user.id,
      organizationId: org.id,
      email: user.email,
      name: user.name,
      role: user.role,
      tv: user.token_version ?? 1,
    })

    // Seed sample data on a separate connection AFTER commit so a seed
    // failure can't roll back the org/user the caller just received.
    // Best-effort — failures are logged but the signup still returns 201.
    // A diocese doesn't get parish sample members/events — its first
    // screen is the affiliation roster, which starts honestly empty.
    if (orgType !== 'diocese') {
      try {
        await seedSampleData(pool, org.id, tradition)
      } catch (seedErr) {
        console.error('sample seed failed (signup succeeded):', seedErr)
      }
    }

    // Welcome email — fire-and-forget. Logging failures is fine; we
    // don't want a flaky email service blocking the signup response.
    try {
      await sendEmail({
        to: user.email,
        ...welcomeEmail({
          name: user.name,
          organizationName: org.name,
          dashboardUrl: `${CLIENT_URL}/`,
        }),
      })
    } catch (emailErr) {
      console.error('welcome email failed (signup succeeded):', emailErr)
    }

    res.status(201).json({ token, user: publicUser(user, org) })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('signup failed:', err)
    res.status(500).json({ error: 'Failed to create account' })
  } finally {
    client.release()
  }
})

// POST /api/auth/login
// Single generic error message on failure so attackers can't distinguish
// "email doesn't exist" from "wrong password".
router.post('/login', loginAccountLimiter, loginIpLimiter, async (req, res) => {
  const { email, password } = req.body ?? {}
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' })

  const cleanEmail = String(email).trim().toLowerCase()

  try {
    const { rows } = await pool.query(
      `SELECT u.*, o.name AS organization_name, o.slug AS organization_slug,
              o.tradition AS organization_tradition, o.is_demo AS organization_is_demo,
              o.locale AS organization_locale
         FROM ochr_users u
         JOIN ochr_organizations o ON o.id = u.organization_id
        WHERE u.email = $1`,
      [cleanEmail]
    )
    if (!rows.length) return res.status(401).json({ error: 'Invalid email or password' })

    const user = rows[0]
    const ok = await bcrypt.compare(password, user.password_hash)
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' })

    const org = {
      id: user.organization_id, name: user.organization_name, slug: user.organization_slug,
      tradition: user.organization_tradition,
      locale: user.organization_locale,
      is_demo: user.organization_is_demo === true,
    }
    const token = signToken({
      userId: user.id,
      organizationId: org.id,
      email: user.email,
      name: user.name,
      role: user.role,
      tv: user.token_version ?? 1,
    })
    res.json({ token, user: publicUser(user, org) })
  } catch (err) {
    console.error('login failed:', err)
    res.status(500).json({ error: 'Login failed' })
  }
})

// POST /api/auth/logout
// Clears THIS device's session client-side; the token itself stays
// valid until expiry. For "every device, right now" see /logout-all.
router.post('/logout', (_req, res) => res.status(204).end())

// POST /api/auth/logout-all
// Sign out everywhere: bumps token_version so every outstanding token
// for this user — including the one making this request — fails the
// requireAuth version check immediately (audit H5).
router.post('/logout-all', requireAuth, async (req, res) => {
  try {
    await pool.query(
      'UPDATE ochr_users SET token_version = token_version + 1 WHERE id = $1 AND organization_id = $2',
      [req.user.id, req.organizationId]
    )
    res.status(204).end()
  } catch (err) {
    console.error('logout-all failed:', err)
    res.status(500).json({ error: 'Could not sign out everywhere. Please try again.' })
  }
})

// PATCH /api/auth/password
// Change your own password while signed in.
//
// Until this existed the only route to a new password was the emailed
// reset link — and sendEmail() falls through to a console stub whenever
// RESEND_API_KEY is unset, which it is. So a signed-in user could not
// change their password by ANY route. That is a bad sentence to say to a
// parish, hence this endpoint (F1, 2026-08-14).
//
// Bumps token_version exactly like reset-password does (audit H5):
// changing a password must kill every session that was signed in with
// the old one. The caller gets a freshly signed token back so the device
// doing the changing stays in — signing yourself out everywhere is
// /logout-all's job, deliberately separate.
//
// 403 on a wrong current password, NOT 401 — and this reverses an earlier
// decision that read "credential check, so 401". The client's fetch
// interceptor treats a 401 from any non-login endpoint as a dead session and
// signs the user out; that is the right universal rule and it must stay
// universal. But the caller here IS authenticated — their token verified —
// and simply typed the wrong current password. Answering 401 signed people
// out of Preferences for a typo, and the inline "Current password is
// incorrect" they were owed never rendered. The missing/invalid-token 401s
// (requireAuth, the row-gone case below) are genuine session failures and
// keep their status.
router.patch('/password', requireAuth, changePasswordLimiter, async (req, res) => {
  const { currentPassword, password } = req.body ?? {}

  if (typeof currentPassword !== 'string' || !currentPassword) {
    return res.status(400).json({ error: 'Your current password is required' })
  }
  if (!password || password.length < MIN_PASSWORD) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters` })
  }
  if (password === currentPassword) {
    return res.status(400).json({ error: 'The new password must be different from your current one' })
  }

  try {
    const { rows } = await pool.query(
      `SELECT id, email, name, role, password_hash, organization_id
         FROM ochr_users
        WHERE id = $1 AND organization_id = $2`,
      [req.user.id, req.organizationId]
    )
    const user = rows[0]
    // Row gone mid-session (deleted by an admin) — same shape as /me.
    if (!user) return res.status(401).json({ error: 'Your account is no longer active' })

    const ok = await bcrypt.compare(currentPassword, user.password_hash)
    if (!ok) return res.status(403).json({ error: 'Current password is incorrect' })

    const hash = await bcrypt.hash(password, 10)
    const { rows: bumped } = await pool.query(
      `UPDATE ochr_users
          SET password_hash = $1, token_version = token_version + 1
        WHERE id = $2 AND organization_id = $3
        RETURNING token_version`,
      [hash, user.id, req.organizationId]
    )

    const token = signToken({
      userId: user.id,
      organizationId: user.organization_id,
      email: user.email,
      name: user.name,
      role: user.role,
      tv: bumped[0].token_version,
    })

    res.json({ token, message: 'Password updated. Any other signed-in devices have been signed out.' })
  } catch (err) {
    console.error('change-password failed:', err)
    res.status(500).json({ error: 'Could not change your password. Please try again.' })
  }
})

// POST /api/auth/forgot-password
// Issues a one-hour password-reset token and emails the link. Returns
// 200 unconditionally so an attacker can't probe which emails have
// accounts (timing differences are negligible vs network jitter).
router.post('/forgot-password', forgotPasswordAccountLimiter, forgotPasswordIpLimiter, async (req, res) => {
  const { email } = req.body ?? {}
  // Always return 200 — same response shape whether the email matches
  // a real account or not.
  const generic = { ok: true, message: 'If that email is registered, a reset link has been sent.' }

  if (!isEmail(email)) return res.json(generic)
  const cleanEmail = email.trim().toLowerCase()

  try {
    const { rows } = await pool.query(
      `SELECT id, name, email FROM ochr_users WHERE email = $1
       -- tenancy: pre-authentication. Password reset is requested by someone who cannot sign in; email is the only identifier available and is globally unique.`,
      [cleanEmail]
    )
    const user = rows[0]
    if (!user) return res.json(generic)

    // Mark any previously-issued unused tokens for this user as used.
    // Prevents an attacker who scraped an old reset email from racing
    // a fresh request.
    await pool.query(
      `UPDATE ochr_password_reset_tokens
          SET used_at = NOW()
        WHERE user_id = $1 AND used_at IS NULL`,
      [user.id]
    )

    const rawToken  = crypto.randomBytes(32).toString('base64url')
    const tokenHash = hashToken(rawToken)
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000) // +1h

    await pool.query(
      `INSERT INTO ochr_password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [user.id, tokenHash, expiresAt]
    )

    const resetUrl = `${CLIENT_URL}/reset?token=${encodeURIComponent(rawToken)}`
    try {
      await sendEmail({
        to: user.email,
        ...passwordResetEmail({ name: user.name, resetUrl }),
      })
    } catch (emailErr) {
      // Log but still return generic OK — the user shouldn't see that
      // their email exists if delivery is broken on our side.
      console.error('reset email failed:', emailErr)
    }

    res.json(generic)
  } catch (err) {
    console.error('forgot-password failed:', err)
    res.status(500).json({ error: 'Could not start a password reset. Please try again.' })
  }
})

// POST /api/auth/reset-password
// Verifies the token, sets a new password, and consumes the token.
// One-shot — once used, the token cannot be reused even within its
// 1-hour window. Other unused tokens for the same user are also
// invalidated as a defensive sweep.
router.post('/reset-password', async (req, res) => {
  const { token, password } = req.body ?? {}
  if (typeof token !== 'string' || !token.trim()) {
    return res.status(400).json({ error: 'Reset token is required' })
  }
  if (!password || password.length < MIN_PASSWORD) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters` })
  }

  const tokenHash = hashToken(token)

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const { rows: tokRows } = await client.query(
      `SELECT t.id, t.user_id, t.expires_at, t.used_at, u.email
         /* tenancy: pre-auth reset flow — the token hash IS the credential;
            no org context exists yet */
         FROM ochr_password_reset_tokens t
         JOIN ochr_users u ON u.id = t.user_id
        WHERE t.token_hash = $1
        FOR UPDATE`,
      [tokenHash]
    )
    const tok = tokRows[0]
    if (!tok || tok.used_at || new Date(tok.expires_at) < new Date()) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'Invalid or expired reset link. Request a new one.' })
    }

    const hash = await bcrypt.hash(password, 10)
    // token_version bump: a password reset invalidates every session
    // that was signed in with the old password (audit H5) — the exact
    // moment a user resets is the moment a stolen token must die.
    await client.query(
      `UPDATE ochr_users SET password_hash = $1, token_version = token_version + 1 WHERE id = $2
       -- tenancy: the id comes from a verified reset token, not from the request body. An org filter would not tighten anything the token has not already decided.`,
      [hash, tok.user_id]
    )
    await client.query(
      `UPDATE ochr_password_reset_tokens
          SET used_at = NOW()
        WHERE user_id = $1 AND used_at IS NULL`,
      [tok.user_id]
    )

    await client.query('COMMIT')
    res.json({ ok: true, message: 'Password updated. You can sign in with your new password.' })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('reset-password failed:', err)
    res.status(500).json({ error: 'Could not reset your password. Please try again.' })
  } finally {
    client.release()
  }
})

// GET /api/auth/me
// Rehydrates the client's user object on page load / token refresh.
// If the JWT is still valid but the row was since deleted (e.g. an admin
// revoked the user), return 401 so the client logs out.
// POST /api/auth/accept-invite (PILOT.2) — the invited person sets their
// own password, and becomes the only holder of it.
//
// Pre-auth, like the reset flow, because there is nobody to authenticate
// yet: the token hash IS the credential. Deliberately a separate route
// from /reset-password even though the token table is shared — the two say
// different things to the person on the other end, one of them marks an
// invitation accepted, and collapsing them would mean a reset silently
// counting as an acceptance.
router.post('/accept-invite', async (req, res) => {
  const { token, password } = req.body ?? {}
  if (typeof token !== 'string' || !token.trim()) {
    return res.status(400).json({ error: 'An invitation link is required' })
  }
  if (!password || password.length < MIN_PASSWORD) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters` })
  }

  const tokenHash = hashToken(token)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `SELECT t.id AS token_id, t.expires_at, t.used_at,
              u.id, u.email, u.name, u.role, u.organization_id, u.invite_accepted_at
         /* tenancy: pre-auth — the token hash is the credential, and no
            org context exists until it resolves to a user */
         FROM ochr_password_reset_tokens t
         JOIN ochr_users u ON u.id = t.user_id
        WHERE t.token_hash = $1
        FOR UPDATE`,
      [tokenHash]
    )
    const row = rows[0]
    if (!row || row.used_at || new Date(row.expires_at) < new Date()) {
      await client.query('ROLLBACK')
      // One message for every failure mode. Distinguishing "expired" from
      // "never existed" tells an attacker which guesses were close.
      return res.status(400).json({ error: 'That invitation link is no longer valid. Ask for a new one.' })
    }
    if (row.invite_accepted_at != null) {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: 'That invitation has already been accepted.' })
    }

    const hash = await bcrypt.hash(password, 10)
    await client.query(
      `UPDATE ochr_users
          SET password_hash = $1, invite_accepted_at = NOW(),
              -- tenancy: row.id came from the verified invite token. Accepting an invitation is how a user JOINS an org, so no caller org exists to filter by yet.
              -- Every token minted before this moment is void, and any
              -- session that somehow exists is too.
              token_version = token_version + 1
        WHERE id = $2`,
      [hash, row.id]
    )
    await client.query(
      `UPDATE ochr_password_reset_tokens SET used_at = NOW() WHERE id = $1`,
      [row.token_id]
    )
    await client.query('COMMIT')

    const [{ rows: orgRows }, { rows: tvRows }] = await Promise.all([
      pool.query('SELECT id, name, slug, org_type, tradition, locale, is_demo FROM ochr_organizations WHERE id = $1',
        [row.organization_id]),
      pool.query(`SELECT token_version FROM ochr_users WHERE id = $1
       -- tenancy: id comes from the verified JWT. This read is what ENFORCES session revocation, so it must not depend on an org claim in the token it is validating.`, [row.id]),
    ])
    const user = { id: row.id, email: row.email, name: row.name, role: row.role }
    // The token must carry the version we just incremented to, or the
    // person is signed out by the very act of accepting.
    const token = signToken({
      userId: row.id, organizationId: row.organization_id,
      email: row.email, name: row.name, role: row.role,
      tv: tvRows[0]?.token_version ?? 1,
    })
    res.json({ token, user: { ...user, organization: orgRows[0] } })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    monitor.error('auth.acceptInvite', err)
    res.status(500).json({ error: 'Could not accept the invitation' })
  } finally {
    client.release()
  }
})

router.get('/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.*, o.name AS organization_name, o.slug AS organization_slug,
              o.tradition AS organization_tradition, o.is_demo AS organization_is_demo,
              o.locale AS organization_locale
         FROM ochr_users u
         JOIN ochr_organizations o ON o.id = u.organization_id
        WHERE u.id = $1 AND u.organization_id = $2`,
      [req.user.id, req.organizationId]
    )
    if (!rows.length) return res.status(401).json({ error: 'User no longer exists' })
    const u = rows[0]
    const org = {
      id: u.organization_id, name: u.organization_name, slug: u.organization_slug,
      tradition: u.organization_tradition,
      locale: u.organization_locale,
      // PILOT.4 — a fact on the org, not a naming convention a screenshot
      // can crop out or a rename can erase.
      is_demo: u.organization_is_demo === true,
    }
    res.json({ user: publicUser(u, org) })
  } catch (err) {
    console.error('me failed:', err)
    res.status(500).json({ error: 'Failed to load account' })
  }
})

// PATCH /api/auth/avatar — self-serve profile picture.
// Body: { avatar } — a base64 image data URL, or null to clear it.
// Self-serve: any authenticated user updates their OWN avatar; no
// role gate, and the WHERE clause is pinned to req.user.id so a
// caller can never write someone else's row.
//
// The client resizes every upload to a 256px square JPEG before
// sending, so the size cap below is purely a server-side safety net
// against a hand-crafted oversized payload.
const MAX_AVATAR_CHARS = 400_000 // ~300 KB of base64 — generous ceiling

router.patch('/avatar', requireAuth, async (req, res) => {
  const { avatar } = req.body ?? {}
  const clearing = avatar === null || avatar === undefined || avatar === ''

  if (!clearing) {
    // Raster formats only (audit M7) — data:image/svg+xml is scriptable
    // and has no business being a profile picture.
    if (typeof avatar !== 'string' || !/^data:image\/(png|jpeg|jpg|webp);base64,/.test(avatar)) {
      return res.status(400).json({ error: 'avatar must be a PNG, JPEG, or WebP data URL, or null to clear it' })
    }
    if (avatar.length > MAX_AVATAR_CHARS) {
      return res.status(413).json({ error: 'That image is too large — please choose a smaller picture' })
    }
  }

  try {
    await pool.query(
      `UPDATE ochr_users SET avatar = $1 WHERE id = $2
       -- tenancy: req.user.id comes from the verified JWT — a person editing their own avatar. There is no id here that a request could have chosen.`,
      [clearing ? null : avatar, req.user.id]
    )
    res.json({ avatar: clearing ? null : avatar })
  } catch (err) {
    console.error('avatar update failed:', err)
    res.status(500).json({ error: 'Failed to update profile picture' })
  }
})

export default router
