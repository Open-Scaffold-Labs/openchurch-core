// Free-text fields on a Sentry event are prose. Path-id templating
// (/123 and /<uuid> -> /:id) stays on URL and route fields only: in a
// message it rewrote 2026/10/25 into 2026/:id/:id (#397). These tests
// call beforeSend / beforeBreadcrumb, the hooks that actually ship.

import { describe, it, expect } from 'vitest'
import { buildSentryInitOptions } from '../src/monitoring/sentryPrivacy.js'

const UUID = '3f2b8c1e-9a4d-4e2f-8b1a-0c9d8e7f6a5b'
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'

function hooks() {
  return buildSentryInitOptions('https://public@127.0.0.1/1')
}

function send(event) {
  return hooks().beforeSend(event)
}

const PROSE = [
  'Contact ada@parish.test',
  'phone 555-123-4567',
  'intl +44 20 7946 0958',
  'card 4111111111111111', // osl-allow-test-pan
  'grouped 4111 1111 1111 1111', // osl-allow-test-pan
  `uuid ${UUID}`,
  `auth Bearer ${JWT}`,
  'key sk_live_51AbcDEF1234567',
  'assigned api_key=supersecretvalue1',
  'opaque kiosk-secret-ARG236',
  'status 500',
  'code 23505',
  'pg 22P02',
  'on 2026/10/25',
  'iso 2026-10-25T14:03:00.123456Z',
  'us 10/25/2026',
  'see http://parish.test/reset?token=sekret&email=ada@parish.test',
  'kiosk /api/kiosk/kiosk-secret-ARG236',
  'short /api/clients/42',
].join(' | ')

const PROSE_REDACTED = [
  'Contact [email]',
  'phone [phone]',
  'intl [phone]',
  'card [number]', // osl-allow-test-pan
  'grouped [number]', // osl-allow-test-pan
  'uuid [uuid]',
  'auth [token]',
  'key [token]',
  'assigned [token]',
  'opaque [token]',
  'status 500',
  'code 23505',
  'pg 22P02',
  'on 2026/10/25',
  'iso 2026-10-25T14:03:00.123456Z',
  'us 10/25/2026',
  'see http://parish.test/reset',
  'kiosk /api/kiosk/:token',
  'short /api/clients/42',
].join(' | ')

describe('Sentry free-text redaction', () => {
  it('redacts exception prose and keeps type, short codes, and frame line/col', () => {
    const out = send({
      exception: {
        values: [{
          type: 'QueryFailedError',
          value: PROSE,
          stacktrace: {
            frames: [{
              function: 'handler',
              filename: 'routes/gifts.js',
              lineno: 102456,
              colno: 8,
              vars: {
                detail: 'ada@parish.test on 2026/10/25',
                status: 500,
                account: '123456789012',
                token: 'kiosk-secret-ARG236',
                person: 'Ada Parish',
                home: '12 Chapel Lane',
                note: 'baptism of Ada Parish',
              },
            }],
          },
        }],
      },
    })
    const entry = out.exception.values[0]
    expect(entry.type).toBe('QueryFailedError')
    expect(entry.value).toBe(PROSE_REDACTED)
    const frame = entry.stacktrace.frames[0]
    expect(frame.function).toBe('handler')
    expect(frame.filename).toBe('routes/gifts.js')
    expect(frame.lineno).toBe(102456)
    expect(frame.colno).toBe(8)
    // Locals are not scrubbed. A name or address matches no pattern, so the bag is dropped.
    expect(frame.vars).toBeUndefined()
    const json = JSON.stringify(out)
    for (const local of ['Ada Parish', '12 Chapel Lane', 'Chapel', 'baptism', '123456789012']) {
      expect(json, local).not.toContain(local)
    }
  })

  it('redacts event.message and a parameterized message object', () => {
    const asString = send({ message: PROSE })
    expect(asString.message).toBe(PROSE_REDACTED)

    const asObject = send({
      message: {
        message: 'sent %s on 2026/10/25',
        formatted: 'sent ada@parish.test on 2026/10/25',
        params: ['ada@parish.test', '500', '23505', '2026/10/25', 500, '1234567'],
      },
    })
    expect(asObject.message).toEqual({
      message: 'sent %s on 2026/10/25',
      formatted: 'sent [email] on 2026/10/25',
      params: ['[email]', '500', '23505', '2026/10/25', 500, '[number]'], // osl-allow-test-pan
    })
  })

  it('redacts logentry message, formatted text, and params', () => {
    const out = send({
      logentry: {
        message: 'sent %s on 2026/10/25',
        formatted: 'sent ada@parish.test on 2026/10/25',
        params: ['ada@parish.test', '404', '22P02', '10/25/2026', 404, '4111111111111111'], // osl-allow-test-pan
      },
    })
    expect(out.logentry).toEqual({
      message: 'sent %s on 2026/10/25',
      formatted: 'sent [email] on 2026/10/25',
      params: ['[email]', '404', '22P02', '10/25/2026', 404, '[number]'], // osl-allow-test-pan
    })
  })

  it('redacts breadcrumb messages and still collapses console crumbs', () => {
    const opts = hooks()
    const crumb = opts.beforeBreadcrumb({
      category: 'app',
      message: 'ada@parish.test on 2026/10/25 status 502',
    })
    expect(crumb.message).toBe('[email] on 2026/10/25 status 502')

    const viaEvent = send({
      breadcrumbs: [{ category: 'app', message: 'call 555-123-4567 about 2026-10-25' }],
    })
    expect(viaEvent.breadcrumbs[0].message).toBe('call [phone] about 2026-10-25')

    const consoleCrumb = opts.beforeBreadcrumb({
      category: 'console',
      level: 'error',
      message: 'ada@parish.test',
      data: { arguments: ['ada@parish.test'] },
    })
    expect(consoleCrumb).toEqual({ category: 'console', level: 'error', message: '[console]' })
  })

  it('keeps slash dates in prose and still templates ids on URL and route fields', () => {
    const out = send({
      message: 'mass on 2026/10/25 and 2026-10-25 for client 42',
      transaction: 'GET /api/clients/987654',
      request: { url: `http://parish.test/api/clients/42/notes/${UUID}?x=1` },
      breadcrumbs: [{
        category: 'http',
        message: 'mass on 2026/10/25',
        data: { url: `/api/members/${UUID}`, method: 'GET', status_code: 404 },
      }],
    })
    expect(out.message).toBe('mass on 2026/10/25 and 2026-10-25 for client 42')
    expect(out.transaction).toBe('GET /api/clients/:id')
    expect(out.request.url).toBe('http://parish.test/api/clients/:id/notes/:id')
    expect(out.breadcrumbs[0].message).toBe('mass on 2026/10/25')
    expect(out.breadcrumbs[0].data).toEqual({
      url: '/api/members/:id',
      method: 'GET',
      status_code: 404,
    })
    expect(JSON.stringify(out)).not.toContain(UUID)
    expect(JSON.stringify(out)).not.toContain('987654')
  })

  it('drops a free-text field when the scrubber throws and does not return it raw', () => {
    const original = String.prototype.replace
    String.prototype.replace = function failClosed() {
      throw new Error('scrubber exploded')
    }
    let out
    try {
      out = send({
        message: 'ada@parish.test',
        logentry: { message: 'ada@parish.test', params: ['ada@parish.test'] },
        exception: {
          values: [{
            type: 'PgError',
            value: 'ada@parish.test',
            stacktrace: { frames: [{ filename: 'a.js', lineno: 10, colno: 2, vars: { detail: 'ada@parish.test' } }] },
          }],
        },
        breadcrumbs: [{ category: 'app', message: 'ada@parish.test' }],
      })
    } finally {
      String.prototype.replace = original
    }
    expect(out).not.toBeNull()
    expect(out.message).toBeUndefined()
    expect(out.logentry).toBeUndefined()
    expect(out.exception.values[0].type).toBe('PgError')
    expect(out.exception.values[0].value).toBeUndefined()
    expect(out.exception.values[0].stacktrace.frames[0].lineno).toBe(10)
    expect(out.exception.values[0].stacktrace.frames[0].colno).toBe(2)
    expect(out.exception.values[0].stacktrace.frames[0].vars).toBeUndefined()
    expect(out.breadcrumbs[0].message).toBeUndefined()
    expect(JSON.stringify(out)).not.toContain('ada@parish.test')
  })
})

describe('userId and orgId are scrubbed before send', () => {
  it('strips them from the message, tags, extra, breadcrumbs, spans, and trace, and keeps debug context', () => {
    const out = send({
      message: 'save failed userId=17 orgId=9 organization_id: 44 status 500',
      tags: { scope: 'gifts.create', userId: '17', orgId: '9', status: '500' },
      extra: { userId: 17, orgId: 9, organizationId: 44, status: 500, code: '23505', route: '/api/gifts', count: 2 },
      breadcrumbs: [{
        category: 'app',
        message: 'retry user_id=17 org-id=9',
        data: { userId: 17, orgId: 9, step: 2, status_code: 409 },
      }],
      spans: [{
        description: 'POST /api/gifts',
        data: { userId: 17, orgId: 9, 'http.status_code': 500 },
        attributes: { organizationId: 44, method: 'POST' },
      }],
      contexts: {
        trace: {
          trace_id: 'abc123trace',
          span_id: 'def456span',
          op: 'http.server',
          userId: 17,
          orgId: 9,
          data: { userId: 17, orgId: 9, status: 'ok' },
        },
      },
    })
    const json = JSON.stringify(out)
    expect(json).not.toMatch(/user[_-]?id/i)
    expect(json).not.toMatch(/org(?:anization)?[_-]?id/i)
    expect(json).not.toContain('17')
    expect(json).not.toContain('44')
    expect(out.message).toContain('status 500')
    expect(out.tags).toEqual({ scope: 'gifts.create', status: '500' })
    expect(out.extra).toEqual({ status: 500, code: '23505', route: '/api/gifts', count: 2 })
    expect(out.breadcrumbs[0].data).toEqual({ step: 2, status_code: 409 })
    expect(out.breadcrumbs[0].message).toContain('retry')
    expect(out.spans[0].description).toBe('POST /api/gifts')
    expect(out.spans[0].data).toEqual({ 'http.status_code': 500 })
    expect(out.spans[0].attributes).toEqual({ method: 'POST' })
    expect(out.contexts.trace.trace_id).toBe('abc123trace')
    expect(out.contexts.trace.span_id).toBe('def456span')
    expect(out.contexts.trace.op).toBe('http.server')
    expect(out.contexts.trace.data.status).toBe('ok')
  })

  it('beforeBreadcrumb scrubs the same labeled ids and keeps the step', () => {
    const crumb = hooks().beforeBreadcrumb({
      category: 'app',
      message: 'userId=17 orgId=9',
      data: { orgId: 9, step: 3 },
    })
    const json = JSON.stringify(crumb)
    expect(json).not.toMatch(/userId|orgId/)
    expect(json).not.toContain('17')
    expect(json).not.toContain('9')
    expect(crumb.data).toEqual({ step: 3 })
  })
})
