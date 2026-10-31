// Founder decision 8 (José, 2026-10-19) — fulfilled Mass-intention history
// is preserved.
//
// WHAT WOULD MAKE THESE FAIL
//   - DELETE removing a fulfilled / stamped / voided row (the old hard delete).
//   - An ordinary PATCH silently rewriting a fulfilled row's text, stipend,
//     requester or status.
//   - A correction or void without a reason, by staff, or without a
//     correction row (who / what / when / before / after).
//   - A correction or void reaching another parish's row.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'
import {
  FULFILLED_LOCKED_CODE, FULFILLED_HISTORY_CODE, VOIDED_CODE,
  VOID_FULFILLED_HELD_CODE, REASON_REQUIRED_CODE, ADMIN_ONLY_CODE,
} from '../src/routes/massIntentions.js'

let server
let tokenA, tokenB, staffA, orgAId, adminAId

const auth = token => ({ Authorization: `Bearer ${token}` })

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  const a = await createOrg(server, {
    organizationName: `MIH Parish A ${RUN_ID}`, name: 'Ana Admin',
    email: `mih_a_${RUN_ID}@example.com`, password: 'mih-test-pw-1',
  })
  expect(a.status).toBe(201)
  tokenA = a.body.token
  orgAId = a.body.user.organization.id
  adminAId = a.body.user.id
  const b = await createOrg(server, {
    organizationName: `MIH Parish B ${RUN_ID}`, name: 'Ben Admin',
    email: `mih_b_${RUN_ID}@example.com`, password: 'mih-test-pw-2',
  })
  expect(b.status).toBe(201)
  tokenB = b.body.token
  const staff = await request(server).post('/api/users').set(auth(tokenA))
    .send({ name: 'Sam Staff', email: `mih_s_${RUN_ID}@example.com`, password: 'mih-test-pw-3x', role: 'staff' })
  expect(staff.status).toBe(201)
  const login = await request(server).post('/api/auth/login')
    .send({ email: `mih_s_${RUN_ID}@example.com`, password: 'mih-test-pw-3x' })
  expect(login.status).toBe(200)
  staffA = login.body.token
}, 60_000)

afterAll(async () => {
  await closeServer(server)
  await pool.end()
})

let massSeq = 0
async function fulfilled(token = tokenA, extra = {}) {
  massSeq += 1
  const mass = await request(server).post('/api/calendar').set(auth(token)).send({
    title: `MIH Mass ${massSeq} ${RUN_ID}`, date: `2032-04-${String(massSeq).padStart(2, '0')}`,
    start_time: '09:00', end_time: '10:00', type: 'service',
  })
  expect(mass.status).toBe(201)
  const payload = { intention: `† Synthetic ${massSeq} ${RUN_ID}`, stipend: '10.00', ...extra }
  if (payload.stipend == null) delete payload.stipend
  const made = await request(server).post('/api/mass-intentions').set(auth(token))
    .send(payload)
  expect(made.status).toBe(201)
  const offered = await request(server).post(`/api/mass-intentions/${made.body.id}/assign`).set(auth(token))
    .send({ calendar_event_id: mass.body.id, expected_calendar_event_id: null })
  expect(offered.status).toBe(200)
  const mark = await request(server).patch(`/api/mass-intentions/${made.body.id}`).set(auth(token))
    .send({ status: 'fulfilled' })
  expect(mark.status).toBe(200)
  return made.body.id
}

const rowOf = async id => (await pool.query(
  `SELECT intention, stipend, status, voided_at, voided_by, void_reason, fulfilled_mass_title
     FROM ochr_mass_intentions WHERE id = $1`, [id])).rows[0]
const trailOf = async id => (await pool.query(
  `SELECT organization_id, actor_user_id, kind, reason, before, after, created_at
     FROM ochr_mass_intention_corrections WHERE mass_intention_id = $1 ORDER BY id`, [id])).rows

describe('Decision 8 — fulfilled Mass-intention history', () => {
  it('DELETE of a fulfilled intention is refused and the row stays (core guard)', async () => {
    const id = await fulfilled()
    const res = await request(server).delete(`/api/mass-intentions/${id}`).set(auth(tokenA))
    expect(res.status).toBe(409)
    expect(res.body.code).toBe(FULFILLED_HISTORY_CODE)
    expect(await rowOf(id)).toBeTruthy()
  })

  it('an ordinary PATCH that changes a fulfilled row is refused; nothing is written (core guard)', async () => {
    const id = await fulfilled()
    const before = await rowOf(id)
    for (const body of [{ intention: 'silently rewritten' }, { stipend: '99.00' }, { note: 'x' }, { status: 'open' }]) {
      const res = await request(server).patch(`/api/mass-intentions/${id}`).set(auth(tokenA)).send(body)
      expect(res.status, JSON.stringify(body)).toBe(409)
      // #285 F6 (2026-10-25): the offering has its own, stricter lock.
      expect(res.body.code).toBe('stipend' in body ? 'fulfilled_offering_locked' : FULFILLED_LOCKED_CODE)
    }
    expect(await rowOf(id)).toEqual(before)
    expect(await trailOf(id)).toEqual([])
  })

  it('a PATCH that changes nothing on a fulfilled row still succeeds', async () => {
    const id = await fulfilled()
    const res = await request(server).patch(`/api/mass-intentions/${id}`).set(auth(tokenA))
      .send({ status: 'fulfilled' })
    expect(res.status).toBe(200)
  })

  it('an unfulfilled, unstamped intention can still be edited and deleted', async () => {
    const made = await request(server).post('/api/mass-intentions').set(auth(tokenA))
      .send({ intention: `† Open ${RUN_ID}` })
    expect(made.status).toBe(201)
    const ed = await request(server).patch(`/api/mass-intentions/${made.body.id}`).set(auth(tokenA))
      .send({ intention: `† Open edited ${RUN_ID}` })
    expect(ed.status).toBe(200)
    const del = await request(server).delete(`/api/mass-intentions/${made.body.id}`).set(auth(tokenA))
    expect(del.status).toBe(204)
  })

  it('admin correction needs a reason and records who, what, when, before and after', async () => {
    const id = await fulfilled()
    const noReason = await request(server).post(`/api/mass-intentions/${id}/correct`).set(auth(tokenA))
      .send({ reason: '   ', changes: { stipend: '15.00' } })
    expect(noReason.status).toBe(400)
    expect(noReason.body.code).toBe(REASON_REQUIRED_CODE)

    // #285 F6 (José, 2026-10-25): the offering of a fulfilled row is locked
    // even for the admin correction; the reasoned void is that path.
    const locked = await request(server).post(`/api/mass-intentions/${id}/correct`).set(auth(tokenA))
      .send({ reason: 'Stipend was entered wrong', changes: { stipend: '15.00' } })
    expect(locked.status).toBe(409)
    expect(locked.body.code).toBe('fulfilled_offering_locked')
    expect(await trailOf(id)).toEqual([])

    const ok = await request(server).post(`/api/mass-intentions/${id}/correct`).set(auth(tokenA))
      .send({ reason: 'Note was entered wrong', changes: { note: 'Corrected note' } })
    expect(ok.status).toBe(200)
    expect(ok.body.status).toBe('fulfilled')
    const row = await rowOf(id)
    expect(row.stipend).toBe('10.00')
    expect(row.fulfilled_mass_title).toMatch(/^MIH Mass/)
    const trail = await trailOf(id)
    expect(trail).toHaveLength(1)
    expect(trail[0]).toMatchObject({
      organization_id: orgAId, actor_user_id: adminAId, kind: 'correction',
      reason: 'Note was entered wrong',
      before: { note: null }, after: { note: 'Corrected note' },
    })
    expect(trail[0].created_at).toBeTruthy()

    const audit = await pool.query(
      `SELECT metadata FROM ochr_audit_log WHERE organization_id = $1 AND entity_type = 'mass_intention'
          AND entity_id = $2 ORDER BY id DESC LIMIT 1`, [orgAId, String(id)])
    expect(audit.rows[0].metadata.op).toBe('correct')
    expect(audit.rows[0].metadata.changed).toEqual(['note'])
    expect(JSON.stringify(audit.rows[0].metadata)).not.toMatch(/entered wrong/)

    const listed = await request(server).get(`/api/mass-intentions/${id}/corrections`).set(auth(tokenA))
    expect(listed.status).toBe(200)
    expect(listed.body).toHaveLength(1)
  })

  it('staff cannot correct or void', async () => {
    const id = await fulfilled()
    const c = await request(server).post(`/api/mass-intentions/${id}/correct`).set(auth(staffA))
      .send({ reason: 'r', changes: { stipend: '1.00' } })
    expect(c.status).toBe(403)
    expect(c.body.code).toBe(ADMIN_ONLY_CODE)
    const v = await request(server).post(`/api/mass-intentions/${id}/void`).set(auth(staffA))
      .send({ reason: 'dup', disposition: { kind: 'refunded', reason: 'Returned to requester' } })
    expect(v.status).toBe(403)
    expect(await trailOf(id)).toEqual([])
  })

  it('void keeps the row, needs a reason, is recorded, and then locks the row', async () => {
    // N449-3: fulfilled + open 2330 cannot void (deferred remittance).
    const heldId = await fulfilled()
    const held = await request(server).post(`/api/mass-intentions/${heldId}/void`).set(auth(tokenA))
      .send({ reason: 'Duplicate of an earlier entry', disposition: { kind: 'refunded', reason: 'Returned to requester' } })
    expect(held.status).toBe(409)
    expect(held.body.code).toBe(VOID_FULFILLED_HELD_CODE)
    expect((await rowOf(heldId)).voided_at).toBeNull()

    // Zero open liability: void mechanics (reason, trail, lock) still hold.
    const id = await fulfilled(tokenA, { stipend: null })
    const noReason = await request(server).post(`/api/mass-intentions/${id}/void`).set(auth(tokenA)).send({})
    expect(noReason.status).toBe(400)

    const v = await request(server).post(`/api/mass-intentions/${id}/void`).set(auth(tokenA))
      .send({ reason: 'Duplicate of an earlier entry' })
    expect(v.status).toBe(200)
    expect(v.body.status).toBe('cancelled')
    expect(v.body.voided_at).toBeTruthy()
    const row = await rowOf(id)
    expect(row).toMatchObject({ status: 'cancelled', voided_by: adminAId, void_reason: 'Duplicate of an earlier entry' })
    expect(row.fulfilled_mass_title).toMatch(/^MIH Mass/)
    const trail = await trailOf(id)
    expect(trail[0]).toMatchObject({ kind: 'void', actor_user_id: adminAId, before: { status: 'fulfilled' } })

    const again = await request(server).post(`/api/mass-intentions/${id}/void`).set(auth(tokenA)).send({ reason: 'x' })
    expect(again.body.code).toBe(VOIDED_CODE)
    const edit = await request(server).patch(`/api/mass-intentions/${id}`).set(auth(tokenA)).send({ status: 'open' })
    expect(edit.status).toBe(409)
    expect(edit.body.code).toBe(VOIDED_CODE)
    const del = await request(server).delete(`/api/mass-intentions/${id}`).set(auth(tokenA))
    expect(del.status).toBe(409)
  })

  it('a reopened (stamped) row still cannot be deleted', async () => {
    const id = await fulfilled()
    const reopen = await request(server).post(`/api/mass-intentions/${id}/correct`).set(auth(tokenA))
      .send({ reason: 'Marked fulfilled by mistake', changes: { status: 'open' } })
    expect(reopen.status).toBe(200)
    expect(reopen.body.status).not.toBe('fulfilled')
    const del = await request(server).delete(`/api/mass-intentions/${id}`).set(auth(tokenA))
    expect(del.status).toBe(409)
    expect(del.body.code).toBe(FULFILLED_HISTORY_CODE)
  })

  it('another parish cannot correct, void, delete, or read the trail', async () => {
    const id = await fulfilled()
    const c = await request(server).post(`/api/mass-intentions/${id}/correct`).set(auth(tokenB))
      .send({ reason: 'cross-tenant', changes: { stipend: '1.00' } })
    expect(c.status).toBe(404)
    const v = await request(server).post(`/api/mass-intentions/${id}/void`).set(auth(tokenB)).send({ reason: 'x', disposition: { kind: 'refunded', reason: 'Returned to requester' } })
    expect(v.status).toBe(404)
    const d = await request(server).delete(`/api/mass-intentions/${id}`).set(auth(tokenB))
    expect(d.status).toBe(404)
    const t = await request(server).get(`/api/mass-intentions/${id}/corrections`).set(auth(tokenB))
    expect(t.status).toBe(200)
    expect(t.body).toEqual([])
    expect(await trailOf(id)).toEqual([])
    expect((await rowOf(id)).status).toBe('fulfilled')
  })

  // R339-1: protected history is durable — it survives a reopen.
  it('R339-1a: stamped fulfilled → admin reopen → ordinary staff PATCH is refused; no silent change', async () => {
    const id = await fulfilled()
    const reopen = await request(server).post(`/api/mass-intentions/${id}/correct`).set(auth(tokenA))
      .send({ reason: 'Reopened in error', changes: { status: 'open' } })
    expect(reopen.status).toBe(200)
    expect(reopen.body.status).not.toBe('fulfilled')
    const before = await rowOf(id)
    for (const body of [{ intention: 'silently rewritten' }, { stipend: '99.00' }, { note: 'x' }]) {
      const res = await request(server).patch(`/api/mass-intentions/${id}`).set(auth(staffA)).send(body)
      expect(res.status, JSON.stringify(body)).toBe(409)
      // #285 F6 (2026-10-25): the offering has its own, stricter lock.
      expect(res.body.code).toBe('stipend' in body ? 'fulfilled_offering_locked' : FULFILLED_LOCKED_CODE)
    }
    expect(await rowOf(id)).toEqual(before)
    expect(await trailOf(id)).toHaveLength(1)
  })

  it('R339-1b: legacy fulfilled row with NULL stamps → admin correct to open → DELETE refused; trail survives', async () => {
    const { rows } = await pool.query(
      `INSERT INTO ochr_mass_intentions (organization_id, intention, status)
       VALUES ($1, $2, 'fulfilled') RETURNING id`, [orgAId, `† Legacy ${RUN_ID}`])
    const id = rows[0].id
    const reopen = await request(server).post(`/api/mass-intentions/${id}/correct`).set(auth(tokenA))
      .send({ reason: 'Legacy row reopened', changes: { status: 'open' } })
    expect(reopen.status).toBe(200)
    const stamps = await pool.query(
      'SELECT fulfilled_mass_date, fulfilled_mass_title, fulfilled_mass_time FROM ochr_mass_intentions WHERE id = $1', [id])
    expect(stamps.rows[0]).toEqual({ fulfilled_mass_date: null, fulfilled_mass_title: null, fulfilled_mass_time: null })
    const del = await request(server).delete(`/api/mass-intentions/${id}`).set(auth(tokenA))
    expect(del.status).toBe(409)
    expect(del.body.code).toBe(FULFILLED_HISTORY_CODE)
    expect(await rowOf(id)).toBeTruthy()
    const trail = await trailOf(id)
    expect(trail).toHaveLength(1)
    expect(trail[0]).toMatchObject({ kind: 'correction', reason: 'Legacy row reopened' })
  })

  it('R339-1c: the correction trail cannot be cascade-deleted with its intention', async () => {
    // Zero open 2330 so void is allowed (N449-3 only blocks fulfilled+held).
    const id = await fulfilled(tokenA, { stipend: null })
    const v = await request(server).post(`/api/mass-intentions/${id}/void`).set(auth(tokenA)).send({ reason: 'dup' })
    expect(v.status).toBe(200)
    await expect(pool.query('DELETE FROM ochr_mass_intentions WHERE id = $1', [id])).rejects.toThrow()
    expect(await trailOf(id)).toHaveLength(1)
  })

  // R339-2: a voided row is not writable through assign / unassign.
  it('R339-2: assigned, unstamped, voided row — unassign and assign are refused with no new audit or correction row', async () => {
    massSeq += 1
    const mass = await request(server).post('/api/calendar').set(auth(tokenA)).send({
      title: `MIH V Mass ${massSeq} ${RUN_ID}`, date: `2032-05-${String(massSeq).padStart(2, '0')}`,
      start_time: '09:00', end_time: '10:00', type: 'service',
    })
    const other = await request(server).post('/api/calendar').set(auth(tokenA)).send({
      title: `MIH V Other ${massSeq} ${RUN_ID}`, date: `2032-06-${String(massSeq).padStart(2, '0')}`,
      start_time: '09:00', end_time: '10:00', type: 'service',
    })
    const made = await request(server).post('/api/mass-intentions').set(auth(tokenA)).send({ intention: `† Void link ${RUN_ID}` })
    const id = made.body.id
    expect((await request(server).post(`/api/mass-intentions/${id}/assign`).set(auth(tokenA))
      .send({ calendar_event_id: mass.body.id, expected_calendar_event_id: null })).status).toBe(200)
    // D449-4: open 0 + disposition refuses (no_open_stipend). No stipend was
    // held on this unpaid row, so void without a disposition.
    expect((await request(server).post(`/api/mass-intentions/${id}/void`).set(auth(tokenA)).send({ reason: 'Duplicate' })).status).toBe(200)
    const auditCount = async () => Number((await pool.query(
      `SELECT count(*) FROM ochr_audit_log WHERE organization_id = $1 AND entity_type = 'mass_intention' AND entity_id = $2`,
      [orgAId, String(id)])).rows[0].count)
    const a0 = await auditCount()
    const un = await request(server).post(`/api/mass-intentions/${id}/unassign`).set(auth(tokenA))
      .send({ expected_calendar_event_id: mass.body.id })
    expect(un.status).toBe(409)
    expect(un.body.code).toBe(VOIDED_CODE)
    const as = await request(server).post(`/api/mass-intentions/${id}/assign`).set(auth(tokenA))
      .send({ calendar_event_id: other.body.id, expected_calendar_event_id: mass.body.id })
    expect(as.status).toBe(409)
    expect(as.body.code).toBe(VOIDED_CODE)
    const row = (await pool.query('SELECT calendar_event_id, status FROM ochr_mass_intentions WHERE id = $1', [id])).rows[0]
    expect(row).toEqual({ calendar_event_id: mass.body.id, status: 'cancelled' })
    await new Promise(r => setTimeout(r, 150))
    expect(await auditCount()).toBe(a0)
    expect(await trailOf(id)).toHaveLength(1)
  })

  // R339-1 (re-review): assign / unassign also honour the durable latch.
  async function massFor(tag) {
    massSeq += 1
    const m = await request(server).post('/api/calendar').set(auth(tokenA)).send({
      title: `MIH ${tag} ${massSeq} ${RUN_ID}`, date: `2032-07-${String(massSeq).padStart(2, '0')}`,
      start_time: '09:00', end_time: '10:00', type: 'service',
    })
    expect(m.status).toBe(201)
    return m.body
  }
  const counts = async id => ({
    audit: Number((await pool.query(
      `SELECT count(*) FROM ochr_audit_log WHERE organization_id = $1 AND entity_type = 'mass_intention' AND entity_id = $2`,
      [orgAId, String(id)])).rows[0].count),
    trail: (await trailOf(id)).length,
  })
  const stored = async id => (await pool.query(
    `SELECT status, calendar_event_id, to_char(mass_date, 'YYYY-MM-DD') AS mass_date, entered_history,
            fulfilled_mass_date, fulfilled_mass_title, fulfilled_mass_time
       FROM ochr_mass_intentions WHERE id = $1`, [id])).rows[0]

  async function reopenedLegacy() {
    const mass = await massFor('Legacy')
    const { rows } = await pool.query(
      `INSERT INTO ochr_mass_intentions (organization_id, intention, status, calendar_event_id, mass_date)
       VALUES ($1, $2, 'fulfilled', $3, $4::date) RETURNING id`,
      [orgAId, `† Legacy link ${RUN_ID}`, mass.id, mass.date])
    const id = rows[0].id
    const reopen = await request(server).post(`/api/mass-intentions/${id}/correct`).set(auth(tokenA))
      .send({ reason: 'Legacy row reopened', changes: { status: 'open' } })
    expect(reopen.status).toBe(200)
    expect(reopen.body.status).not.toBe('fulfilled')
    const row = await stored(id)
    expect(row).toMatchObject({ entered_history: true, fulfilled_mass_date: null, fulfilled_mass_title: null, fulfilled_mass_time: null })
    return { id, mass }
  }

  it('R339-1d: reopened NULL-stamp legacy row — unassign is refused; nothing stored, no audit/correction row', async () => {
    const { id, mass } = await reopenedLegacy()
    const before = await stored(id); const c0 = await counts(id)
    const res = await request(server).post(`/api/mass-intentions/${id}/unassign`).set(auth(tokenA))
      .send({ expected_calendar_event_id: mass.id })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe(FULFILLED_LOCKED_CODE)
    await new Promise(r => setTimeout(r, 150))
    expect(await stored(id)).toEqual(before)
    expect(await counts(id)).toEqual(c0)
  })

  it('R339-1e: reopened NULL-stamp legacy row — assign to another Mass is refused; same Mass stays a no-op', async () => {
    const { id, mass } = await reopenedLegacy()
    const other = await massFor('Other')
    const before = await stored(id); const c0 = await counts(id)
    const res = await request(server).post(`/api/mass-intentions/${id}/assign`).set(auth(staffA))
      .send({ calendar_event_id: other.id, expected_calendar_event_id: mass.id })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe(FULFILLED_LOCKED_CODE)
    const same = await request(server).post(`/api/mass-intentions/${id}/assign`).set(auth(tokenA))
      .send({ calendar_event_id: mass.id })
    expect(same.status).toBe(200)
    await new Promise(r => setTimeout(r, 150))
    expect(await stored(id)).toEqual(before)
    expect(await counts(id)).toEqual(c0)
  })

  it('R339-1 control: a never-fulfilled row still assigns, re-assigns and unassigns normally (staff)', async () => {
    const a = await massFor('CtlA'); const b = await massFor('CtlB')
    const made = await request(server).post('/api/mass-intentions').set(auth(staffA)).send({ intention: `† Control ${RUN_ID}` })
    const id = made.body.id
    const r1 = await request(server).post(`/api/mass-intentions/${id}/assign`).set(auth(staffA)).send({ calendar_event_id: a.id, expected_calendar_event_id: null })
    expect(r1.status).toBe(200)
    const r2 = await request(server).post(`/api/mass-intentions/${id}/assign`).set(auth(staffA)).send({ calendar_event_id: b.id, expected_calendar_event_id: a.id })
    expect(r2.status).toBe(200)
    expect(r2.body.calendar_event_id).toBe(b.id)
    const r3 = await request(server).post(`/api/mass-intentions/${id}/unassign`).set(auth(staffA)).send({ expected_calendar_event_id: b.id })
    expect(r3.status).toBe(200)
    expect((await stored(id))).toMatchObject({ calendar_event_id: null, status: 'open', entered_history: false })
  })
})

