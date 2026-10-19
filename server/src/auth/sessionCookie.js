// httpOnly cookie session (OC-READY-01-011).
//
// CSRF STRATEGY (SameSite=Lax)
// ----------------------------
// The parish and chancery apps reach this API same-origin: Vercel rewrites
// `/api/*` onto the Express handler, and local Vite proxies `/api` to the
// server. The session cookie is therefore first-party.
//
//   Cookie: ochr_session
//   Flags:  HttpOnly; SameSite=Lax; Path=/; Max-Age=7d
//           Secure is added in production (HTTPS / Vercel).
//
// SameSite=Lax is the CSRF control:
//   - Cross-site POST / PUT / PATCH / DELETE / fetch from another site
//     do not include the cookie. A forged form or XHR cannot ride the
//     secretary's session.
//   - Cross-site top-level GET navigations (an emailed link) MAY include
//     the cookie. GET routes in this app do not mutate.
//   - Same-origin fetches from the app include the cookie.
//
// Defense in depth: when a session cookie IS present on a mutating
// request AND the browser sent Origin, that Origin must be on the CORS
// allowlist (CLIENT_URL, DIOCESE_CLIENT_URL, CORS_ORIGINS, plus
// loopback (localhost / 127.0.0.1 / [::1]) outside production). CORS alone is a browser hide; this
// check is the server saying no. Requests with no Origin (curl, the
// test suite, same-origin navigations that omit it, webhooks) pass —
// they are not a browser CSRF vector.
//
// SAME-ORIGIN FALLBACK. The parish app and its API share one origin
// (Vercel rewrites `/api/*`), so a legitimate browser mutation carries
// Origin == the host it was sent to. That is accepted even when no
// allowlist env is set, so a renamed or newly added deployment URL
// cannot silently turn every save into 403 csrf_origin (2026-09-24:
// production ran with an empty allowlist). The comparison reads the raw
// `Host` header only — never `X-Forwarded-Host` and never `req.hostname`
// (which follows X-Forwarded-Host under `trust proxy`). A cross-site
// page cannot choose the Host its victim's browser sends, so a foreign
// Origin still fails. In production-like deploys the Origin must also
// be https.
//
// PRODUCTION-LIKE. Cookie `Secure`, withholding the JWT from response
// bodies, refusing Bearer, and the loopback relaxation all key off
// productionLike(): NODE_ENV=production OR a platform-set Vercel
// deployment (VERCEL_ENV production/preview). NODE_ENV is ours to
// forget; VERCEL_ENV is set by the platform. Either one closes them.
//
// Bearer Authorization is retired in production. In test/dev the header
// is still accepted so the existing server suite can keep proving
// tenant isolation without rewriting every call site. The production
// clients never store a JWT.

export const SESSION_COOKIE = 'ochr_session'
export const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

// True on a deployed Vercel runtime (production or preview) or whenever
// NODE_ENV says production. `vercel dev` sets VERCEL_ENV=development and
// stays non-production, as does the test suite (VERCEL_ENV unset).
export function productionLike({
  env = process.env.NODE_ENV,
  vercelEnv = process.env.VERCEL_ENV,
} = {}) {
  return env === 'production' || vercelEnv === 'production' || vercelEnv === 'preview'
}

export function sessionCookieOptions({
  env = process.env.NODE_ENV,
  vercelEnv = process.env.VERCEL_ENV,
} = {}) {
  return {
    httpOnly: true,
    secure: productionLike({ env, vercelEnv }),
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_MS,
  }
}

export function allowedOrigins() {
  return new Set(
    [
      process.env.CLIENT_URL,
      process.env.DIOCESE_CLIENT_URL,
      ...(process.env.CORS_ORIGINS || '').split(','),
    ]
      .map(s => (s || '').trim().replace(/\/$/, ''))
      .filter(Boolean)
  )
}

export function isAllowedOrigin(origin, {
  env = process.env.NODE_ENV,
  vercelEnv = process.env.VERCEL_ENV,
} = {}) {
  if (!origin) return true
  const cleaned = String(origin).replace(/\/$/, '')
  if (allowedOrigins().has(cleaned)) return true
  // Outside production, Vite and local demos often hit the API as
  // 127.0.0.1 or [::1] rather than the localhost hostname. SameSite=Lax
  // still blocks cross-site POSTs; this only widens the Origin allowlist
  // for genuine loopback. Production is unchanged (env-gated).
  if (!productionLike({ env, vercelEnv }) && /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(cleaned)) return true
  return false
}

// Same-origin browser mutation: the Origin's host[:port] equals the raw
// Host header this request arrived with. See SAME-ORIGIN FALLBACK above
// for why only `Host` is read. Anything that does not parse as a plain
// http(s) origin (including the opaque "null") is not same-origin.
export function isSameOriginRequest(origin, req, {
  env = process.env.NODE_ENV,
  vercelEnv = process.env.VERCEL_ENV,
} = {}) {
  if (!origin) return false
  const raw = String(origin).replace(/\/$/, '')
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
  // An Origin is scheme://host[:port] and nothing else. A value with a
  // path, credentials or query is not a browser Origin.
  if (parsed.origin !== raw) return false
  if (productionLike({ env, vercelEnv }) && parsed.protocol !== 'https:') return false
  const host = req?.headers?.host
  if (typeof host !== 'string' || !host.trim()) return false
  return parsed.host.toLowerCase() === host.trim().toLowerCase()
}

// Vitest sets VITEST=true. Kept as a named predicate for callers and
// tests; it no longer grants anything. Bearer is decided by
// productionLike() alone — see bearerAllowed().
export function isVitestHarness(value = process.env.VITEST) {
  return value === 'true' || value === '1'
}

export function readCookie(req, name) {
  const header = req.headers?.cookie
  if (!header) return null
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    const key = part.slice(0, idx).trim()
    if (key !== name) continue
    try {
      return decodeURIComponent(part.slice(idx + 1).trim())
    } catch {
      return part.slice(idx + 1).trim()
    }
  }
  return null
}

// Bearer is a test/dev transport only. Production-like (NODE_ENV=production
// OR a Vercel production/preview runtime) refuses it with NO exception —
// not for VITEST, not for a fixture that flips NODE_ENV. A test that needs
// production semantics authenticates with the session cookie, exactly as
// the production client does. (An `inTest` option passed by older callers
// is ignored on purpose.)
export function bearerAllowed({
  env = process.env.NODE_ENV,
  vercelEnv = process.env.VERCEL_ENV,
} = {}) {
  return !productionLike({ env, vercelEnv })
}

export function extractSessionToken(req, {
  env = process.env.NODE_ENV,
  vercelEnv = process.env.VERCEL_ENV,
} = {}) {
  const cookie = readCookie(req, SESSION_COOKIE)
  if (cookie) return cookie
  if (!bearerAllowed({ env, vercelEnv })) return null
  const header = req.headers?.authorization
  if (header?.startsWith('Bearer ')) return header.slice(7)
  return null
}

export function setSessionCookie(res, token) {
  res.cookie(SESSION_COOKIE, token, sessionCookieOptions())
}

export function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, {
    ...sessionCookieOptions(),
    maxAge: 0,
  })
}

// Shape of login / signup / accept-invite / change-password. Production
// clients must not receive a durable JWT they could put in localStorage.
export function sessionResponse(user, token, extra = {}, {
  env = process.env.NODE_ENV,
  vercelEnv = process.env.VERCEL_ENV,
} = {}) {
  const body = { ...extra }
  if (user) body.user = user
  if (!productionLike({ env, vercelEnv })) body.token = token
  return body
}

// Missing Origin is an intentional allow. SameSite=Lax is the primary
// CSRF control for a classic cross-site POST (the cookie is not sent).
// The Origin allowlist is defense-in-depth when the header IS present
// (supertest, curl, and some same-origin navigations omit it). Do not
// require Origin without updating those callers — that is a behavior
// change. The literal Origin value "null" (opaque / sandboxed) is
// present and not on the allowlist, so it is 403 csrf_origin.
export function rejectCrossSiteMutation(req, res, next) {
  const method = req.method
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next()
  if (!readCookie(req, SESSION_COOKIE)) return next()
  const origin = req.headers.origin
  if (!origin || isAllowedOrigin(origin)) return next()
  if (isSameOriginRequest(origin, req)) return next()
  return res.status(403).json({
    error: 'Cross-site request refused',
    code: 'csrf_origin',
  })
}
