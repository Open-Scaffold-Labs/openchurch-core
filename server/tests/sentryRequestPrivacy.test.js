// ARG-233-9. With a DSN set, @sentry/node 10 puts the incoming request on
// every error: the URL with its query, the Cookie header, and parsed
// cookies. The transport here is in-process. Nothing is dialed.

import crypto from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
import { _initSentryForTests } from '../src/monitoring/index.js'
import { signUnsubscribe } from '../src/notifications/unsubscribeToken.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'

const QUERY = 'Maria'
const AUTH = 'fixture-auth-header-ARG2339'
const X_TOKEN = 'fixture-x-auth-token-ARG2339'
const SESSION_HEADER = 'fixture-session-header-ARG2339'
const BODY = 'fixture-body-secret-ARG2339'

let server, token, orgId, sentry
const envelopes = []

function eventPayloads(envelope) {
  if (!Array.isArray(envelope) || !Array.isArray(envelope[1])) return []
  const out = []
  for (const item of envelope[1]) {
    const payload = Array.isArray(item) ? item[1] : null
    if (!payload || typeof payload !== 'object') continue
    if (payload.exception || payload.type === 'transaction' || payload.request) out.push(payload)
  }
  return out
}

beforeAll(async () => {
  sentry = await _initSentryForTests({
    transport() {
      return {
        send(envelope) {
          envelopes.push(envelope)
          return Promise.resolve({ statusCode: 200 })
        },
        flush() { return Promise.resolve(true) },
      }
    },
  })
  await migrateOnce()
  server = await bindServer()
  const res = await createOrg(server, {
    organizationName: `Sentry Privacy ${RUN_ID}`,
    name: 'Privacy Admin',
    email: `sentry_privacy_${RUN_ID}@example.com`,
    password: 'smoke-test-pw-233',
  }, '10.233.9.14')
  expect(res.status).toBe(201)
  token = res.body.token
  orgId = res.body.user.organization.id
}, 60_000)

afterAll(async () => {
  if (orgId) await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [orgId])
  await closeServer(server)
  if (sentry) await sentry.close(2000)
  await pool.end()
})

function pathToken() {
  return crypto.randomBytes(18).toString('base64url')
}

function rejectMatching(real, needle, message) {
  return (sql, params) => {
    if (typeof sql === 'string' && sql.includes(needle)) {
      return Promise.reject(new Error(message))
    }
    return real(sql, params)
  }
}

describe('Sentry request scrubbing', () => {
  it('drops the session cookie, auth headers, referer query, and body from a search error', async () => {
    envelopes.length = 0
    const invite = pathToken()
    const proxy = pathToken()
    const apiKey = pathToken()
    const city = pathToken()
    const real = pool.query.bind(pool)
    const spy = vi.spyOn(pool, 'query').mockImplementation(
      rejectMatching(real, 'websearch_to_tsquery', 'scope unavailable'),
    )
    try {
      const res = await request(server)
        .get(`/api/search?q=${encodeURIComponent(QUERY)}`)
        .set('Cookie', `ochr_session=${token}`)
        .set('Authorization', `Bearer ${AUTH}`)
        .set('X-Auth-Token', X_TOKEN)
        .set('X-Session-Id', SESSION_HEADER)
        .set('Referer', `http://127.0.0.1/accept-invite?token=${invite}`)
        .set('Proxy-Authorization', proxy)
        .set('Cookie2', proxy)
        .set('X-Token', proxy)
        .set('X-Api-Key', apiKey)
        .set('Api-Key', apiKey)
        .set('X-Kiosk-Code', proxy)
        .set('Stripe-Signature', proxy)
        .set('X-Vercel-Proxy-Signature', proxy)
        .set('X-Vercel-IP-City', city)
        .set('X-Forwarded-For', '203.0.113.44')
        .set('Content-Type', 'application/json')
        .send({ note: BODY })
      expect(res.status).toBe(500)
      await sentry.flush(2000)

      const payloads = envelopes.flatMap(eventPayloads)
      const serialized = JSON.stringify(envelopes)

      expect(payloads.length, 'captured sentry events').toBeGreaterThan(0)
      expect(serialized.includes(token), 'session cookie value').toBe(false)
      expect(serialized.includes(QUERY), 'query text').toBe(false)
      expect(serialized.includes(AUTH), 'authorization header').toBe(false)
      expect(serialized.includes(X_TOKEN), 'x-token header').toBe(false)
      expect(serialized.includes(SESSION_HEADER), 'session header').toBe(false)
      expect(serialized.includes(BODY), 'request body').toBe(false)
      expect(serialized.includes(invite), 'referer token').toBe(false)
      expect(serialized.includes(proxy), 'blocked header secret').toBe(false)
      expect(serialized.includes(apiKey), 'api key header').toBe(false)
      expect(serialized.includes(city), 'geo header').toBe(false)

      const urls = []
      for (const payload of payloads) {
        if (typeof payload.request?.url === 'string') urls.push(payload.request.url)
        const data = payload.contexts?.trace?.data
        if (data && typeof data === 'object') {
          for (const key of ['http.url', 'http.target', 'url', 'url.full']) {
            if (typeof data[key] === 'string') urls.push(data[key])
          }
        }
        for (const crumb of payload.breadcrumbs || []) {
          if (typeof crumb?.data?.url === 'string') urls.push(crumb.data.url)
          if (typeof crumb?.message === 'string') urls.push(crumb.message)
        }
      }
      expect(urls.some(url => url.endsWith('/api/search')), 'route path kept').toBe(true)
      expect(urls.some(url => url.includes('?')), 'query string removed from urls').toBe(false)

      const leakedHeader = payloads.some(payload => {
        const names = Object.keys(payload.request?.headers || {}).map(name => name.toLowerCase())
        return names.some(name =>
          name === 'cookie'
          || name === 'set-cookie'
          || name === 'authorization'
          || name.includes('session')
          || /^x-.+-token$/.test(name)
        )
      })
      expect(leakedHeader, 'sensitive request headers').toBe(false)
      const allowedHeaders = new Set(['host', 'user-agent', 'accept', 'content-type', 'content-length'])
      const headerOutsideAllowlist = payloads.some(payload =>
        Object.keys(payload.request?.headers || {}).some(name => !allowedHeaders.has(name.toLowerCase()))
      )
      expect(headerOutsideAllowlist, 'header outside the allowlist').toBe(false)
      expect(payloads.some(payload => payload.request && 'cookies' in payload.request), 'parsed cookies').toBe(false)
      expect(payloads.some(payload => payload.request && payload.request.data != null), 'request body field').toBe(false)
      expect(payloads.some(payload => payload.request && payload.request.query_string), 'query_string field').toBe(false)
      expect(
        payloads.some(payload => typeof payload.request?.headers?.host === 'string'),
        'non-sensitive host header kept',
      ).toBe(true)

      const hasStack = payloads.some(payload =>
        (payload.exception?.values || []).some(value => (value.stacktrace?.frames?.length ?? 0) > 0)
      )
      expect(hasStack, 'stack trace kept').toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it('redacts a kiosk token in the path and the transaction name', async () => {
    const secret = pathToken()
    await expectTokenPath({
      secret,
      pattern: '/api/kiosk/:token',
      request: () => request(server).get(`/api/kiosk/${secret}`),
      install() {
        const real = pool.query.bind(pool)
        return vi.spyOn(pool, 'query').mockImplementation(
          rejectMatching(real, 'kiosk_token', 'kiosk lookup failed'),
        )
      },
    })
  })

  it('redacts a swap token in the path and the transaction name', async () => {
    const secret = pathToken()
    await expectTokenPath({
      secret,
      pattern: '/api/swap/by-token/:token',
      request: () => request(server).get(`/api/swap/by-token/${secret}`),
      install() {
        return vi.spyOn(pool, 'connect').mockResolvedValue({
          query(sql) {
            if (typeof sql === 'string' && sql.includes('swap_token')) {
              return Promise.reject(new Error('swap lookup failed'))
            }
            return Promise.resolve({ rows: [] })
          },
          release() {},
        })
      },
    })
  })

  it('redacts a calendar feed token in the path and the transaction name', async () => {
    const secret = pathToken()
    await expectTokenPath({
      secret,
      pattern: '/api/calendar-sync/:token.ics',
      request: () => request(server).get(`/api/calendar-sync/${secret}.ics`),
      install() {
        const real = pool.query.bind(pool)
        return vi.spyOn(pool, 'query').mockImplementation(
          rejectMatching(real, 'calendar_token', 'calendar lookup failed'),
        )
      },
    })
  })

  it('redacts an unsubscribe token in the path and the transaction name', async () => {
    const secret = signUnsubscribe(1, 'serving_reminder')
    await expectTokenPath({
      secret,
      pattern: '/api/unsubscribe/:token',
      request: () => request(server).post(`/api/unsubscribe/${secret}`),
      install() {
        const real = pool.query.bind(pool)
        return vi.spyOn(pool, 'query').mockImplementation(
          rejectMatching(real, 'ochr_notification_prefs', 'prefs write failed'),
        )
      },
    })
  })
})

async function expectTokenPath({ secret, pattern, request: send, install }) {
  envelopes.length = 0
  const refererToken = pathToken()
  const spy = install()
  try {
    const res = await send().set('Referer', `http://127.0.0.1/reset?token=${refererToken}`)
    expect(res.status).toBe(500)
    await sentry.flush(2000)
    const serialized = JSON.stringify(envelopes)
    expect(envelopes.length, 'captured sentry events').toBeGreaterThan(0)
    expect(serialized.includes(secret), 'path token').toBe(false)
    expect(serialized.includes(refererToken), 'referer token').toBe(false)
    expect(serialized.includes(pattern), pattern).toBe(true)
  } finally {
    spy.mockRestore()
  }
}
