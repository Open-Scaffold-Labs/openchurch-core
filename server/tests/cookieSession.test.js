// OC-READY-01-011 — httpOnly SameSite=Lax cookie sessions.
//
// CSRF strategy under test: SameSite=Lax is the browser control (cross-site
// POST/fetch will not include the cookie). Defense in depth: a cookie-bearing
// mutation whose Origin is present and not on the allowlist is 403
// csrf_origin. GET is not a mutation. No-Origin (curl, this suite) passes.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import 'dotenv/config'

import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'
import {
  SESSION_COOKIE,
  sessionCookieOptions,
  extractSessionToken,
  sessionResponse,
  isAllowedOrigin,
  isVitestHarness,
  isSameOriginRequest,
  productionLike,
  bearerAllowed,
} from '../src/auth/sessionCookie.js'

const SECRET = process.env.JWT_SECRET || 'dev-only-change-me-please'

function setCookieLines(res) {
  const raw = res.headers['set-cookie']
  if (!raw) return []
  return Array.isArray(raw) ? raw : [raw]
}

function sessionCookieLine(res) {
  return setCookieLines(res).find(c => c.startsWith(`${SESSION_COOKIE}=`)) || ''
}

function cookieHeaderFrom(res) {
  return setCookieLines(res).map(c => c.split(';')[0]).join('; ')
}

let server
const cleanupOrgIds = []

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
}, 60_000)

afterAll(async () => {
  for (const id of cleanupOrgIds) {
    await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
  }
  await closeServer(server)
})

describe('session cookie flags (unit)', () => {
  it('production is httpOnly + Secure + SameSite=Lax', () => {
    expect(sessionCookieOptions({ env: 'production' })).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
    })
  })

  it('non-production drops Secure so http://localhost can hold the cookie', () => {
    expect(sessionCookieOptions({ env: 'test' })).toMatchObject({
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
    })
  })

  it('production omits the JWT from the JSON body', () => {
    const body = sessionResponse({ id: 1 }, 'secret.jwt', {}, { env: 'production' })
    expect(body.token).toBeUndefined()
    expect(body.user.id).toBe(1)
  })

  it('test/dev still return a token so the existing Bearer suite keeps working', () => {
    const body = sessionResponse({ id: 1 }, 'secret.jwt', {}, { env: 'test' })
    expect(body.token).toBe('secret.jwt')
  })

  it('production requireAuth reads the cookie and refuses Bearer', () => {
    expect(extractSessionToken(
      { headers: { cookie: `${SESSION_COOKIE}=cookie-jwt` } },
      { env: 'production', inTest: false },
    )).toBe('cookie-jwt')
    expect(extractSessionToken(
      { headers: { authorization: 'Bearer header-jwt' } },
      { env: 'production', inTest: false },
    )).toBeNull()
  })

  it('NODE_ENV=production refuses Bearer even inside the Vitest process (no test exception)', () => {
    // Regression (TARS review of b08f1a7): bearerAllowed({ env: 'production',
    // vercelEnv: undefined, inTest: true }) returned true. Production has no
    // test hatch; a fixture that needs production semantics authenticates
    // with the session cookie like the production client does.
    expect(extractSessionToken(
      { headers: { authorization: 'Bearer header-jwt' } },
      { env: 'production', vercelEnv: undefined, inTest: true },
    )).toBeNull()
  })

  it('non-production still accepts Bearer so isolation tests do not rewrite', () => {
    expect(extractSessionToken(
      { headers: { authorization: 'Bearer header-jwt' } },
      { env: 'test' },
    )).toBe('header-jwt')
  })

  it('cookie wins when both are present', () => {
    expect(extractSessionToken({
      headers: {
        cookie: `${SESSION_COOKIE}=from-cookie`,
        authorization: 'Bearer from-header',
      },
    })).toBe('from-cookie')
  })
})

describe('SameSite CSRF origin allowlist (unit)', () => {
  it('no Origin is not a browser CSRF vector', () => {
    expect(isAllowedOrigin(undefined)).toBe(true)
  })

  it('localhost is allowed outside production', () => {
    expect(isAllowedOrigin('http://localhost:5202', { env: 'test' })).toBe(true)
    expect(isAllowedOrigin('http://localhost:5204', { env: 'test' })).toBe(true)
  })

  it('127.0.0.1 and [::1] are allowed outside production', () => {
    expect(isAllowedOrigin('http://127.0.0.1:5202', { env: 'test' })).toBe(true)
    expect(isAllowedOrigin('http://127.0.0.1:5204', { env: 'test' })).toBe(true)
    expect(isAllowedOrigin('http://[::1]:5202', { env: 'test' })).toBe(true)
    expect(isAllowedOrigin('http://[::1]:5204', { env: 'test' })).toBe(true)
  })

  it('127.0.0.1 and [::1] are refused in production', () => {
    // localhost may still pass if CLIENT_URL / CORS_ORIGINS names it;
    // the loopback-IP regex itself is env-gated off in production.
    expect(isAllowedOrigin('http://127.0.0.1:5202', { env: 'production' })).toBe(false)
    expect(isAllowedOrigin('http://[::1]:5202', { env: 'production' })).toBe(false)
  })

  it('a foreign origin is refused', () => {
    expect(isAllowedOrigin('https://evil.example', { env: 'test' })).toBe(false)
    expect(isAllowedOrigin('https://evil.example', { env: 'production' })).toBe(false)
  })

  it('the literal Origin value null is not an allowed origin', () => {
    expect(isAllowedOrigin('null', { env: 'test' })).toBe(false)
    expect(isAllowedOrigin('null', { env: 'production' })).toBe(false)
  })
})

describe('VITEST hatch (unit)', () => {
  it('only true or 1 count; production deploys must leave VITEST unset', () => {
    expect(isVitestHarness('true')).toBe(true)
    expect(isVitestHarness('1')).toBe(true)
    expect(isVitestHarness('yes')).toBe(false)
    expect(isVitestHarness('production')).toBe(false)
    expect(isVitestHarness('')).toBe(false)
  })
})

describe('login/signup set the session cookie; /me works without Bearer', () => {
  const org = {
    organizationName: `Cookie Parish ${RUN_ID}`,
    name: 'Cookie Secretary',
    email: `cookie_${RUN_ID}@example.com`,
    password: 'cookie-session-pw-1',
  }
  let cookie

  it('signup Set-Cookie is httpOnly SameSite=Lax and names ochr_session', async () => {
    const res = await createOrg(server, org, '10.88.0.1')
    expect(res.status).toBe(201)
    cleanupOrgIds.push(res.body.user.organization.id)
    const line = sessionCookieLine(res)
    expect(line, 'signup must Set-Cookie ochr_session').toBeTruthy()
    expect(line).toMatch(/HttpOnly/i)
    expect(line).toMatch(/SameSite=Lax/i)
    expect(line).not.toMatch(/Secure/i) // NODE_ENV=test
    cookie = cookieHeaderFrom(res)
    expect(cookie).toMatch(new RegExp(`^${SESSION_COOKIE}=`))
  })

  it('GET /me with only the cookie is 200', async () => {
    const res = await request(server).get('/api/auth/me').set('Cookie', cookie)
    expect(res.status).toBe(200)
    expect(res.body.user.email).toBe(org.email.toLowerCase())
  })

  it('GET /me with neither cookie nor Bearer is 401', async () => {
    const res = await request(server).get('/api/auth/me')
    expect(res.status).toBe(401)
  })

  it('login refreshes the same cookie flags', async () => {
    const res = await request(server).post('/api/auth/login')
      .set('X-Forwarded-For', '10.88.0.2')
      .send({ email: org.email, password: org.password })
    expect(res.status).toBe(200)
    const line = sessionCookieLine(res)
    expect(line).toMatch(/HttpOnly/i)
    expect(line).toMatch(/SameSite=Lax/i)
    cookie = cookieHeaderFrom(res)
  })

  it('an authenticated write works via cookie (state-changing, no Bearer)', async () => {
    const res = await request(server).patch('/api/auth/avatar')
      .set('Cookie', cookie)
      .send({ avatar: null })
    expect(res.status).toBe(200)
  })
})

describe('logout + logout-all clear the cookie; sibling JWT dies', () => {
  const org = {
    organizationName: `Cookie Revoke ${RUN_ID}`,
    name: 'Revoke Secretary',
    email: `cookie_rev_${RUN_ID}@example.com`,
    password: 'cookie-session-pw-2',
  }
  let cookie
  let token
  let sibling

  beforeAll(async () => {
    const signup = await createOrg(server, org, '10.88.0.3')
    expect(signup.status).toBe(201)
    cleanupOrgIds.push(signup.body.user.organization.id)
    cookie = cookieHeaderFrom(signup)
    token = signup.body.token
    const claims = jwt.decode(token)
    sibling = jwt.sign(
      { userId: claims.userId, organizationId: claims.organizationId,
        email: claims.email, name: claims.name, role: claims.role, tv: claims.tv },
      SECRET, { expiresIn: '6d' },
    )
  })

  it('CONTROL: both this cookie and a sibling JWT work before revoke', async () => {
    const viaCookie = await request(server).get('/api/auth/me').set('Cookie', cookie)
    expect(viaCookie.status).toBe(200)
    const viaSibling = await request(server).get('/api/auth/me')
      .set('Authorization', `Bearer ${sibling}`)
    expect(viaSibling.status).toBe(200)
  })

  it('logout clears the cookie; token_version is unchanged so a sibling still lives', async () => {
    const out = await request(server).post('/api/auth/logout').set('Cookie', cookie)
    expect(out.status).toBe(204)
    const cleared = sessionCookieLine(out)
    expect(cleared).toMatch(new RegExp(`${SESSION_COOKIE}=`))
    expect(cleared).toMatch(/Max-Age=0|Expires=/i)

    const siblingStill = await request(server).get('/api/auth/me')
      .set('Authorization', `Bearer ${sibling}`)
    expect(siblingStill.status).toBe(200)
  })

  it('logout-all bumps token_version, clears the cookie, and kills the sibling', async () => {
    const relogin = await request(server).post('/api/auth/login')
      .set('X-Forwarded-For', '10.88.0.4')
      .send({ email: org.email, password: org.password })
    expect(relogin.status).toBe(200)
    const liveCookie = cookieHeaderFrom(relogin)
    const liveToken = relogin.body.token
    const claims = jwt.decode(liveToken)
    const liveSibling = jwt.sign(
      { userId: claims.userId, organizationId: claims.organizationId,
        email: claims.email, name: claims.name, role: claims.role, tv: claims.tv },
      SECRET, { expiresIn: '6d' },
    )

    const revoke = await request(server).post('/api/auth/logout-all')
      .set('Cookie', liveCookie)
    expect(revoke.status).toBe(204)
    expect(sessionCookieLine(revoke)).toMatch(new RegExp(`${SESSION_COOKIE}=`))
    expect(sessionCookieLine(revoke)).toMatch(/Max-Age=0|Expires=/i)

    const afterCookie = await request(server).get('/api/auth/me').set('Cookie', liveCookie)
    expect(afterCookie.status).toBe(401)
    const afterSelf = await request(server).get('/api/auth/me')
      .set('Authorization', `Bearer ${liveToken}`)
    expect(afterSelf.status).toBe(401)
    const afterSibling = await request(server).get('/api/auth/me')
      .set('Authorization', `Bearer ${liveSibling}`)
    expect(afterSibling.status).toBe(401)
  })
})

describe('CSRF — state-changing routes under SameSite=Lax + Origin allowlist', () => {
  const org = {
    organizationName: `Cookie CSRF ${RUN_ID}`,
    name: 'CSRF Secretary',
    email: `cookie_csrf_${RUN_ID}@example.com`,
    password: 'cookie-session-pw-3',
  }
  let cookie

  beforeAll(async () => {
    const signup = await createOrg(server, org, '10.88.0.5')
    expect(signup.status).toBe(201)
    cleanupOrgIds.push(signup.body.user.organization.id)
    cookie = cookieHeaderFrom(signup)
  })

  it('CONTROL: cookie + no Origin (same-origin / this suite) may mutate', async () => {
    const res = await request(server).patch('/api/auth/avatar')
      .set('Cookie', cookie)
      .send({ avatar: null })
    expect(res.status).toBe(200)
  })

  it('CONTROL: cookie + an allowed localhost Origin may mutate', async () => {
    const res = await request(server).patch('/api/auth/avatar')
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:5202')
      .send({ avatar: null })
    expect(res.status).toBe(200)
  })

  it('ATTACK: cookie + Origin: null on a mutation is 403 csrf_origin', async () => {
    // Opaque / sandboxed browsers send the literal string "null".
    // That is a present Origin, not a missing one — refuse it.
    const res = await request(server).patch('/api/auth/avatar')
      .set('Cookie', cookie)
      .set('Origin', 'null')
      .send({ avatar: null })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('csrf_origin')
  })

  it('ATTACK: cookie + a foreign Origin on a mutation is 403 csrf_origin', async () => {
    const res = await request(server).patch('/api/auth/avatar')
      .set('Cookie', cookie)
      .set('Origin', 'https://evil.example')
      .send({ avatar: null })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('csrf_origin')
  })

  it('ATTACK: cookie + foreign Origin cannot logout-all (state-changing)', async () => {
    const res = await request(server).post('/api/auth/logout-all')
      .set('Cookie', cookie)
      .set('Origin', 'https://evil.example')
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('csrf_origin')

    const still = await request(server).get('/api/auth/me').set('Cookie', cookie)
    expect(still.status).toBe(200)
  })

  it('GET is not a CSRF mutation — foreign Origin still reads /me (Lax)', async () => {
    const res = await request(server).get('/api/auth/me')
      .set('Cookie', cookie)
      .set('Origin', 'https://evil.example')
    expect(res.status).toBe(200)
  })
})


// ---------------------------------------------------------------------------
// Same-origin fallback + platform-set production signal (2026-09-24).
//
// Production ran with no CLIENT_URL / DIOCESE_CLIENT_URL / CORS_ORIGINS, so
// the allowlist was empty and every cookie-bearing browser mutation carried
// an Origin that could not match it. A same-origin request (Origin host ==
// the raw Host header) is now accepted without an allowlist; a foreign one
// still fails closed. Only `Host` is read: never X-Forwarded-Host.
// ---------------------------------------------------------------------------

// A neutral production-shaped host (Vercel project domain form). Any real
// deployment alias would trip the public snapshot's live-identifier guard;
// the same-origin logic only compares Origin host with the raw Host header.
const PROD_HOST = 'openchurch-example.vercel.app'
const PROD_ORIGIN = `https://${PROD_HOST}`

describe('productionLike (unit)', () => {
  it('NODE_ENV=production is production-like', () => {
    expect(productionLike({ env: 'production', vercelEnv: undefined })).toBe(true)
  })

  it('a Vercel production or preview runtime is production-like even with NODE_ENV unset', () => {
    expect(productionLike({ env: undefined, vercelEnv: 'production' })).toBe(true)
    expect(productionLike({ env: undefined, vercelEnv: 'preview' })).toBe(true)
  })

  it('test, local and `vercel dev` are not', () => {
    expect(productionLike({ env: 'test', vercelEnv: undefined })).toBe(false)
    expect(productionLike({ env: undefined, vercelEnv: undefined })).toBe(false)
    expect(productionLike({ env: 'development', vercelEnv: 'development' })).toBe(false)
  })

  it('NODE_ENV unset on a Vercel deploy still closes Secure, token echo, and loopback', () => {
    const deployed = { env: undefined, vercelEnv: 'production' }
    expect(sessionCookieOptions(deployed).secure).toBe(true)
    expect(sessionResponse({ id: 1 }, 'secret.jwt', {}, deployed).token).toBeUndefined()
    expect(isAllowedOrigin('http://127.0.0.1:5202', deployed)).toBe(false)
    expect(isAllowedOrigin('http://localhost:5202', deployed)).toBe(false)
  })
})

describe('bearerAllowed — the VITEST hatch cannot reopen Bearer on a deploy (unit)', () => {
  it('a stray VITEST on a Vercel production or preview runtime is ignored', () => {
    expect(bearerAllowed({ env: 'production', vercelEnv: 'production', inTest: true })).toBe(false)
    expect(bearerAllowed({ env: 'production', vercelEnv: 'preview', inTest: true })).toBe(false)
    expect(bearerAllowed({ env: undefined, vercelEnv: 'production', inTest: true })).toBe(false)
    expect(extractSessionToken(
      { headers: { authorization: 'Bearer header-jwt' } },
      { env: 'production', vercelEnv: 'production', inTest: true },
    )).toBeNull()
  })

  it('NODE_ENV unset on a Vercel deploy refuses Bearer', () => {
    expect(bearerAllowed({ env: undefined, vercelEnv: 'production', inTest: false })).toBe(false)
  })

  it('production refuses Bearer outside Vercel too, whatever VITEST says', () => {
    // The exact TARS probe.
    expect(bearerAllowed({ env: 'production', vercelEnv: undefined, inTest: true })).toBe(false)
    expect(bearerAllowed({ env: 'production', vercelEnv: undefined, inTest: false })).toBe(false)
  })

  it('non-production (test, dev, `vercel dev`) still accepts Bearer', () => {
    expect(bearerAllowed({ env: 'test', vercelEnv: undefined })).toBe(true)
    expect(bearerAllowed({ env: 'development', vercelEnv: 'development' })).toBe(true)
    expect(bearerAllowed({ env: undefined, vercelEnv: undefined })).toBe(true)
  })
})

describe('isSameOriginRequest (unit)', () => {
  const req = (host, extra = {}) => ({ headers: { host, ...extra } })
  const prod = { env: 'production', vercelEnv: 'production' }
  const dev = { env: 'test', vercelEnv: undefined }

  it('https Origin whose host equals Host is same-origin in production', () => {
    expect(isSameOriginRequest(PROD_ORIGIN, req(PROD_HOST), prod)).toBe(true)
    expect(isSameOriginRequest(`${PROD_ORIGIN}/`, req(PROD_HOST), prod)).toBe(true)
  })

  it('host comparison is case-insensitive and exact on port', () => {
    expect(isSameOriginRequest(PROD_ORIGIN, req(PROD_HOST.toUpperCase()), prod)).toBe(true)
    expect(isSameOriginRequest('http://localhost:5202', req('localhost:5202'), dev)).toBe(true)
    expect(isSameOriginRequest('http://localhost:5202', req('localhost:3034'), dev)).toBe(false)
  })

  it('a foreign Origin is not same-origin', () => {
    expect(isSameOriginRequest('https://evil.example', req(PROD_HOST), prod)).toBe(false)
    expect(isSameOriginRequest(`https://${PROD_HOST}.evil.example`, req(PROD_HOST), prod)).toBe(false)
    expect(isSameOriginRequest(`https://evil${PROD_HOST}`, req(PROD_HOST), prod)).toBe(false)
  })

  it('http in production is refused even on the right host', () => {
    expect(isSameOriginRequest(`http://${PROD_HOST}`, req(PROD_HOST), prod)).toBe(false)
  })

  it('opaque, malformed and non-origin values are refused', () => {
    for (const bad of [
      'null', '', ' ', 'not a url', PROD_HOST, `ftp://${PROD_HOST}`,
      `${PROD_ORIGIN}/path`, `${PROD_ORIGIN}?q=1`, `https://user@${PROD_HOST}`,
      `javascript:alert(1)`, `data:text/html,x`,
    ]) {
      expect(isSameOriginRequest(bad, req(PROD_HOST), prod), bad).toBe(false)
    }
  })

  it('a missing or empty Host is never same-origin', () => {
    expect(isSameOriginRequest(PROD_ORIGIN, { headers: {} }, prod)).toBe(false)
    expect(isSameOriginRequest(PROD_ORIGIN, req(''), prod)).toBe(false)
    expect(isSameOriginRequest(PROD_ORIGIN, undefined, prod)).toBe(false)
  })

  it('X-Forwarded-Host is never consulted', () => {
    expect(isSameOriginRequest('https://evil.example',
      req(PROD_HOST, { 'x-forwarded-host': 'evil.example' }), prod)).toBe(false)
    expect(isSameOriginRequest(PROD_ORIGIN,
      req('internal.invalid', { 'x-forwarded-host': PROD_HOST }), prod)).toBe(false)
  })
})

describe('CSRF — production-like deploy with an EMPTY allowlist (the 2026-09-24 shape)', () => {
  const org = {
    organizationName: `Cookie SameOrigin ${RUN_ID}`,
    name: 'SameOrigin Secretary',
    email: `cookie_so_${RUN_ID}@example.com`,
    password: 'cookie-session-pw-4',
  }
  const ENV_KEYS = ['VERCEL_ENV', 'CLIENT_URL', 'DIOCESE_CLIENT_URL', 'CORS_ORIGINS']
  let saved
  let cookie

  beforeAll(async () => {
    const signup = await createOrg(server, org, '10.88.0.6')
    expect(signup.status).toBe(201)
    cleanupOrgIds.push(signup.body.user.organization.id)
    cookie = cookieHeaderFrom(signup)
  })

  // Every request below runs as a deployed Vercel production runtime with no
  // origin allowlist configured — exactly what production was serving.
  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
    process.env.VERCEL_ENV = 'production'
    delete process.env.CLIENT_URL
    delete process.env.DIOCESE_CLIENT_URL
    delete process.env.CORS_ORIGINS
  })

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  const mutate = () => request(server).patch('/api/auth/avatar')
    .set('Cookie', cookie)
    .send({ avatar: null })

  it('same-origin browser mutation succeeds (Origin == Host, https, Vercel-shaped headers)', async () => {
    const res = await mutate()
      .set('Host', PROD_HOST)
      .set('Origin', PROD_ORIGIN)
      .set('X-Forwarded-Host', PROD_HOST)
      .set('X-Forwarded-Proto', 'https')
    expect(res.status).toBe(200)
  })

  it('a foreign Origin is still 403 csrf_origin', async () => {
    const res = await mutate().set('Host', PROD_HOST).set('Origin', 'https://evil.example')
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('csrf_origin')
  })

  it('a forged X-Forwarded-Host matching the foreign Origin does not help', async () => {
    const res = await mutate()
      .set('Host', PROD_HOST)
      .set('Origin', 'https://evil.example')
      .set('X-Forwarded-Host', 'evil.example')
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('csrf_origin')
  })

  it('Origin: null and a malformed Origin are still 403 csrf_origin', async () => {
    for (const bad of ['null', 'not a url', `${PROD_ORIGIN}/x`]) {
      const res = await mutate().set('Host', PROD_HOST).set('Origin', bad)
      expect(res.status, bad).toBe(403)
      expect(res.body.code).toBe('csrf_origin')
    }
  })

  it('http on the right host is refused in production', async () => {
    const res = await mutate().set('Host', PROD_HOST).set('Origin', `http://${PROD_HOST}`)
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('csrf_origin')
  })

  it('a configured CLIENT_URL still succeeds from a different host', async () => {
    process.env.CLIENT_URL = 'https://parish.example.org'
    const res = await mutate()
      .set('Host', PROD_HOST)
      .set('Origin', 'https://parish.example.org')
    expect(res.status).toBe(200)
  })

  it('loopback is not a production origin', async () => {
    const res = await mutate().set('Host', PROD_HOST).set('Origin', 'http://127.0.0.1:5202')
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('csrf_origin')
  })

  it('no Origin still passes (documented behaviour, unchanged)', async () => {
    const res = await mutate().set('Host', PROD_HOST)
    expect(res.status).toBe(200)
  })
})
