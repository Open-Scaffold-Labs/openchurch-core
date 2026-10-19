// Checkout audit is metadata-only (TARS 6206064745): checkoutAuditMetadata
// returns {} whatever the body holds, so there is no note-masking heuristic
// to get wrong. Check-in rows keep ids/kind only (CK-1). Synthetic values.
// Persisted-row proof: stage7PickupAudit.test.js.

import { describe, it, expect } from 'vitest'
import { _auditInternalsForTests } from '../src/middleware/auditLog.js'

const PICKUP = 'SYNTH-PICKUP-Q7KM'

describe('checkout audit metadata is empty', () => {
  it('drops code, note, every pickup spelling and nested objects', () => {
    const { checkoutAuditMetadata } = _auditInternalsForTests
    expect(checkoutAuditMetadata({ code: PICKUP, note: 'door ' + PICKUP, pickup_code: 'A', pin: 'B', nested: { code: 'C' } })).toEqual({})
    expect(checkoutAuditMetadata({ note: { code: PICKUP } })).toEqual({})
    expect(checkoutAuditMetadata(undefined)).toEqual({})
  })
})

describe('check-in audit metadata keeps ids/kind only (CK-1)', () => {
  it('drops names, codes, notes and nested data; bounds strings', () => {
    const { checkinAuditMetadata } = _auditInternalsForTests
    expect(checkinAuditMetadata({
      calendar_event_id: 7, kind: 'child', room_id: '12', client_id: 'x'.repeat(41),
      person_name: 'Synthetic Child', guardian_name: 'Synthetic Guardian', security_code: 'S', note: 'n', extra: { pin: 'p' },
    })).toEqual({ calendar_event_id: 7, kind: 'child', room_id: '12' })
  })
})

describe('sanitizeBody (all other routes)', () => {
  const { sanitizeBody } = _auditInternalsForTests
  it('drops code/PIN spellings on every route but keeps neighbours', () => {
    const out = sanitizeBody({ security_code: 'A', securityCode: 'B', pickup_code: 'C', pickupCode: 'D', pin: 'E', PIN: 'F', pinned: true, postcode: '0000', name: 'x' })
    expect(out).toEqual({ pinned: true, postcode: '0000', name: 'x' })
  })
  it('R280-4/5: nested and variant code/PIN keys drop on ordinary rows', () => {
    const out = sanitizeBody({
      name: 'x', securityCode: 'A', pin_code: 'B', pincode: 'C', PIN1: 'D', 'pickup-code': 'E', PickupCode: 'F',
      pinned: true, mapping: 'm', opinion: 'o',
      child: { pin: 'N1', code: 'N2', nested: [{ security_code: 'N3', ok: 1 }], deep: { a: { b: { c: { d: 'TOO-DEEP' } } } } },
    })
    expect(out).toEqual({ name: 'x', pinned: true, mapping: 'm', opinion: 'o', child: { nested: [{ ok: 1 }], deep: { a: {} } } })
    expect(JSON.stringify(out)).not.toMatch(/N1|N2|N3|TOO-DEEP/)
  })
})

describe('R4-4: summary routing never reads a check-in body', () => {
  const { summaryFor } = _auditInternalsForTests
  it('checkin: body name/title ignored; other entities still use the handle', () => {
    const body = { name: 'SYNTH-HANDLE-NAME', title: 'SYNTH-HANDLE-TITLE' }
    expect(summaryFor('checkin', 'create', body, body, '9', null)).toBe('Created checkin')
    expect(summaryFor('checkin', 'update', null, body, '9', null)).toBe('Updated checkin #9')
    expect(summaryFor('checkin', 'create', null, body, '9', { verb: 'Released' })).toBe('Released checkin #9')
    expect(summaryFor('event', 'create', null, body, '9', null)).toBe('Created event: SYNTH-HANDLE-NAME')
  })
})
