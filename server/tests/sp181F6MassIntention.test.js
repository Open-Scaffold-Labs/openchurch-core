// Saint SP-181 (2026-10-25) + #285 F6 (José, 2026-10-25). Real PG.
//
// SP-181: "Past scheduled — fulfilment not recorded" now includes TODAY's
// rows once their linked Mass (same day) has begun on the parish clock.
// Today's rows with no linked Mass, or a Mass that has not begun, still
// never match. The clock is faked (Date only).
//
// F6: once fulfilled (or stamped), the offering amount and the Mass link
// are locked for every path, the admin correction included. 409
// fulfilled_offering_locked, nothing written. Other reasoned corrections
// and N449-3 refuses void while fulfilled+held 2330 (zero-liability void still works).
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import request from 'supertest'
import 'dotenv/config'
import pool from '../src/db.js'
const FULFILLED_OFFERING_LOCKED_CODE = 'fulfilled_offering_locked'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'

let server, A
let ip = 10
const nextIp = () => `10.252.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}`
const auth = t => ({ Authorization: `Bearer ${t}` })
const at = when => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(when) }
// 2026-10-25 12:30 in Los Angeles (19:30Z).
const SUNDAY_1230_LA = new Date('2026-10-25T19:30:00Z')

async function mass(o, date, start, title = 'Sunday Mass') {
  const { rows } = await pool.query(
    `INSERT INTO ochr_calendar_events (organization_id, title, date, start_time, end_time, type)
     VALUES ($1,$2,$3,$4,'23:00','service') RETURNING id`, [o.id, `${title} ${RUN_ID}`, date, start])
  return rows[0].id
}
async function intention(o, tag, { status = 'scheduled', date = null, eventId = null, stipend = null } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO ochr_mass_intentions (organization_id, intention, requested_by, status, mass_date, calendar_event_id, stipend)
     VALUES ($1,$2,'Synthetic Requester',$3,$4,$5,$6) RETURNING id`,
    [o.id, `SP181 ${tag} ${RUN_ID}`, status, date, eventId, stipend])
  return rows[0].id
}
const tags = r => r.body.intentions.map(x => x.intention.replace('SP181 ', '').replace(` ${RUN_ID}`, '')).sort()

beforeAll(async () => {
  await migrateOnce(); server = await bindServer()
  const r = await createOrg(server, { organizationName: `SP181 ${RUN_ID}`, name: 'Admin SP181', email: `sp181_${RUN_ID}@example.com`, password: 'sp181-test-pw-0001' }, nextIp())
  expect(r.status).toBe(201)
  A = { token: r.body.token, id: r.body.user.organization.id }
  await pool.query(`UPDATE ochr_organizations SET timezone='America/Los_Angeles' WHERE id=$1`, [A.id])
  const m10 = await mass(A, '2026-10-25', '10:00')
  const m17 = await mass(A, '2026-10-25', '17:00', 'Evening Mass')
  await intention(A, 'today-10am', { date: '2026-10-25', eventId: m10 })
  await intention(A, 'today-5pm', { date: '2026-10-25', eventId: m17 })
  await intention(A, 'today-nolink', { date: '2026-10-25' })
  await intention(A, 'oct24', { date: '2026-10-24' })
}, 120_000)
afterEach(() => { vi.useRealTimers() })
afterAll(async () => { await closeServer(server); await pool.end() })

describe('SP-181 past scheduled includes today\'s begun Masses', () => {
  it('12:30 Sunday LA: yesterday + this morning\'s 10:00 Mass; not 17:00, not unlinked', async () => {
    at(SUNDAY_1230_LA)
    const r = await request(server).get('/api/mass-intentions?view=past_scheduled&limit=50&offset=0').set(auth(A.token))
    expect(r.status).toBe(200)
    expect(tags(r)).toEqual(['oct24', 'today-10am'])
    expect(r.body.intentions.every(x => x.past_scheduled === true)).toBe(true)
  })
  it('09:59 Sunday LA: this morning\'s 10:00 Mass has not begun', async () => {
    at(new Date('2026-10-25T16:59:00Z'))
    const r = await request(server).get('/api/mass-intentions?view=past_scheduled&limit=50&offset=0').set(auth(A.token))
    expect(tags(r)).toEqual(['oct24'])
  })
})

describe('#285 F6 — fulfilled offering and Mass link are locked', () => {
  let id, otherMass
  beforeAll(async () => {
    const m = await mass(A, '2026-10-18', '09:00', 'Past Mass')
    otherMass = await mass(A, '2026-10-18', '11:00', 'Other Mass')
    id = await intention(A, 'f6', { date: '2026-10-18', eventId: m, stipend: '10.00' })
    const f = await request(server).patch(`/api/mass-intentions/${id}`).set(auth(A.token)).send({ status: 'fulfilled' })
    expect(f.status).toBe(200)
  })
  const stored = async () => (await pool.query('SELECT stipend::text, calendar_event_id, status FROM ochr_mass_intentions WHERE id=$1', [id])).rows[0]

  it('ordinary PATCH of the offering is refused with the F6 code', async () => {
    const r = await request(server).patch(`/api/mass-intentions/${id}`).set(auth(A.token)).send({ stipend: 25 })
    expect(r.status).toBe(409)
    expect(r.body.code).toBe(FULFILLED_OFFERING_LOCKED_CODE)
    expect(r.body.error).toMatch(/cannot be voided yet|remittance accounting/i)
    expect((await stored()).stipend).toBe('10.00')
  })
  it('admin reasoned correction cannot change the offering', async () => {
    const r = await request(server).post(`/api/mass-intentions/${id}/correct`).set(auth(A.token))
      .send({ reason: 'Typo in amount', changes: { stipend: 20 } })
    expect(r.status).toBe(409)
    expect(r.body.code).toBe(FULFILLED_OFFERING_LOCKED_CODE)
    expect((await stored()).stipend).toBe('10.00')
  })
  it('admin correction that reopens and changes the offering in one go is refused', async () => {
    const r = await request(server).post(`/api/mass-intentions/${id}/correct`).set(auth(A.token))
      .send({ reason: 'Reopen and fix', changes: { status: 'scheduled', stipend: 20 } })
    expect(r.status).toBe(409)
    const s = await stored()
    expect(s.stipend).toBe('10.00'); expect(s.status).toBe('fulfilled')
  })
  it('the Mass link cannot be moved by correction either', async () => {
    const r = await request(server).post(`/api/mass-intentions/${id}/correct`).set(auth(A.token))
      .send({ reason: 'Wrong Mass', changes: { calendar_event_id: otherMass } })
    expect(r.status).toBe(409)
    expect((await stored()).calendar_event_id).not.toBe(otherMass)
  })
  it('a reasoned note correction still works, and after reopening the stamp keeps the offering locked', async () => {
    const n = await request(server).post(`/api/mass-intentions/${id}/correct`).set(auth(A.token))
      .send({ reason: 'Note', changes: { note: 'Corrected note' } })
    expect(n.status).toBe(200)
    const reopen = await request(server).post(`/api/mass-intentions/${id}/correct`).set(auth(A.token))
      .send({ reason: 'Reopen', changes: { status: 'scheduled' } })
    expect(reopen.status).toBe(200)
    const r = await request(server).post(`/api/mass-intentions/${id}/correct`).set(auth(A.token))
      .send({ reason: 'Now fix amount', changes: { stipend: 20 } })
    expect(r.status).toBe(409)
    expect(r.body.code).toBe(FULFILLED_OFFERING_LOCKED_CODE)
    expect((await stored()).stipend).toBe('10.00')
  })
  it('the reasoned void path stays open', async () => {
    const v = await request(server).post(`/api/mass-intentions/${id}/void`).set(auth(A.token)).send({ reason: 'Wrong amount; re-recorded', disposition: { kind: 'refunded', reason: 'Returned to requester' } })
    expect(v.status).toBe(200)
  })
})

// R405-1: the F6 lock is checked before the older guards, so every valid
// offering or Mass-link change on a fulfilled or stamped row gets the F6
// code (not offering_clear_refused / stamped_history) and leaves no trace.
describe('R405-1 — F6 code precedes offering-clear and stamped-history guards', () => {
  let id, otherMass
  beforeAll(async () => {
    const m = await mass(A, '2026-10-11', '09:00', 'R405 Mass')
    otherMass = await mass(A, '2026-10-11', '11:00', 'R405 Other')
    id = await intention(A, 'r405', { date: '2026-10-11', eventId: m, stipend: '15.00' })
    const f = await request(server).patch(`/api/mass-intentions/${id}`).set(auth(A.token)).send({ status: 'fulfilled' })
    expect(f.status).toBe(200)
  })
  const snap = async () => {
    const row = (await pool.query(
      `SELECT stipend::text, calendar_event_id, status, note, fulfilled_mass_date::text, fulfilled_mass_title, entered_history
         FROM ochr_mass_intentions WHERE id=$1`, [id])).rows[0]
    const corr = Number((await pool.query('SELECT count(*) FROM ochr_mass_intention_corrections WHERE mass_intention_id=$1', [id])).rows[0].count)
    const audit = Number((await pool.query(
      `SELECT count(*) FROM ochr_audit_log WHERE organization_id=$1 AND entity_type='mass_intention' AND entity_id=$2`, [A.id, String(id)])).rows[0].count)
    return { row, corr, audit }
  }
  const expectF6 = async (r, before) => {
    expect(r.status).toBe(409)
    expect(r.body.code).toBe(FULFILLED_OFFERING_LOCKED_CODE)
    expect(await snap()).toEqual(before)
  }

  it('fulfilled: ordinary PATCH clearing the offering gets the F6 code', async () => {
    const before = await snap()
    await expectF6(await request(server).patch(`/api/mass-intentions/${id}`).set(auth(A.token)).send({ stipend: null }), before)
  })
  it('fulfilled: admin correction clearing the offering gets the F6 code', async () => {
    const before = await snap()
    await expectF6(await request(server).post(`/api/mass-intentions/${id}/correct`).set(auth(A.token))
      .send({ reason: 'Clear amount', changes: { stipend: null } }), before)
  })
  it('fulfilled: ordinary PATCH moving the Mass gets the F6 code', async () => {
    const before = await snap()
    await expectF6(await request(server).patch(`/api/mass-intentions/${id}`).set(auth(A.token)).send({ calendar_event_id: otherMass }), before)
  })
  it('invalid offering payload is still a 400, not the F6 code', async () => {
    const r = await request(server).patch(`/api/mass-intentions/${id}`).set(auth(A.token)).send({ stipend: 'abc' })
    expect(r.status).toBe(400)
  })
  it('stamped and reopened: PATCH and correction relinking or unlinking the Mass, or clearing the offering, get the F6 code', async () => {
    const reopen = await request(server).post(`/api/mass-intentions/${id}/correct`).set(auth(A.token))
      .send({ reason: 'Reopen', changes: { status: 'scheduled' } })
    expect(reopen.status).toBe(200)
    const before = await snap()
    expect(before.row.status).not.toBe('fulfilled')
    await expectF6(await request(server).patch(`/api/mass-intentions/${id}`).set(auth(A.token)).send({ calendar_event_id: otherMass }), before)
    await expectF6(await request(server).post(`/api/mass-intentions/${id}/correct`).set(auth(A.token))
      .send({ reason: 'Wrong Mass', changes: { calendar_event_id: otherMass } }), before)
    await expectF6(await request(server).post(`/api/mass-intentions/${id}/correct`).set(auth(A.token))
      .send({ reason: 'Unlink', changes: { calendar_event_id: null } }), before)
    await expectF6(await request(server).patch(`/api/mass-intentions/${id}`).set(auth(A.token)).send({ stipend: null }), before)
  })
  it('reasoned void is unchanged', async () => {
    const v = await request(server).post(`/api/mass-intentions/${id}/void`).set(auth(A.token)).send({ reason: 'Re-record', disposition: { kind: 'refunded', reason: 'Returned to requester' } })
    expect(v.status).toBe(200)
  })
})
