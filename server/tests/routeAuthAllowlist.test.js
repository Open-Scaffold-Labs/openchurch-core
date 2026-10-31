// Route-auth allowlist guard (SP-215 / Argus F1-F3, hardened for Argus R427).
//
// a16cc113 was pushed straight to main with two `app.all` handlers on 10 paths
// registered before every requireAuth, so the production API answered them
// with no session. #427 removed them and added a first version of this guard.
// Argus R427 showed that version only saw APP-LEVEL registrations: a route
// added inside an allowlisted router (routes/auth.js, routes/schedule.js...),
// a path-less app.use(fn), app.route()/head/options, and express() sub-apps
// all got through, and it only ever sent GET.
//
// This version reads the FINAL router tree instead of hooking registration
// calls, so it does not matter which API added a layer:
//
//   1. Tree walk. Every layer of app.router is visited recursively, through
//      every mounted sub-router, producing one LEAF per (HTTP method, full
//      path) and the ordered chain of functions a request runs through to
//      reach it (covering middleware from every ancestor + the route's own
//      stack). Router paths are recorded by tagging layers as they are
//      created (Router.prototype.use / Router.prototype.route).
//   2. Static rule. A leaf passes if requireAuth is in its chain BEFORE any
//      function that is not known pre-auth plumbing (R427-5: position, not
//      mere presence), or if its exact `METHOD /full/path` is on
//      PUBLIC_ROUTES — and then the control named for it there (rate
//      limiter, raw-body signature parser, CRON_SECRET guard, body cap) must
//      actually be in its chain (R427-6). Allowlist entries that match no
//      leaf fail too, so the list cannot rot.
//   3. Middleware rule (R427-3). Any non-router middleware that runs before
//      requireAuth must be one of the exact function objects exported by
//      app.js (by identity). Sub-apps (express() instances) and ad-hoc
//      `app.use(fn)` / `app.use('/x', fn)` handlers therefore fail.
//   4. Behaviour. Every non-allowlisted leaf is called with ITS OWN method
//      (ALL -> GET/POST/PUT/PATCH/DELETE) and no cookie / Authorization, and
//      must answer 401. CRON_SECRET-guarded leaves must answer 401 too. The
//      10 removed books v3.3 paths must not answer 2xx.
//   5. Late registration. The tree is walked again after the sweep and must
//      be unchanged (a handler that registers a route at request time).
//   6. Other entry points (R427-4). The repo-root api/ directory (Vercel
//      functions, served before the /api rewrite) holds exactly index.js.
//
// Adding a public route is a deliberate act: add its exact METHOD + path to
// PUBLIC_ROUTES with the reason and the control, in a reviewed PR.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { createRequire } from 'node:module'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import 'dotenv/config'

const require = createRequire(import.meta.url)

// Controls a public leaf can be required to carry.
//   none       — static / probe / filtered read; nothing structural to assert
//   limiter    — an express-rate-limit instance sits in its chain
//   rawBody    — express.raw() runs first (provider signature over raw bytes)
//   bodyCap    — app.js's 32 KB parser runs before the 10 MB one
//   cronSecret — requireCronAuth runs before the handler
const R = (reason, ...controls) => ({ reason, controls: controls.length ? controls : ['none'] })

const CRON_JOBS = [
  'retention-prune', 'enqueue-birthdays', 'drain-notifications', 'charge-recurring',
  'weekly-serving-digest', 'enqueue-sacrament-anniversaries', 'backup-digest', 'nudge-swaps',
]

const PUBLIC_ROUTES = new Map([
  ['GET /health', R('health probe')],
  ['GET /api/health', R('health probe')],
  ['GET /.well-known/agent-booking.json', R('static informational manifest')],
  ['GET /api/.well-known/agent-booking.json', R('static informational manifest')],

  ['GET /api/billing/nonprofit-fee-guide', R('static fee guide')],
  ['GET /api/billing/nonprofit-rate-guide', R('static fee guide')],
  ['POST /api/billing/webhook', R('payment-provider webhook; signature verified over raw body', 'rawBody')],
  ['POST /api/email/webhook', R('email-provider webhook; Svix signature over raw body', 'rawBody')],

  ['POST /api/auth/signup', R('creates an account', 'limiter')],
  ['POST /api/auth/login', R('sign-in', 'limiter')],
  ['POST /api/auth/logout', R('clears the session cookie only')],
  ['POST /api/auth/forgot-password', R('sends a reset link', 'limiter')],
  ['POST /api/auth/reset-password', R('single-use token in body', 'limiter')],
  ['POST /api/auth/accept-invite', R('single-use token in body', 'limiter')],

  ['GET /api/calendar-sync/:token.ics', R('ICS capability URL (token in path)', 'limiter')],

  ['GET /api/schedule/feed.ics', R('static sample feed, not parish data')],
  ['GET /api/schedule/mode', R('static mode descriptor')],
  ['GET /api/schedule/mcp', R('static MCP tool discovery')],
  ['POST /api/schedule/facility-hold', R('synthetic evaluation, no persistence', 'limiter', 'bodyCap')],
  ['POST /api/schedule/volunteer-roster', R('synthetic evaluation, no persistence', 'limiter', 'bodyCap')],
  ['POST /api/schedule/mcp', R('synthetic evaluation, no persistence', 'limiter', 'bodyCap')],

  ['GET /api/public/:slug', R('public parish page (is_public filter)')],
  ['GET /api/public/:slug/page', R('public parish page (is_public filter)')],
  ['GET /api/public/:slug/groups', R('public groups (is_public filter)')],
  ['POST /api/public/:slug/connect', R('connect card', 'limiter')],
  ['GET /api/public/:slug/funds', R('public funds list')],
  ['POST /api/public/:slug/give', R('online giving', 'limiter')],
  ['GET /api/public/:slug/events', R('public events (is_public filter)')],
  ['GET /api/public/:slug/events.ics', R('public events feed (is_public filter)')],
  ['GET /api/public/:slug/bulletin', R('published bulletin')],
  ['GET /api/public/forms/:orgSlug/:formSlug', R('public form (is_public AND open)')],
  ['POST /api/public/forms/:orgSlug/:formSlug/submit', R('public form submit', 'limiter')],

  ['GET /api/swap/by-token/:token/members', R('swap capability token', 'limiter')],
  ['GET /api/swap/by-token/:token', R('swap capability token', 'limiter')],
  ['PATCH /api/swap/by-token/:token/reminders', R('swap capability token', 'limiter')],
  ['POST /api/swap/by-token/:token/request', R('swap capability token', 'limiter')],
  ['POST /api/swap/by-token/:token/accept', R('swap capability token', 'limiter')],
  ['POST /api/swap/by-token/:token/decline', R('swap capability token', 'limiter')],
  ['POST /api/swap/by-token/:token/cancel', R('swap capability token', 'limiter')],

  ['GET /api/kiosk/:token', R('kiosk capability token', 'limiter')],
  ['GET /api/kiosk/:token/members', R('kiosk capability token', 'limiter')],
  ['POST /api/kiosk/:token/checkin', R('kiosk capability token', 'limiter')],

  ['GET /api/hall-sign/:token', R('hall agreement read (token in path; no charge)', 'limiter')],
  ['POST /api/hall-sign/:token/sign', R('hall agreement sign (token in path; no charge)', 'limiter')],
  ['POST /api/hall-sign/:token/decline', R('hall agreement decline (token in path; no charge)', 'limiter')],

  ['GET /api/unsubscribe/:token', R('RFC 8058 HMAC link (timing-safe)')],
  ['POST /api/unsubscribe/:token', R('RFC 8058 HMAC link (timing-safe)')],

  ...CRON_JOBS.flatMap(j => [
    [`GET /api/cron/${j}`, R('Vercel cron; CRON_SECRET bearer, not JWT', 'cronSecret')],
    [`POST /api/cron/${j}`, R('Vercel cron; CRON_SECRET bearer, not JWT', 'cronSecret')],
  ]),
])

const REMOVED_BOOKS_V33 = [
  '/api/onboarding/self-serve', '/onboarding/self-serve',
  '/api/licensing/self-serve', '/licensing/self-serve',
  '/api/books/v33', '/books/v33',
  '/api/accounting/books-v33', '/accounting/books-v33',
  '/api/agent/bot-dashboard', '/agent/bot-dashboard',
]

const SWEEP_ALL_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

let app, appModule, requireAuth, requireCronAuth, server
let tree, treeAfterImport
let instrumentationMisses = []
const savedCronSecret = process.env.CRON_SECRET

// ── Instrumentation: remember the path each router layer was created with.
// router@2 Layers do not keep the original path string, so the walker would
// otherwise only see compiled matchers. Router.prototype.use / .route are
// the only two places a Layer is pushed onto a Router stack (app.use,
// app.METHOD, app.route, router.METHOD, express() sub-app mounts all funnel
// through them).
const Router = require('router')
const origUse = Router.prototype.use
function taggedUse(handler, ...rest) {
  const before = this.stack.length
  const out = origUse.call(this, handler, ...rest)
  let path = '/'
  if (typeof handler !== 'function') {
    let a = handler
    while (Array.isArray(a) && a.length) a = a[0]
    if (typeof a !== 'function') path = handler
  }
  for (let i = before; i < this.stack.length; i++) this.stack[i].__ocPath = path
  return out
}

function joinPath(prefix, p) {
  if (p === '/' || p === '') return prefix || '/'
  return (prefix === '/' ? '' : prefix) + p
}

// Does a middleware mounted at `mount` run for a request to `full`? Mount
// params (`/api/events/:id/attendance`) match any one segment, which the
// literal `:id` in a leaf path also satisfies.
function covers(mount, full) {
  if (mount === '/') return true
  const re = new RegExp('^' + mount.split('/').map(s => (s.startsWith(':') ? '[^/]+' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/') + '(?:/|$)')
  return re.test(full)
}

const isRouter = fn => typeof fn === 'function' && Array.isArray(fn.stack) && 'params' in fn
const isLimiter = fn => typeof fn === 'function' && typeof fn.resetKey === 'function' && typeof fn.getKey === 'function'

function walkTree(rootStack, sets) {
  const leaves = []
  const middleware = []
  const problems = []
  const visit = (stack, prefix, inherited) => {
    const scope = [...inherited]
    for (const layer of stack) {
      if (!('__ocPath' in layer) && !layer.route) {
        problems.push(`untagged layer ${layer.name} under ${prefix || '/'}`)
      }
      const rawPaths = layer.route ? [].concat(layer.route.path) : [].concat(layer.__ocPath ?? '/')
      for (const raw of rawPaths) {
        if (typeof raw !== 'string') {
          problems.push(`non-string path ${String(raw)} under ${prefix || '/'} (cannot be allowlisted)`)
          continue
        }
        const full = joinPath(prefix, raw)
        if (layer.route) {
          const methods = Object.keys(layer.route.methods)
          for (const m of methods) {
            const method = m === '_all' ? 'ALL' : m.toUpperCase()
            const own = layer.route.stack
              .filter(l => l.method === undefined || l.method === m)
              .map(l => l.handle)
            // A route whose every handler is known pass-through plumbing
            // (the 32 KB parser on the public schedule POSTs) is not an
            // endpoint; it is middleware for that exact METHOD + path.
            if (own.length && own.every(fn => sets.passThrough.has(fn))) {
              for (const fn of own) scope.push({ mount: full, exact: true, method, fn })
              continue
            }
            const chain = [
              ...scope.filter(c => (c.exact ? c.mount === full && (c.method === method || c.method === 'ALL') : covers(c.mount, full))).map(c => c.fn),
              ...own,
            ]
            leaves.push({ method, path: full, chain })
          }
        } else if (isRouter(layer.handle)) {
          visit(layer.handle.stack, full, scope)
        } else {
          const chain = scope.filter(c => !c.exact && covers(c.mount, full)).map(c => c.fn)
          middleware.push({ mount: full, fn: layer.handle, name: layer.name, chain })
          scope.push({ mount: full, fn: layer.handle })
        }
      }
    }
  }
  visit(rootStack, '', [])
  return { leaves, middleware, problems }
}

// Which guard, if any, a request meets first. Pre-auth plumbing is skipped;
// error handlers (arity 4) never run on the success path. Anything else
// reached before a guard means code runs without auth.
function firstGuard(chain, sets) {
  for (const fn of chain) {
    if (fn === requireAuth) return 'requireAuth'
    if (fn === requireCronAuth) return 'requireCronAuth'
    if (typeof fn === 'function' && fn.length === 4) continue
    if (sets.preAuth.has(fn) || sets.passThrough.has(fn)) continue
    return null
  }
  return null
}

function concrete(p) {
  return p
    .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, '00000000-0000-0000-0000-000000000000')
    .replace(/\*[A-Za-z_][A-Za-z0-9_]*/g, 'x')
    .replace(/[{}]/g, '')
}

function serialise(t) {
  return t.leaves.map(l => `${l.method} ${l.path} [${l.chain.length}]`).join('\n')
}

let sets
beforeAll(async () => {
  Router.prototype.use = taggedUse
  try {
    ;({ requireAuth } = await import('../src/middleware/auth.js'))
    ;({ requireCronAuth } = await import('../src/middleware/cronAuth.js'))
    appModule = await import('../src/app.js')
    app = appModule.default
  } finally {
    Router.prototype.use = origUse
  }
  const { rejectCrossSiteMutation } = await import('../src/auth/sessionCookie.js')
  sets = {
    // Path-less middleware allowed before requireAuth — by identity only.
    preAuth: new Set([
      appModule.corsMiddleware,
      appModule.securityHeaders,
      appModule.jsonBodyParser,
      rejectCrossSiteMutation,
    ]),
    passThrough: new Set([appModule.publicScheduleJsonParser]),
    errorHandlers: new Set([appModule.errorHandler]),
  }
  tree = walkTree(app.router.stack, sets)
  treeAfterImport = serialise(tree)
  // requireCronAuth answers 503 when CRON_SECRET is unset; set a throwaway
  // value so the sweep proves the guard answers 401 without the bearer.
  process.env.CRON_SECRET = `route-guard-test-${Math.random().toString(36).slice(2)}`
  server = app.listen(0, '127.0.0.1')
  await new Promise(r => server.once('listening', r))
})

afterAll(async () => {
  if (savedCronSecret === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = savedCronSecret
  if (server) await new Promise(r => server.close(r))
})

describe('route-auth allowlist (router-tree walk)', () => {
  it('walked the whole tree: every layer tagged, every path a string', () => {
    expect(typeof requireAuth).toBe('function')
    expect(tree.problems).toEqual([])
    expect(tree.leaves.length).toBeGreaterThan(300)
    expect(tree.leaves.filter(l => firstGuard(l.chain, sets) === 'requireAuth').length).toBeGreaterThan(250)
  })

  it('every leaf is behind requireAuth (first) or is an exact METHOD+path on PUBLIC_ROUTES', () => {
    const bad = []
    for (const l of tree.leaves) {
      const key = `${l.method} ${l.path}`
      if (PUBLIC_ROUTES.has(key)) continue
      if (firstGuard(l.chain, sets) !== 'requireAuth') bad.push(key)
    }
    expect(bad).toEqual([])
  })

  it('every PUBLIC_ROUTES entry matches a leaf and carries its declared control', () => {
    const byKey = new Map(tree.leaves.map(l => [`${l.method} ${l.path}`, l]))
    const bad = []
    for (const [key, { controls }] of PUBLIC_ROUTES) {
      const leaf = byKey.get(key)
      if (!leaf) { bad.push(`${key}: stale allowlist entry (no such route)`); continue }
      const before = leaf.chain.slice(0, -1)
      for (const c of controls) {
        if (c === 'none') continue
        if (c === 'limiter' && !before.some(isLimiter)) bad.push(`${key}: no rate limiter in chain`)
        if (c === 'rawBody' && !before.some(fn => fn.name === 'rawParser')) bad.push(`${key}: no raw-body parser in chain`)
        if (c === 'bodyCap' && !before.includes(appModule.publicScheduleJsonParser)) bad.push(`${key}: 32 KB parser missing`)
        if (c === 'cronSecret' && firstGuard(leaf.chain, sets) !== 'requireCronAuth') bad.push(`${key}: requireCronAuth not first guard`)
      }
    }
    expect(bad).toEqual([])
  })

  it('no unknown middleware runs before requireAuth (path-less or mounted, incl. sub-apps)', () => {
    const bad = []
    for (const m of tree.middleware) {
      if (m.fn === requireAuth || m.fn === requireCronAuth) continue
      if (sets.preAuth.has(m.fn) || sets.passThrough.has(m.fn)) continue
      if (sets.errorHandlers.has(m.fn)) continue
      if (firstGuard(m.chain, sets)) continue
      bad.push(`USE ${m.mount} ${m.name}${m.fn.length === 4 ? ' (error handler)' : ''}`)
    }
    expect(bad).toEqual([])
  })

  it('every non-allowlisted leaf answers 401 to its own method(s) with no session', async () => {
    const answered = []
    let calls = 0
    for (const l of tree.leaves) {
      const key = `${l.method} ${l.path}`
      const entry = PUBLIC_ROUTES.get(key)
      const cron = entry?.controls.includes('cronSecret')
      if (entry && !cron) continue
      const methods = l.method === 'ALL' ? SWEEP_ALL_METHODS : [l.method]
      for (const m of methods) {
        calls++
        const req = request(server)[m.toLowerCase()](concrete(l.path)).set('Accept', 'application/json')
        const res = m === 'GET' || m === 'HEAD' ? await req : await req.send({})
        if (res.status !== 401) answered.push(`${m} ${l.path} -> ${res.status}`)
      }
    }
    expect(calls).toBeGreaterThan(250)
    expect(answered).toEqual([])
  })

  it('the removed books v3.3 demo paths do not answer 2xx', async () => {
    const answered = []
    for (const p of REMOVED_BOOKS_V33) {
      for (const method of ['get', 'post']) {
        const res = await request(server)[method](p).set('Accept', 'application/json').send({})
        if (res.status >= 200 && res.status < 300) answered.push(`${method.toUpperCase()} ${p} -> ${res.status}`)
      }
    }
    expect(answered).toEqual([])
  })

  it('no route was registered after import (late / request-time registration)', () => {
    expect(serialise(walkTree(app.router.stack, sets))).toBe(treeAfterImport)
  })

  it('api/ (Vercel functions, served before the /api rewrite) holds only index.js', () => {
    const apiDir = fileURLToPath(new URL('../../api/', import.meta.url))
    expect(readdirSync(apiDir).sort()).toEqual(['index.js'])
  })
})
