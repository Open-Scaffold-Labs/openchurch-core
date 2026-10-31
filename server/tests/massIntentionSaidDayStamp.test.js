// L3 canonical history (TARS, #354 comment 6327273061). Bulk mark said
// used to stamp fulfilled_mass_title/time from the linked Mass even when
// the confirmed said day was a different day, so the book and the weekly
// sheet presented "Jan 16 · Morning Mass 09:30" for a Mass held Jan 15.
// Rule: a different confirmed day is recorded with title and time NULL;
// same-day, default-day and unlinked rows keep the matching snapshot (or
// none). The planned calendar link stays. Real Postgres, isolated DB.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'
import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'

let server, admin
const auth = token => ({ Authorization: `Bearer ${token}` })
const uuid = () => crypto.randomUUID()

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  const a = await createOrg(server, {
    organizationName: `L3 Stamp Parish ${RUN_ID}`, name: 'Ada Admin',
    email: `l3s_a_${RUN_ID}@example.com`, password: 'l3-stamp-pw-1',
  }, '10.241.9.1')
  expect(a.status).toBe(201)
  admin = { token: a.body.token, id: a.body.user.organization.id }
}, 60_000)

afterAll(async () => { await closeServer(server); await pool.end() })

async function mass(date, title) {
  const res = await request(server).post('/api/calendar').set(auth(admin.token))
    .send({ title, date, start_time: '09:30', end_time: '10:30', type: 'service' })
  expect(res.status).toBe(201)
  return res.body.id
}
async function intention(text, eventId) {
  const made = await request(server).post('/api/mass-intentions').set(auth(admin.token))
    .send({ intention: text, stipend: '10.00', requested_by: 'Synthetic Requester' })
  expect(made.status).toBe(201)
  if (eventId) {
    const assigned = await request(server).post(`/api/mass-intentions/${made.body.id}/assign`).set(auth(admin.token))
      .send({ calendar_event_id: eventId })
    expect(assigned.status).toBe(200)
  }
  return made.body.id
}
const stored = async id => (await pool.query(
  `SELECT status, to_char(fulfilled_mass_date, 'YYYY-MM-DD') AS d, fulfilled_mass_title AS title,
          to_char(fulfilled_mass_time, 'HH24:MI') AS time, calendar_event_id, stipend::text AS stipend
     FROM ochr_mass_intentions WHERE id = $1`, [id])).rows[0]
const markAudits = async id => (await pool.query(
  `SELECT metadata FROM ochr_audit_log WHERE organization_id = $1 AND entity_type = 'mass_intention'
      AND entity_id = $2 ORDER BY id`, [admin.id, String(id)])).rows.map(r => r.metadata).filter(m => m.op === 'mark_said')
const post = (items, request_id = uuid()) => request(server).post('/api/mass-intentions/bulk-mark-said')
  .set(auth(admin.token)).send({ confirm: true, request_id, items })
const listRow = async (text) => {
  const res = await request(server).get(`/api/mass-intentions?q=${encodeURIComponent(text)}`).set(auth(admin.token))
  expect(res.status).toBe(200)
  return res.body.intentions.find(r => r.intention === text)
}
const weeklyRow = async (start, text) => {
  const end = new Date(Date.parse(`${start}T00:00:00Z`) + 6 * 864e5).toISOString().slice(0, 10)
  const res = await request(server).get(`/api/mass-intentions/weekly?start=${start}&end=${end}`).set(auth(admin.token))
  expect(res.status).toBe(200)
  return res.body.intentions.find(r => r.formatted_intention === text)
}

describe('L3 said-day stamp: a different confirmed day carries no unconfirmed Mass', () => {
  it('different day: day recorded, title/time NULL, planned link kept; list and weekly agree', async () => {
    const ev = await mass('2020-01-15', `Morning Mass ${RUN_ID}`)
    const text = `L3 different ${RUN_ID}`
    const id = await intention(text, ev)
    const res = await post([{ id, fulfilled_date: '2020-01-16' }])
    expect(res.status).toBe(200)
    expect(res.body.marked).toEqual([{ id, fulfilled_date: '2020-01-16' }])
    const row = await stored(id)
    expect(row).toMatchObject({ status: 'fulfilled', d: '2020-01-16', title: null, time: null, stipend: '10.00' })
    expect(Number(row.calendar_event_id)).toBe(Number(ev))
    const l = await listRow(text)
    expect(l).toMatchObject({ status: 'fulfilled', mass_date: '2020-01-16', mass_title: null, mass_time: null })
    const w = await weeklyRow('2020-01-11', text)
    expect(w).toMatchObject({ mass_date: '2020-01-16', mass_title: null, mass_time: null })
    const [audit] = await markAudits(id)
    expect(audit.after.fulfilled_mass_date).toBe('2020-01-16')
    expect(audit.after.status).toBe('fulfilled')
    expect(audit.after.calendar_event_id).toBe(Number(ev))
    expect(audit.before.fulfilled_mass_date).toBeNull()
  })

  it('same day typed explicitly keeps the matching Mass snapshot', async () => {
    const ev = await mass('2020-02-15', `Same Mass ${RUN_ID}`)
    const id = await intention(`L3 same ${RUN_ID}`, ev)
    expect((await post([{ id, fulfilled_date: '2020-02-15' }])).status).toBe(200)
    expect(await stored(id)).toMatchObject({ d: '2020-02-15', title: `Same Mass ${RUN_ID}`, time: '09:30' })
    expect(await listRow(`L3 same ${RUN_ID}`)).toMatchObject({ mass_title: `Same Mass ${RUN_ID}`, mass_time: '09:30' })
  })

  it('default day (none typed) keeps the matching Mass snapshot', async () => {
    const ev = await mass('2020-03-15', `Default Mass ${RUN_ID}`)
    const text = `L3 default ${RUN_ID}`
    const id = await intention(text, ev)
    expect((await post([{ id }])).status).toBe(200)
    expect(await stored(id)).toMatchObject({ d: '2020-03-15', title: `Default Mass ${RUN_ID}`, time: '09:30' })
    expect(await weeklyRow('2020-03-14', text)).toMatchObject({ mass_title: `Default Mass ${RUN_ID}`, mass_time: '09:30' })
  })

  it('unlinked row with a typed day records the day and no Mass', async () => {
    const id = await intention(`L3 unlinked ${RUN_ID}`)
    expect((await post([{ id, fulfilled_date: '2020-04-04' }])).status).toBe(200)
    expect(await stored(id)).toMatchObject({ d: '2020-04-04', title: null, time: null, calendar_event_id: null })
  })

  it('replay of the same different-day confirmation is idempotent: one write, one audit row', async () => {
    const ev = await mass('2020-05-15', `Replay Mass ${RUN_ID}`)
    const id = await intention(`L3 replay ${RUN_ID}`, ev)
    const rid = uuid()
    const first = await post([{ id, fulfilled_date: '2020-05-17' }], rid)
    const second = await post([{ id, fulfilled_date: '2020-05-17' }], rid)
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(second.body.replayed).toBe(true)
    expect(second.body.marked).toEqual(first.body.marked)
    expect(await markAudits(id)).toHaveLength(1)
    expect(await stored(id)).toMatchObject({ d: '2020-05-17', title: null, time: null })
  })

  it('a different-day marking undoes cleanly, and Undo stays guarded after a change', async () => {
    const ev = await mass('2020-06-15', `Undo Mass ${RUN_ID}`)
    const id = await intention(`L3 undo ${RUN_ID}`, ev)
    const marked = await post([{ id, fulfilled_date: '2020-06-16' }])
    const undo = await request(server).post(`/api/mass-intentions/bulk-mark-said/${marked.body.batch_id}/undo`)
      .set(auth(admin.token)).send({ confirm: true })
    expect(undo.status).toBe(200)
    expect(undo.body.restored).toEqual([{ id }])
    const back = await stored(id)
    expect(back).toMatchObject({ status: 'scheduled', d: null, title: null, time: null })
    expect(Number(back.calendar_event_id)).toBe(Number(ev))

    const id2 = await intention(`L3 undo guarded ${RUN_ID}`, ev)
    const m2 = await post([{ id: id2, fulfilled_date: '2020-06-17' }])
    await pool.query(`UPDATE ochr_mass_intentions SET note = 'changed under us' WHERE id = $1`, [id2])
    const blocked = await request(server).post(`/api/mass-intentions/bulk-mark-said/${m2.body.batch_id}/undo`)
      .set(auth(admin.token)).send({ confirm: true })
    expect(blocked.status).toBe(409)
    expect(blocked.body.code).toBe('undo_conflict')
    expect(await stored(id2)).toMatchObject({ status: 'fulfilled', d: '2020-06-17', title: null })
  })

  it('a failed audit write rolls the different-day stamp back entirely', async () => {
    const ev = await mass('2020-07-15', `Atomic Mass ${RUN_ID}`)
    const id = await intention(`L3 atomic ${RUN_ID}`, ev)
    const trig = `l3s_fail_${RUN_ID.replace(/[^a-z0-9]/gi, '').slice(0, 20).toLowerCase()}`
    await pool.query(`CREATE FUNCTION ${trig}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'l3 synthetic audit failure'; END $$`)
    await pool.query(`CREATE TRIGGER ${trig} BEFORE INSERT ON ochr_audit_log FOR EACH ROW
      WHEN (NEW.organization_id = ${Number(admin.id)} AND NEW.entity_type = 'mass_intention') EXECUTE FUNCTION ${trig}()`)
    try {
      const failed = await post([{ id, fulfilled_date: '2020-07-16' }])
      expect(failed.status).toBe(500)
      expect(await stored(id)).toMatchObject({ status: 'scheduled', d: null, title: null, time: null })
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS ${trig} ON ochr_audit_log`)
      await pool.query(`DROP FUNCTION IF EXISTS ${trig}()`)
    }
  })

  it('does not rewrite stamps written before this rule (no backfill)', async () => {
    const ev = await mass('2020-08-15', `Legacy Mass ${RUN_ID}`)
    const id = await intention(`L3 legacy ${RUN_ID}`, ev)
    await pool.query(`UPDATE ochr_mass_intentions SET status = 'fulfilled', fulfilled_mass_date = '2020-08-16',
      fulfilled_mass_title = 'Legacy Mass', fulfilled_mass_time = '09:30' WHERE id = $1`, [id])
    await migrateOnce()
    expect(await stored(id)).toMatchObject({ d: '2020-08-16', title: 'Legacy Mass', time: '09:30' })
  })
})
