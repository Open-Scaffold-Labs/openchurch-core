// Sentry events must not link an error to a person or a parish.
// monitor.error forwards its context as `extra`; most call sites pass
// orgId / organizationId / userId. Those, and the same identifiers in
// user, tags, contexts and breadcrumb data, are dropped before send.

import { describe, it, expect } from 'vitest'
import { scrubSentryEvent, scrubSentryBreadcrumb } from '../src/monitoring/sentryPrivacy.js'

const ID = 'ident-SENTINEL-1'

function eventWithIds() {
  return {
    message: 'boom',
    user: { id: ID, email: `${ID}@parish.test`, username: ID },
    tags: { scope: 'gifts.create', orgId: ID },
    extra: {
      userId: ID, orgId: ID, organizationId: ID, organization_id: ID,
      parishId: ID, memberId: ID, id: ID, orgSlug: ID, formSlug: ID,
      email: ID, recipient: ID, paymentRef: ID, recurringGiftIds: [ID],
      nested: { targetId: ID, count: 3 },
      status: 500, code: 'E_TEST', notification_type: 'email', count: 2,
    },
    contexts: { runtime: { name: 'node' }, parish: { orgId: ID } },
    breadcrumbs: [{ category: 'app', message: 'step', data: { userId: ID, step: 2 } }],
  }
}

describe('Sentry identifier privacy', () => {
  it('drops person and parish identifiers but keeps non-identifying debug fields', () => {
    const out = scrubSentryEvent(eventWithIds())
    expect(JSON.stringify(out)).not.toContain(ID)
    expect(out.tags.scope).toBe('gifts.create')
    expect(out.extra).toMatchObject({ status: 500, code: 'E_TEST', notification_type: 'email', count: 2 })
    expect(out.extra.nested).toBeUndefined()
    expect(out.contexts.runtime).toEqual({ name: 'node' })
    expect(out.breadcrumbs[0].data).toEqual({ step: 2 })
  })

  it('beforeBreadcrumb path drops identifiers too', () => {
    const b = scrubSentryBreadcrumb({ category: 'app', data: { orgId: ID, ok: true } })
    expect(b.data).toEqual({ ok: true })
  })
})

describe('R397-1 identifier key naming conventions', () => {
  const keys = ['userid', 'orgid', 'USERID', 'ORG_ID', 'user_id', 'user-id', 'UserId',
    'paymentref', 'payment_ref', 'PAYMENT_REF', 'payment-ref', 'user_name', 'userName',
    'USER_NAME', 'organizationid', 'parishid', 'memberid', 'EMAIL_ADDRESS', 'orgslug']
  for (const key of keys) {
    it(`drops ${key}`, () => {
      const out = scrubSentryEvent({ extra: { [key]: ID, status: 500 } })
      expect(out.extra).toEqual({ status: 500 })
    })
  }
  it('keeps non-identifying words that end in id/ref (tags use the denylist)', () => {
    const extra = { paid: true, valid: false, void: 1, android: 'x', prefer: 'a', status: 1 }
    expect(scrubSentryEvent({ tags: { ...extra } }).tags).toEqual(extra)
  })
})

describe('R397-2 depth limit fails closed', () => {
  function deepObject(levels, leaf) {
    let v = leaf
    for (let i = 0; i < levels; i++) v = { level: v }
    return v
  }
  function deepArray(levels, leaf) {
    let v = leaf
    for (let i = 0; i < levels; i++) v = [v]
    return v
  }
  const leaves = [{ orgId: ID }, { email: ID }, `see http://x.test/a?token=${ID}`]
  for (const leaf of leaves) {
    it(`nested object hides ${JSON.stringify(leaf).slice(0, 20)}`, () => {
      const out = scrubSentryEvent({ extra: { deep: deepObject(20, leaf) }, tags: { t: deepObject(20, leaf) },
        contexts: { c: deepObject(20, leaf) }, breadcrumbs: [{ data: { d: deepObject(20, leaf) } }] })
      expect(JSON.stringify(out)).not.toContain(ID)
    })
    it(`nested array hides ${JSON.stringify(leaf).slice(0, 20)}`, () => {
      const out = scrubSentryEvent({ extra: { deep: deepArray(20, leaf) },
        breadcrumbs: [{ data: { d: deepArray(20, leaf) } }] })
      expect(JSON.stringify(out)).not.toContain(ID)
    })
  }
})

describe('Argus R397-2/3/5 and extra allowlist', () => {
  it('drops eid, storage key, session and unknown extra keys (allowlist fails closed)', () => {
    const out = scrubSentryEvent({ extra: {
      eid: ID, key: `org-1/${ID}.json`, objectKey: ID, session: ID, name: ID, title: ID, q: ID, futureField: ID,
      scope: 'x', status: 500, statusCode: 502, code: 'E1', notification_type: 'email', qLength: 4, route: '/api/x/:id',
    } })
    expect(JSON.stringify(out)).not.toContain(ID)
    expect(out.extra).toEqual({ scope: 'x', status: 500, statusCode: 502, code: 'E1', notification_type: 'email', qLength: 4, route: '/api/x/:id' })
  })
  it('drops eid/key/session from tags and breadcrumb data too', () => {
    const out = scrubSentryEvent({ tags: { scope: 's', eid: ID, session: ID }, breadcrumbs: [{ category: 'app', data: { key: ID, ok: 1 } }] })
    expect(out.tags).toEqual({ scope: 's' })
    expect(out.breadcrumbs[0].data).toEqual({ ok: 1 })
  })
  it('templates numeric and UUID record ids in urls, transaction and breadcrumbs', () => {
    const uuid = '3f2b8c1e-9a4d-4e2f-8b1a-0c9d8e7f6a5b'
    const out = scrubSentryEvent({
      transaction: 'GET /api/clients/987654',
      request: { url: `http://parish.test/api/clients/987654/notes/${uuid}?x=1` },
      breadcrumbs: [{ category: 'http', data: { url: `/api/members/${uuid}`, method: 'GET', status_code: 500 } }],
    })
    const json = JSON.stringify(out)
    expect(json).not.toContain('987654')
    expect(json).not.toContain(uuid)
    expect(out.transaction).toBe('GET /api/clients/:id')
    expect(out.request.url).toBe('http://parish.test/api/clients/:id/notes/:id')
    expect(out.breadcrumbs[0].data).toEqual({ url: '/api/members/:id', method: 'GET', status_code: 500 })
  })
  it('console breadcrumbs keep level only, no message or arguments', () => {
    const crumb = { category: 'console', level: 'error', message: `row ${ID}@parish.test`, data: { arguments: [`${ID}@parish.test`, { orgId: ID }], logger: 'console' } }
    const viaHook = scrubSentryBreadcrumb(structuredClone(crumb))
    const viaEvent = scrubSentryEvent({ breadcrumbs: [structuredClone(crumb)] }).breadcrumbs[0]
    for (const b of [viaHook, viaEvent]) {
      expect(JSON.stringify(b)).not.toContain(ID)
      expect(b).toEqual({ category: 'console', level: 'error', message: '[console]' })
    }
  })
})
