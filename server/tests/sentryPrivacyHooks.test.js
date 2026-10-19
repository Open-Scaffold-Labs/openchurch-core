// ARG-236-3..7. The init options themselves, with no transport and no tracing.
// Caller options are passed in and must not win: a passthrough beforeSend
// would keep the secrets below.

import { describe, it, expect } from 'vitest'
import { buildSentryInitOptions } from '../src/monitoring/sentryPrivacy.js'

const INVITE = 'invite-secret-ARG236'
const KIOSK = 'kiosk-secret-ARG236'
const SWAP = 'swap-secret-ARG236'
const CAL = 'cal-secret-ARG236'
const UNSUB = 'unsub.secret-ARG236'
const QUERY = 'Maria-ARG236'
const COOKIE = 'cookie-secret-ARG236'
const API_KEY = 'api-key-secret-ARG236'
const CITY = 'vercel-city-ARG236'
const IP = '203.0.113.50'

function passthrough(event) {
  return event
}

function leakyEvent() {
  return {
    transaction: `GET /api/kiosk/${KIOSK}/members`,
    message: `question? kept http://parish.test/reset?token=${INVITE}`,
    user: { id: 'staff', ip_address: IP },
    request: {
      url: `http://127.0.0.1/api/kiosk/${KIOSK}?q=${QUERY}`,
      query_string: `q=${QUERY}`,
      cookies: { ochr_session: COOKIE },
      data: { note: 'body-secret-ARG236' },
      headers: {
        host: '127.0.0.1',
        'content-type': 'application/json',
        cookie: `ochr_session=${COOKIE}`,
        referer: `http://127.0.0.1/accept-invite?token=${INVITE}`,
        'proxy-authorization': 'proxy-secret-ARG236',
        cookie2: 'cookie2-secret-ARG236',
        'x-token': 'x-token-secret-ARG236',
        'x-api-key': API_KEY,
        'api-key': 'api-key-header-ARG236',
        'x-kiosk-code': 'kiosk-code-ARG236',
        'stripe-signature': 'stripe-sig-ARG236',
        'x-vercel-proxy-signature': 'vercel-proxy-ARG236',
        'x-vercel-ip-city': CITY,
        'x-forwarded-for': IP,
      },
    },
    exception: {
      values: [{
        type: 'Error',
        value: `boom http://parish.test/reset?token=${INVITE}&donor=${QUERY}`,
        stacktrace: { frames: [{ function: 'handler', vars: { token: KIOSK } }] },
      }],
    },
    breadcrumbs: [{
      category: 'console',
      message: `question? kept http://parish.test/reset?token=${INVITE}`,
      data: {
        arguments: [
          `question? kept`,
          `http://parish.test/accept-invite?token=${INVITE}`,
          { url: `/api/swap/by-token/${SWAP}` },
        ],
      },
    }],
    spans: [{
      description: `GET /api/swap/by-token/${SWAP}`,
      data: {
        'http.url': `http://127.0.0.1/api/calendar-sync/${CAL}.ics?x=1`,
        'http.target': `/api/unsubscribe/${UNSUB}`,
        'url.full': `/api/kiosk/${KIOSK}/members?q=${QUERY}`,
        'http.query': `q=${QUERY}`,
        'http.client_ip': IP,
        'net.peer.ip': IP,
        'http.request.header.cookie': `ochr_session=${COOKIE}`,
        'http.request.header.referer': `http://127.0.0.1/reset?token=${INVITE}`,
        'http.request.header.content_type': 'application/json',
      },
    }],
    contexts: {
      trace: {
        description: `GET /api/kiosk/${KIOSK}`,
        data: {
          'http.url': `http://127.0.0.1/api/kiosk/${KIOSK}`,
          'http.client_ip': IP,
        },
      },
    },
  }
}

describe('Sentry privacy hooks', () => {
  it('keeps sendDefaultPii off and lets the scrubbers beat caller options', () => {
    const opts = buildSentryInitOptions('https://public@127.0.0.1/1', {
      sendDefaultPii: true,
      beforeSend: passthrough,
      beforeSendTransaction: passthrough,
      beforeBreadcrumb: passthrough,
    })
    expect(opts.sendDefaultPii).toBe(false)
    expect(opts.tracesSampleRate).toBeUndefined()

    const event = opts.beforeSend(leakyEvent())
    const transaction = opts.beforeSendTransaction(leakyEvent())
    const crumb = opts.beforeBreadcrumb(leakyEvent().breadcrumbs[0])
    const serialized = JSON.stringify({ event, transaction, crumb })

    for (const secret of [INVITE, KIOSK, SWAP, CAL, UNSUB, QUERY, COOKIE, API_KEY, CITY, IP, 'body-secret-ARG236', 'proxy-secret-ARG236', 'stripe-sig-ARG236']) {
      expect(serialized.includes(secret), secret).toBe(false)
    }

    expect(event.request.url).toBe('http://127.0.0.1/api/kiosk/:token')
    expect(event.request.query_string).toBeUndefined()
    expect(event.request.cookies).toBeUndefined()
    expect(event.request.data).toBeUndefined()
    expect(event.request.headers.host).toBe('127.0.0.1')
    expect(event.request.headers['content-type']).toBe('application/json')
    expect(event.request.headers.referer).toBeUndefined()
    expect(event.user.ip_address).toBeUndefined()
    expect(event.user.id).toBe('staff')
    expect(event.transaction).toBe('GET /api/kiosk/:token/members')
    expect(event.message).toContain('question? kept')
    expect(event.message).toBe('question? kept http://parish.test/reset')
    expect(event.exception.values[0].value).toBe('boom http://parish.test/reset')
    expect(event.exception.values[0].stacktrace.frames[0].vars).toBeUndefined()
    expect(event.exception.values[0].stacktrace.frames[0].function).toBe('handler')

    expect(transaction.transaction).toBe('GET /api/kiosk/:token/members')
    expect(transaction.spans[0].description).toBe('GET /api/swap/by-token/:token')
    expect(transaction.spans[0].data['http.url']).toBe('http://127.0.0.1/api/calendar-sync/:token.ics')
    expect(transaction.spans[0].data['http.target']).toBe('/api/unsubscribe/:token')
    expect(transaction.spans[0].data['url.full']).toBe('/api/kiosk/:token/members')
    expect(transaction.spans[0].data['http.query']).toBeUndefined()
    expect(transaction.spans[0].data['http.client_ip']).toBeUndefined()
    expect(transaction.spans[0].data['http.request.header.cookie']).toBeUndefined()
    expect(transaction.spans[0].data['http.request.header.content_type']).toBe('application/json')
    expect(transaction.contexts.trace.data['http.url']).toBe('http://127.0.0.1/api/kiosk/:token')
    expect(transaction.contexts.trace.description).toBe('GET /api/kiosk/:token')

    expect(crumb.message).toContain('question? kept')
    expect(crumb.message).not.toContain(INVITE)
    expect(crumb.data.arguments[0]).toBe('question? kept')
    expect(crumb.data.arguments[1]).toBe('http://parish.test/accept-invite')
    expect(crumb.data.arguments[2].url).toBe('/api/swap/by-token/:token')
  })
})
