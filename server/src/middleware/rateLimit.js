// Rate limits for the auth surface — the only unauthenticated endpoints
// in the app, so the only places brute-force is worth worrying about.
// Tenant routes are JWT-gated; if a token is valid the rate limits are
// the user's problem, not ours.
//
// Storage is in-memory by default. Each Vercel function instance keeps
// its own counter, so a determined attacker hitting cold starts could
// effectively get N×limit attempts where N is the number of warm
// instances. Acceptable for the launch window — when traffic justifies
// it, swap the store for `rate-limit-redis` against an Upstash KV.
//
// `req.ip` is correct when Express has `trust proxy` set (see app.js)
// so the limiter dedupes by real client IP, not by Vercel's edge IP.
//
// ── WHY THESE ARE KEYED THE WAY THEY ARE (2026-08-01) ────────────────
//
// Every limiter here used to key on IP alone. That is wrong for our
// actual customer: a parish office NATs its whole staff behind ONE
// public IP. At the old 10-per-15-minutes, five people each mistyping a
// password twice on a Monday morning locked out the entire office — and
// the secretary who then tried to help would be the one who hit the
// wall. The control was punishing exactly the wrong person.
//
// Brute force and credential stuffing are different attacks and want
// different keys:
//
//   • Brute force = many passwords, ONE account  → key on the email.
//   • Stuffing    = many accounts, ONE origin    → key on the IP.
//
// So login now runs both: a TIGHT per-email limit that stops guessing at
// any single account, and a LOOSE per-IP ceiling a shared parish office
// will never reach legitimately but a stuffing run hits fast. Same
// reasoning for password reset. Signup stays IP-only (there is no
// account to key on yet) but is raised — see its note below.

import rateLimit, { ipKeyGenerator } from 'express-rate-limit'

const int = (name, fallback) => {
  const v = parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(v) && v > 0 ? v : fallback
}

// Key on the submitted email when there is one, falling back to the IP.
// ipKeyGenerator normalises IPv6 into a sane subnet key — required by
// express-rate-limit v7+ for any custom keyGenerator that can return an
// address, otherwise a v6 client gets a fresh bucket on every request.
const emailKey = (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : ''
  return email ? `email:${email}` : `ip:${ipKeyGenerator(req, res)}`
}

// ── Login ───────────────────────────────────────────────────────────
// Per ACCOUNT: 8 failures per 15 min. A fat-fingered password three
// times running is fine; guessing a password is not. Successful logins
// are skipped, so someone who signs in correctly never accrues a count
// against themselves.
export const loginAccountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: int('LOGIN_MAX_PER_ACCOUNT', 8),
  keyGenerator: emailKey,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many attempts for this account. Please wait a few minutes, or reset your password.',
  },
})

// Per ORIGIN: 60 per 15 min. Deliberately loose — this exists to catch
// stuffing across many accounts, not to police one busy office. A parish
// with a dozen staff will never see it.
export const loginIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: int('LOGIN_MAX_PER_IP', 60),
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many sign-in attempts from this network. Please try again in a few minutes.',
  },
})

// ── Signup ──────────────────────────────────────────────────────────
// 12 per hour per IP, was 3. There is no account to key on yet, so IP is
// all we have — which meant the old limit throttled the one scenario we
// most want to succeed: several parishes signing up on the spot from the
// same room's wifi at a demo. Twelve covers a five-parish demo plus
// retries and typos, and still stops anyone farming organisations.
// Override with SIGNUP_MAX_PER_HOUR for an unusually large event.
export const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: int('SIGNUP_MAX_PER_HOUR', 12),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many new accounts from this network in the last hour. Please try again shortly, or contact us and we will set the parish up directly.',
  },
})

// ── Password reset ──────────────────────────────────────────────────
// Per ACCOUNT: 5 per hour — stops someone spamming one person's inbox.
export const forgotPasswordAccountLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: int('RESET_MAX_PER_ACCOUNT', 5),
  keyGenerator: emailKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many password-reset requests for this account. Please try again later.',
  },
})

// Per ORIGIN: 30 per hour — an office where several people forget their
// password the same morning is normal; enumeration is not.
export const forgotPasswordIpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: int('RESET_MAX_PER_IP', 30),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many password-reset requests from this network. Please try again later.',
  },
})

// ── Change password (signed in) ─────────────────────────────────────
// Per USER: 10 per 15 min, successful changes not counted.
//
// Keyed on the authenticated user id rather than an email or an IP,
// because neither fits. This route carries no email in the body, so
// emailKey would silently degrade every caller to the shared-IP bucket —
// a limiter that looks like protection and is really just the parish
// office NAT problem again, on a route where one person's typo would
// throttle a colleague.
//
// The threat here is narrow: someone holding a stolen token guessing the
// current password to take the account over permanently. They already
// have access, so this does not gate entry — it gates escalation, which
// is why 10 is generous enough that a real user retyping a forgotten
// password never notices.
//
// MUST be mounted AFTER requireAuth so req.user exists. The IP fallback
// is belt-and-braces for a mounting mistake, not an expected path.
export const changePasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: int('CHANGE_PW_MAX_PER_USER', 10),
  keyGenerator: (req, res) =>
    req.user?.id ? `user:${req.user.id}` : `ip:${ipKeyGenerator(req, res)}`,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many password-change attempts. Please wait a few minutes and try again.',
  },
})

// ── Unauthenticated token / public surfaces (Argus R427, 2026-10-26) ──
// Argus #427 listed the remaining unauthenticated routes that had no
// limiter. Each of these authorises with a secret the caller must guess
// (a single-use token in the body, or a capability token in the path), or
// is a public evaluation endpoint. None of the secrets is guessable in
// practice; these limiters are defense in depth against scripted guessing
// and CPU burn, sized so a real user never meets them.

// Reset-password and accept-invite: token in the body, per IP. Only
// FAILED attempts count (skipSuccessfulRequests), so a parish office NAT
// where several people finish a reset the same morning is never throttled.
export const resetPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: int('RESET_PASSWORD_MAX_PER_IP', 20),
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many password-reset attempts from this network. Please try again in a few minutes.' },
})

export const acceptInviteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: int('ACCEPT_INVITE_MAX_PER_IP', 20),
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many invitation attempts from this network. Please try again in a few minutes.' },
})

// Capability-token GETs (kiosk shell, member ICS feed). Only misses count:
// a calendar provider (Google, Apple) polls many members' feeds from a
// shared IP range, and a kiosk tablet reloads all day, so successful reads
// must never accrue. The ceiling is loose because stale (rotated) tokens
// legitimately 404 from those shared ranges too.
export const kioskTokenLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: int('KIOSK_TOKEN_MISS_MAX_PER_IP', 60),
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests from this device. Please wait a moment.' },
})

export const calendarFeedLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: int('CALENDAR_FEED_MISS_MAX_PER_IP', 300),
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many calendar feed requests from this network. Please try again later.' },
})

// Public schedule evaluation POSTs (/facility-hold, /volunteer-roster,
// /mcp). No caller in the product uses them; they compute synthetic
// output. Every request counts, per IP, shared across the three routes.
export const publicScheduleLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: int('PUBLIC_SCHEDULE_MAX_PER_IP', 60),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests from this address. Please try again in a few minutes.' },
})
