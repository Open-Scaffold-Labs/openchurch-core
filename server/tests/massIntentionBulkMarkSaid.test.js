// D-1 — bulk "Mark said" for Mass intentions.
//
// On main this route does not exist, so these assertions are red there
// and green with the route. They cover the approved rules: admin and
// secretary only, explicit ids, confirmation, the Mass's day rather than
// today, no re-stamp, one audit row per intention with a before/after
// snapshot and a batch id, audited undo, no stipend change, tenant
// scope, idempotent retry, honest partial results, and a lock held by
// another transaction.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'
import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'

let server, admin, staff, viewer, other
const PW = 'd1-mark-said-pw-1'
const PHRASE = `† D1 phrase ${RUN_ID}`

const auth = token => ({ Authorization: `Bearer ${token}` })
const uuid = () => crypto.randomUUID()

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  const a = await createOrg(server, {
    organizationName: `D1 Parish A ${RUN_ID}`, name: 'Ada Admin',
    email: `d1_a_${RUN_ID}@example.com`, password: PW,
  }, '10.241.1.1')
  expect(a.status).toBe(201)
  admin = { token: a.body.token, id: a.body.user.organization.id, userId: a.body.user.id }
  const b = await createOrg(server, {
    organizationName: `D1 Parish B ${RUN_ID}`, name: 'Bea Admin',
    email: `d1_b_${RUN_ID}@example.com`, password: PW,
  }, '10.241.1.2')
  expect(b.status).toBe(201)
  other = { token: b.body.token, id: b.body.user.organization.id }
  const mk = async (name, email, role) => {
    const made = await request(server).post('/api/users').set(auth(admin.token))
      .send({ name, email, password: PW, role })
    expect(made.status).toBe(201)
    const login = await request(server).post('/api/auth/login').send({ email, password: PW })
    expect(login.status).toBe(200)
    return login.body.token
  }
  staff = await mk('Sue Secretary', `d1_s_${RUN_ID}@example.com`, 'staff')
  viewer = await mk('Vic Viewer', `d1_v_${RUN_ID}@example.com`, 'viewer')
}, 60_000)

afterAll(async () => {
  await closeServer(server)
  await pool.end()
})

async function mass(token, date, title = `D1 Mass ${RUN_ID}`) {
  const res = await request(server).post('/api/calendar').set(auth(token))
    .send({ title, date, start_time: '09:30', end_time: '10:30', type: 'service' })
  expect(res.status).toBe(201)
  return res.body.id
}

async function intention(token, { text = PHRASE, stipend = '12.50', eventId, status = 'scheduled' } = {}) {
  const made = await request(server).post('/api/mass-intentions').set(auth(token))
    .send({ intention: text, stipend, requested_by: 'Synthetic Requester' })
  expect(made.status).toBe(201)
  if (eventId) {
    const assigned = await request(server).post(`/api/mass-intentions/${made.body.id}/assign`).set(auth(token))
      .send({ calendar_event_id: eventId })
    expect(assigned.status).toBe(200)
  }
  if (status === 'cancelled') {
    const patched = await request(server).patch(`/api/mass-intentions/${made.body.id}`).set(auth(token))
      .send({ status: 'cancelled' })
    expect(patched.status).toBe(200)
  }
  return made.body.id
}

const stored = async (id) => (await pool.query(
  `SELECT status, stipend::text AS stipend,
          to_char(fulfilled_mass_date, 'YYYY-MM-DD') AS fulfilled_mass_date,
          fulfilled_mass_title,
          to_char(fulfilled_mass_time, 'HH24:MI:SS') AS fulfilled_mass_time,
          entered_history, calendar_event_id
     FROM ochr_mass_intentions WHERE id = $1`,
  [id]
)).rows[0]

const audits = async (orgId, id) => (await pool.query(
  `SELECT metadata FROM ochr_audit_log
    WHERE organization_id = $1 AND entity_type = 'mass_intention' AND entity_id = $2
    ORDER BY id`,
  [orgId, String(id)]
)).rows.map(r => r.metadata)

function postMark(token, items, extra = {}) {
  return request(server).post('/api/mass-intentions/bulk-mark-said').set(auth(token))
    .send({ confirm: true, request_id: uuid(), items, ...extra })
}

describe('D-1 bulk mark said', () => {
  it('does not take the fulfilment day from today, and does not touch the offering', async () => {
    const src = readFileSync(new URL('../src/routes/massIntentionMarkSaid.js', import.meta.url), 'utf8')
    expect(src).not.toMatch(/CURRENT_DATE/)
    const eventId = await mass(admin.token, '2020-01-15', `Morning Mass ${RUN_ID}`)
    const id = await intention(admin.token, { eventId })
    const before = await stored(id)
    const res = await postMark(admin.token, [{ id }])
    expect(res.status).toBe(200)
    expect(res.body.marked).toEqual([{ id, fulfilled_date: '2020-01-15' }])
    expect(res.body.excluded).toEqual([])
    const after = await stored(id)
    expect(after.status).toBe('fulfilled')
    expect(after.fulfilled_mass_date).toBe('2020-01-15')
    expect(after.fulfilled_mass_date).not.toBe('2026-10-20')
    expect(after.fulfilled_mass_title).toBe(`Morning Mass ${RUN_ID}`)
    expect(after.fulfilled_mass_time).toBe('09:30:00')
    expect(after.stipend).toBe(before.stipend)
    expect(after.entered_history).toBe(true)
    const rows = (await audits(admin.id, id)).filter(m => m.op === 'mark_said')
    expect(rows).toHaveLength(1)
    expect(rows[0].batch_id).toBe(res.body.batch_id)
    expect(rows[0].before).toMatchObject({ id: Number(id), status: 'scheduled', fulfilled_mass_date: null })
    expect(rows[0].after).toMatchObject({ id: Number(id), status: 'fulfilled', fulfilled_mass_date: '2020-01-15' })
    expect(rows[0].changed).toEqual(['status', 'fulfilled_mass_date'])
    expect(JSON.stringify(rows)).not.toContain(PHRASE)
    expect(JSON.stringify(rows)).not.toContain('Synthetic Requester')
    const batch = await pool.query(
      `SELECT outcome::text AS outcome FROM ochr_mass_intention_mark_batches
        WHERE id = $1 AND organization_id = $2`,
      [res.body.batch_id, admin.id]
    )
    expect(batch.rows[0].outcome).not.toContain(PHRASE)
  })

  it('keeps an edited day, and leaves an undated unlinked row out', async () => {
    const eventId = await mass(admin.token, '2020-02-02')
    const linked = await intention(admin.token, { eventId, text: `† linked ${RUN_ID}` })
    const loose = await intention(admin.token, { text: `† loose ${RUN_ID}`, status: 'open' })
    const res = await postMark(admin.token, [
      { id: linked, fulfilled_date: '2020-02-03' },
      { id: loose },
    ])
    expect(res.status).toBe(200)
    expect(res.body.marked).toEqual([{ id: linked, fulfilled_date: '2020-02-03' }])
    expect(res.body.excluded).toEqual([{ id: loose, code: 'needs_date' }])
    expect((await stored(linked)).fulfilled_mass_date).toBe('2020-02-03')
    expect((await stored(loose)).status).not.toBe('fulfilled')
    expect((await stored(loose)).fulfilled_mass_date).toBeNull()
  })

  it('records an explicit day for a row with no Mass, and refuses a silent one', async () => {
    const loose = await intention(staff, { text: `† dated loose ${RUN_ID}` })
    const open = await intention(admin.token, { text: `† still open ${RUN_ID}` })
    const res = await postMark(staff, [
      { id: loose, fulfilled_date: '2020-03-03' },
      { id: open, fulfilled_date: null },
    ])
    expect(res.status).toBe(200)
    expect(res.body.marked).toEqual([{ id: loose, fulfilled_date: '2020-03-03' }])
    expect(res.body.excluded).toEqual([{ id: open, code: 'needs_date' }])
    const row = await stored(loose)
    expect(row.status).toBe('fulfilled')
    expect(row.fulfilled_mass_date).toBe('2020-03-03')
    expect(row.fulfilled_mass_title).toBeNull()
    expect(row.stipend).toBe('12.50')
  })

  it('does not re-stamp a row already fulfilled, cancelled, or voided', async () => {
    const eventId = await mass(admin.token, '2020-04-04')
    const said = await intention(admin.token, { eventId, text: `† already ${RUN_ID}` })
    const first = await postMark(admin.token, [{ id: said }])
    expect(first.status).toBe(200)
    const again = await postMark(admin.token, [{ id: said, fulfilled_date: '2020-04-05' }])
    expect(again.status).toBe(200)
    expect(again.body.marked).toEqual([])
    expect(again.body.excluded).toEqual([{ id: said, code: 'already_fulfilled' }])
    expect((await stored(said)).fulfilled_mass_date).toBe('2020-04-04')

    const cancelled = await intention(admin.token, { eventId, text: `† cancelled ${RUN_ID}`, status: 'cancelled' })
    const voidedId = await intention(admin.token, { eventId, text: `† voided ${RUN_ID}` })
    const voided = await request(server).post(`/api/mass-intentions/${voidedId}/void`).set(auth(admin.token))
      .send({ reason: 'Duplicate synthetic row', disposition: { kind: 'refunded', reason: 'Returned to requester' } })
    expect(voided.status).toBe(200)
    const mixed = await postMark(admin.token, [{ id: cancelled }, { id: voidedId }])
    expect(mixed.body.excluded.map(e => e.code).sort()).toEqual(['cancelled', 'voided'])
    expect((await stored(cancelled)).status).toBe('cancelled')
    expect((await stored(voidedId)).fulfilled_mass_date).toBeNull()

    const stamped = await intention(admin.token, { eventId, text: `† stamped ${RUN_ID}` })
    await pool.query(
      `UPDATE ochr_mass_intentions
          SET status = 'scheduled', fulfilled_mass_date = '2018-01-01', fulfilled_mass_title = 'Earlier Mass'
        WHERE id = $1 AND organization_id = $2`,
      [stamped, admin.id]
    )
    const recorded = await postMark(admin.token, [{ id: stamped, fulfilled_date: '2020-04-06' }])
    expect(recorded.status).toBe(200)
    expect(recorded.body.marked).toEqual([])
    expect(recorded.body.excluded).toEqual([{ id: stamped, code: 'already_recorded' }])
    expect((await stored(stamped)).fulfilled_mass_date).toBe('2018-01-01')
    expect((await stored(stamped)).fulfilled_mass_title).toBe('Earlier Mass')
    expect((await audits(admin.id, stamped)).filter(m => m.op === 'mark_said')).toHaveLength(0)
  })

  it('refuses a viewer, an unconfirmed body, an implicit all, and a non-id', async () => {
    const eventId = await mass(admin.token, '2020-05-05')
    const id = await intention(admin.token, { eventId, text: `† guarded ${RUN_ID}` })
    const viewerRes = await postMark(viewer, [{ id }])
    expect(viewerRes.status).toBe(403)
    const noConfirm = await request(server).post('/api/mass-intentions/bulk-mark-said').set(auth(admin.token))
      .send({ request_id: uuid(), items: [{ id }] })
    expect(noConfirm.status).toBe(400)
    expect(noConfirm.body.code).toBe('confirm_required')
    const all = await postMark(admin.token, [{ id }], { all: true })
    expect(all.status).toBe(400)
    expect(all.body.code).toBe('explicit_selection')
    const bad = await postMark(admin.token, [{ id: true }])
    expect(bad.status).toBe(400)
    expect((await stored(id)).status).toBe('scheduled')
    const batches = await pool.query(
      'SELECT count(*)::int AS n FROM ochr_mass_intention_mark_batches WHERE organization_id = $1',
      [admin.id]
    )
    // Earlier tests in this file did write batches. This one must not add one
    // for the refused calls: the row is still scheduled, which is the claim.
    expect((await stored(id)).fulfilled_mass_date).toBeNull()
    expect(batches.rows[0].n).toBeGreaterThan(0)
  })

  it('keeps the other parish untouched and replays the same confirmation once', async () => {
    const eventId = await mass(admin.token, '2020-06-06')
    const mine = await intention(admin.token, { eventId, text: `† mine ${RUN_ID}` })
    const theirsEvent = await mass(other.token, '2020-06-07')
    const theirs = await intention(other.token, { eventId: theirsEvent, text: `† theirs ${RUN_ID}` })
    const request_id = uuid()
    const body = { confirm: true, request_id, items: [{ id: mine }, { id: theirs }] }
    const first = await request(server).post('/api/mass-intentions/bulk-mark-said').set(auth(admin.token)).send(body)
    expect(first.status).toBe(200)
    expect(first.body.marked).toEqual([{ id: mine, fulfilled_date: '2020-06-06' }])
    expect(first.body.excluded).toEqual([{ id: theirs, code: 'not_found' }])
    expect((await stored(theirs)).status).toBe('scheduled')
    expect((await stored(theirs)).fulfilled_mass_date).toBeNull()
    const markAudits = () => audits(admin.id, mine).then(rows => rows.filter(m => m.op === 'mark_said'))
    expect(await markAudits()).toHaveLength(1)
    const second = await request(server).post('/api/mass-intentions/bulk-mark-said').set(auth(admin.token)).send(body)
    expect(second.status).toBe(200)
    expect(second.body.replayed).toBe(true)
    expect(second.body.marked).toEqual(first.body.marked)
    expect(await markAudits()).toHaveLength(1)
    expect((await stored(mine)).fulfilled_mass_date).toBe('2020-06-06')
    const changed = await request(server).post('/api/mass-intentions/bulk-mark-said').set(auth(admin.token))
      .send({ ...body, items: [{ id: mine, fulfilled_date: '2020-06-08' }] })
    expect(changed.status).toBe(409)
    expect(changed.body.code).toBe('payload_conflict')
    expect((await stored(mine)).fulfilled_mass_date).toBe('2020-06-06')
    const cross = await pool.query(
      `SELECT count(*)::int AS n FROM ochr_mass_intention_mark_batches WHERE organization_id = $1`,
      [other.id]
    )
    expect(cross.rows[0].n).toBe(0)
  })

  it('undoes within the same hands, audits it, and will not undo a row that changed', async () => {
    const eventId = await mass(admin.token, '2020-07-07')
    const id = await intention(admin.token, { eventId, text: `† undo ${RUN_ID}` })
    const marked = await postMark(admin.token, [{ id, fulfilled_date: '2020-07-07' }])
    expect(marked.status).toBe(200)
    const batchId = marked.body.batch_id

    const stranger = await request(server).post(`/api/mass-intentions/bulk-mark-said/${batchId}/undo`)
      .set(auth(staff)).send({ confirm: true })
    expect(stranger.status).toBe(404)
    expect((await stored(id)).status).toBe('fulfilled')

    const undone = await request(server).post(`/api/mass-intentions/bulk-mark-said/${batchId}/undo`)
      .set(auth(admin.token)).send({ confirm: true })
    expect(undone.status).toBe(200)
    expect(undone.body.restored).toEqual([{ id }])
    expect(undone.body.already).toBe(false)
    const row = await stored(id)
    expect(row.status).toBe('scheduled')
    expect(row.fulfilled_mass_date).toBeNull()
    expect(row.fulfilled_mass_title).toBeNull()
    expect(row.entered_history).toBe(false)
    expect(row.stipend).toBe('12.50')
    const undoRows = (await audits(admin.id, id)).filter(m => m.op === 'undo_mark_said')
    expect(undoRows).toHaveLength(1)
    expect(undoRows[0].batch_id).toBe(batchId)
    expect(undoRows[0].before.status).toBe('fulfilled')
    expect(undoRows[0].after.status).toBe('scheduled')
    expect(JSON.stringify(undoRows)).not.toContain(`undo ${RUN_ID}`)

    const again = await request(server).post(`/api/mass-intentions/bulk-mark-said/${batchId}/undo`)
      .set(auth(admin.token)).send({ confirm: true })
    expect(again.status).toBe(200)
    expect(again.body.already).toBe(true)
    expect((await audits(admin.id, id)).filter(m => m.op === 'undo_mark_said')).toHaveLength(1)

    const note = await request(server).patch(`/api/mass-intentions/${id}`).set(auth(admin.token))
      .send({ note: 'Still on the book' })
    expect(note.status).toBe(200)

    const latchedEvent = await mass(admin.token, '2020-07-07', `Latch Mass ${RUN_ID}`)
    const latched = await intention(admin.token, { eventId: latchedEvent, text: `† latch ${RUN_ID}` })
    const latchedMark = await postMark(admin.token, [{ id: latched }])
    expect(latchedMark.status).toBe(200)
    await pool.query(
      `UPDATE ochr_mass_intentions SET entered_history = false WHERE id = $1 AND organization_id = $2`,
      [latched, admin.id]
    )
    expect((await stored(latched)).entered_history).toBe(true)
    const latchedUndo = await request(server).post(`/api/mass-intentions/bulk-mark-said/${latchedMark.body.batch_id}/undo`)
      .set(auth(admin.token)).send({ confirm: true })
    expect(latchedUndo.status).toBe(409)
    expect(latchedUndo.body.code).toBe('undo_conflict')
    expect((await stored(latched)).status).toBe('fulfilled')
    expect((await stored(latched)).entered_history).toBe(true)

    const event2 = await mass(admin.token, '2020-07-08')
    const moved = await intention(admin.token, { eventId: event2, text: `† moved ${RUN_ID}` })
    const marked2 = await postMark(admin.token, [{ id: moved }])
    expect(marked2.status).toBe(200)
    await pool.query(
      `UPDATE ochr_mass_intentions SET note = 'changed under us'
        WHERE id = $1 AND organization_id = $2`,
      [moved, admin.id]
    )
    const blocked = await request(server).post(`/api/mass-intentions/bulk-mark-said/${marked2.body.batch_id}/undo`)
      .set(auth(admin.token)).send({ confirm: true })
    expect(blocked.status).toBe(409)
    expect(blocked.body.code).toBe('undo_conflict')
    expect((await stored(moved)).status).toBe('fulfilled')
    expect((await stored(moved)).fulfilled_mass_date).toBe('2020-07-08')
    expect((await audits(admin.id, moved)).filter(m => m.op === 'undo_mark_said')).toHaveLength(0)
  })

  it('reports a partial set in one transaction and rolls back when the audit row cannot be written', async () => {
    const eventId = await mass(admin.token, '2020-08-08')
    const good = await intention(admin.token, { eventId, text: `† partial good ${RUN_ID}` })
    const said = await intention(admin.token, { eventId, text: `† partial said ${RUN_ID}` })
    const prime = await postMark(admin.token, [{ id: said }])
    expect(prime.status).toBe(200)
    const loose = await intention(admin.token, { text: `† partial loose ${RUN_ID}` })
    const res = await postMark(admin.token, [{ id: good, fulfilled_date: '2020-08-09' }, { id: said }, { id: loose }])
    expect(res.status).toBe(200)
    expect(res.body.marked).toEqual([{ id: good, fulfilled_date: '2020-08-09' }])
    expect(res.body.excluded.map(e => e.code).sort()).toEqual(['already_fulfilled', 'needs_date'])
    expect((await stored(said)).fulfilled_mass_date).toBe('2020-08-08')
    expect((await stored(good)).stipend).toBe('12.50')

    const eventFail = await mass(admin.token, '2020-08-10')
    const failId = await intention(admin.token, { eventId: eventFail, text: `† audit fail ${RUN_ID}` })
    const trig = `d1_fail_audit_${createHash('sha1').update(RUN_ID).digest('hex').slice(0, 12)}`
    await pool.query(`CREATE FUNCTION ${trig}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'd1 synthetic audit failure'; END $$`)
    await pool.query(`CREATE TRIGGER ${trig} BEFORE INSERT ON ochr_audit_log
      FOR EACH ROW WHEN (NEW.organization_id = ${Number(admin.id)} AND NEW.entity_type = 'mass_intention')
      EXECUTE FUNCTION ${trig}()`)
    try {
      const failed = await postMark(admin.token, [{ id: failId }])
      expect(failed.status).toBe(500)
      expect(failed.body.code).toBe('mark_said_failed')
      expect((await stored(failId)).status).toBe('scheduled')
      expect((await stored(failId)).fulfilled_mass_date).toBeNull()
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS ${trig} ON ochr_audit_log`)
      await pool.query(`DROP FUNCTION IF EXISTS ${trig}()`)
    }
  })

  it('does not re-stamp a row another transaction fulfilled while this one waited', async () => {
    const eventId = await mass(admin.token, '2020-09-09', `Waiting Mass ${RUN_ID}`)
    const id = await intention(admin.token, { eventId, text: `† racing ${RUN_ID}` })
    const holder = await pool.connect()
    try {
      await holder.query('BEGIN')
      await holder.query(
        `SELECT id FROM ochr_mass_intentions WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
        [id, admin.id]
      )
      const { rows: [{ pid: holderPid }] } = await holder.query('SELECT pg_backend_pid() AS pid')
      // supertest does not send until .end() / await. .end() starts it now,
      // while this transaction still holds the row.
      let settled = false
      const pending = new Promise((resolve, reject) => {
        request(server).post('/api/mass-intentions/bulk-mark-said').set(auth(admin.token))
          .send({ confirm: true, request_id: uuid(), items: [{ id, fulfilled_date: '2020-09-10' }] })
          .end((err, res) => { settled = true; if (err) reject(err); else resolve(res) })
      })
      const start = Date.now()
      let waiting = false
      while (Date.now() - start < 8000) {
        const { rows } = await pool.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE pid <> pg_backend_pid()
              AND $1::int = ANY(pg_blocking_pids(pid))`,
          [holderPid]
        )
        if (rows[0].n > 0) { waiting = true; break }
        if (settled) break
        await new Promise(r => setTimeout(r, 40))
      }
      expect(waiting).toBe(true)
      await holder.query(
        `UPDATE ochr_mass_intentions
            SET status = 'fulfilled',
                fulfilled_mass_date = '2019-06-01',
                fulfilled_mass_title = 'Held Mass',
                fulfilled_mass_time = '07:00'
          WHERE id = $1 AND organization_id = $2`,
        [id, admin.id]
      )
      await holder.query('COMMIT')
      const res = await pending
      expect(res.status).toBe(200)
      expect(res.body.marked).toEqual([])
      expect(res.body.excluded).toEqual([{ id, code: 'already_fulfilled' }])
      const row = await stored(id)
      expect(row.fulfilled_mass_date).toBe('2019-06-01')
      expect(row.fulfilled_mass_title).toBe('Held Mass')
      expect(row.fulfilled_mass_time).toBe('07:00:00')
      expect((await audits(admin.id, id)).filter(m => m.op === 'mark_said')).toHaveLength(0)
    } finally {
      await holder.query('ROLLBACK').catch(() => {})
      holder.release()
    }
  }, 20_000)

  it('R348-1 does not mark a row an administrator has already corrected', async () => {
    const eventId = await mass(admin.token, '2020-10-10', `Protected Mass ${RUN_ID}`)
    const controlId = await intention(admin.token, { eventId, text: `† control ${RUN_ID}` })
    const protectedId = await intention(admin.token, { eventId, text: `† protected ${RUN_ID}` })
    const corrected = await request(server).post(`/api/mass-intentions/${protectedId}/correct`)
      .set(auth(admin.token))
      .send({ reason: 'The family asked for a clearer note', changes: { note: 'Kept in the record' } })
    expect(corrected.status).toBe(200)
    const before = await stored(protectedId)
    expect(before.entered_history).toBe(true)
    expect(before.status).not.toBe('fulfilled')
    expect(before.fulfilled_mass_date).toBeNull()
    const corrections = async () => (await pool.query(
      `SELECT count(*)::int AS n FROM ochr_mass_intention_corrections
        WHERE organization_id = $1 AND mass_intention_id = $2`,
      [admin.id, protectedId]
    )).rows[0].n
    const correctionCount = await corrections()

    const control = await postMark(staff, [{ id: controlId }])
    expect(control.status).toBe(200)
    expect(control.body.marked).toEqual([{ id: controlId, fulfilled_date: '2020-10-10' }])

    for (const token of [staff, admin.token]) {
      const res = await postMark(token, [{ id: protectedId, fulfilled_date: '2020-10-11' }])
      expect(res.status).toBe(200)
      expect(res.body.marked).toEqual([])
      expect(res.body.excluded).toEqual([{ id: protectedId, code: 'history_locked' }])
    }
    const after = await stored(protectedId)
    expect(after).toEqual(before)
    expect(await corrections()).toBe(correctionCount)
    expect((await audits(admin.id, protectedId)).filter(m => m.op === 'mark_said')).toHaveLength(0)
    expect((await stored(controlId)).status).toBe('fulfilled')
  })

  it('R348-2 refuses undo after a correction is reversed to the same values', async () => {
    const eventId = await mass(admin.token, '2020-10-12', `Revision Mass ${RUN_ID}`)
    const id = await intention(admin.token, { eventId, text: `† revision ${RUN_ID}` })
    const noted = await request(server).patch(`/api/mass-intentions/${id}`).set(auth(admin.token))
      .send({ note: 'Alpha' })
    expect(noted.status).toBe(200)
    const marked = await postMark(admin.token, [{ id }])
    expect(marked.status).toBe(200)
    const atMark = await pool.query(
      `SELECT status, note, entered_history,
              to_char(fulfilled_mass_date, 'YYYY-MM-DD') AS fulfilled_mass_date,
              fulfilled_mass_title,
              to_char(fulfilled_mass_time, 'HH24:MI:SS') AS fulfilled_mass_time,
              to_char(mass_date, 'YYYY-MM-DD') AS mass_date,
              calendar_event_id, (voided_at IS NOT NULL) AS voided,
              stipend::text AS stipend, requested_by_client_id, intention, requested_by
         FROM ochr_mass_intentions WHERE id = $1 AND organization_id = $2`,
      [id, admin.id]
    )
    const { intentionDigest } = await import('../src/routes/massIntentionMarkSaid.js')
    const digestAtMark = intentionDigest(atMark.rows[0])
    const toBeta = await request(server).post(`/api/mass-intentions/${id}/correct`).set(auth(admin.token))
      .send({ reason: 'The note was read wrong', changes: { note: 'Beta' } })
    expect(toBeta.status).toBe(200)
    const back = await request(server).post(`/api/mass-intentions/${id}/correct`).set(auth(admin.token))
      .send({ reason: 'The first note was right', changes: { note: 'Alpha' } })
    expect(back.status).toBe(200)
    const after = await pool.query(
      `SELECT status, note, entered_history,
              to_char(fulfilled_mass_date, 'YYYY-MM-DD') AS fulfilled_mass_date,
              fulfilled_mass_title,
              to_char(fulfilled_mass_time, 'HH24:MI:SS') AS fulfilled_mass_time,
              to_char(mass_date, 'YYYY-MM-DD') AS mass_date,
              calendar_event_id, (voided_at IS NOT NULL) AS voided,
              stipend::text AS stipend, requested_by_client_id, intention, requested_by
         FROM ochr_mass_intentions WHERE id = $1 AND organization_id = $2`,
      [id, admin.id]
    )
    expect(intentionDigest(after.rows[0])).toBe(digestAtMark)
    const undone = await request(server).post(`/api/mass-intentions/bulk-mark-said/${marked.body.batch_id}/undo`)
      .set(auth(admin.token)).send({ confirm: true })
    expect(undone.status).toBe(409)
    expect(undone.body.code).toBe('undo_conflict')
    const row = await stored(id)
    expect(row.status).toBe('fulfilled')
    expect(row.fulfilled_mass_date).toBe('2020-10-12')
    expect(row.entered_history).toBe(true)
    const note = await pool.query('SELECT note FROM ochr_mass_intentions WHERE id = $1', [id])
    expect(note.rows[0].note).toBe('Alpha')
    expect((await audits(admin.id, id)).filter(m => m.op === 'undo_mark_said')).toHaveLength(0)
  })

  it('R348-2 does not hash two different field splits as one row', async () => {
    const unit = '\u001f'
    const eventId = await mass(admin.token, '2020-10-13')
    const left = await intention(admin.token, { eventId, text: `A${unit}B ${RUN_ID}` })
    const right = await intention(admin.token, { eventId, text: `A ${RUN_ID}` })
    await pool.query(
      `UPDATE ochr_mass_intentions SET intention = $2, note = $3
        WHERE id = $1 AND organization_id = $4`,
      [left, `A${unit}B`, 'C', admin.id]
    )
    await pool.query(
      `UPDATE ochr_mass_intentions SET intention = $2, note = $3
        WHERE id = $1 AND organization_id = $4`,
      [right, 'A', `B${unit}C`, admin.id]
    )
    const { rows } = await pool.query(
      `SELECT status, note, intention, requested_by, entered_history,
              to_char(mass_date, 'YYYY-MM-DD') AS mass_date,
              to_char(fulfilled_mass_date, 'YYYY-MM-DD') AS fulfilled_mass_date,
              fulfilled_mass_title,
              to_char(fulfilled_mass_time, 'HH24:MI:SS') AS fulfilled_mass_time,
              calendar_event_id, (voided_at IS NOT NULL) AS voided,
              stipend::text AS stipend, requested_by_client_id
         FROM ochr_mass_intentions
        WHERE organization_id = $1 AND id = ANY($2::bigint[])
        ORDER BY id`,
      [admin.id, [left, right]]
    )
    expect(rows).toHaveLength(2)
    const { intentionDigest } = await import('../src/routes/massIntentionMarkSaid.js')
    expect(intentionDigest(rows[0])).not.toBe(intentionDigest(rows[1]))
  })

  it('R348-2 still undoes a marking nothing else has changed', async () => {
    const eventId = await mass(admin.token, '2020-10-14', `Quiet Mass ${RUN_ID}`)
    const id = await intention(admin.token, { eventId, text: `† quiet ${RUN_ID}` })
    const marked = await postMark(staff, [{ id }])
    expect(marked.status).toBe(200)
    const undone = await request(server).post(`/api/mass-intentions/bulk-mark-said/${marked.body.batch_id}/undo`)
      .set(auth(staff)).send({ confirm: true })
    expect(undone.status).toBe(200)
    expect(undone.body.restored).toEqual([{ id }])
    const row = await stored(id)
    expect(row.status).toBe('scheduled')
    expect(row.fulfilled_mass_date).toBeNull()
    expect(row.entered_history).toBe(false)
    expect((await audits(admin.id, id)).filter(m => m.op === 'undo_mark_said')).toHaveLength(1)
  })

  it('R348-3 still deletes a row that was only left out, and keeps a marked row', async () => {
    const loose = await intention(admin.token, { text: `† deletable ${RUN_ID}`, status: 'open', stipend: null })
    const left = await postMark(admin.token, [{ id: loose }])
    expect(left.status).toBe(200)
    expect(left.body.excluded).toEqual([{ id: loose, code: 'needs_date' }])
    const removed = await request(server).delete(`/api/mass-intentions/${loose}`).set(auth(admin.token))
    expect(removed.status).toBe(204)
    const gone = await pool.query(
      'SELECT 1 FROM ochr_mass_intentions WHERE id = $1 AND organization_id = $2',
      [loose, admin.id]
    )
    expect(gone.rows).toHaveLength(0)
    const evidence = await pool.query(
      `SELECT outcome::text AS outcome FROM ochr_mass_intention_mark_batches
        WHERE id = $1 AND organization_id = $2`,
      [left.body.batch_id, admin.id]
    )
    expect(evidence.rows[0].outcome).toContain(String(loose))

    const cancelled = await intention(admin.token, { text: `† cancelled delete ${RUN_ID}`, status: 'cancelled', stipend: null })
    const skipped = await postMark(admin.token, [{ id: cancelled }])
    expect(skipped.body.excluded).toEqual([{ id: cancelled, code: 'cancelled' }])
    const removedCancelled = await request(server).delete(`/api/mass-intentions/${cancelled}`).set(auth(admin.token))
    expect(removedCancelled.status).toBe(204)

    const eventId = await mass(admin.token, '2020-10-15')
    const said = await intention(admin.token, { eventId, text: `† kept ${RUN_ID}` })
    const marked = await postMark(admin.token, [{ id: said }])
    expect(marked.status).toBe(200)
    const refused = await request(server).delete(`/api/mass-intentions/${said}`).set(auth(admin.token))
    expect(refused.status).toBe(409)
    expect((await stored(said)).status).toBe('fulfilled')
    const items = await pool.query(
      `SELECT applied FROM ochr_mass_intention_mark_items
        WHERE organization_id = $1 AND mass_intention_id = $2`,
      [admin.id, said]
    )
    expect(items.rows).toEqual([{ applied: true }])
  })
})

// SP-160 — a Mass that has not happened yet cannot be marked said. Red on
// main (the future rows were marked fulfilled), green with the guard.
describe('SP-160 refuses future and undated rows', () => {
  it('leaves a future-dated Mass, a future typed day, and an undated row unchanged', async () => {
    const futureMass = await mass(admin.token, '2099-06-07', `Future Mass ${RUN_ID}`)
    const onFuture = await intention(admin.token, { eventId: futureMass, text: `† future ${RUN_ID}` })
    const onFutureTypedPast = await intention(admin.token, { eventId: futureMass, text: `† future typed past ${RUN_ID}` })
    const looseFuture = await intention(admin.token, { text: `† loose future ${RUN_ID}` })
    const undated = await intention(admin.token, { text: `† undated ${RUN_ID}` })
    const pastMass = await mass(admin.token, '2020-11-11')
    const good = await intention(admin.token, { eventId: pastMass, text: `† past ok ${RUN_ID}` })
    const res = await postMark(admin.token, [
      { id: onFuture },
      { id: onFutureTypedPast, fulfilled_date: '2020-11-10' },
      { id: looseFuture, fulfilled_date: '2099-01-01' },
      { id: undated },
      { id: good },
    ])
    expect(res.status).toBe(200)
    expect(res.body.marked).toEqual([{ id: good, fulfilled_date: '2020-11-11' }])
    const codes = Object.fromEntries(res.body.excluded.map(e => [e.id, e.code]))
    expect(codes).toEqual({
      [onFuture]: 'future_mass',
      [onFutureTypedPast]: 'future_mass',
      [looseFuture]: 'future_mass',
      [undated]: 'needs_date',
    })
    for (const id of [onFuture, onFutureTypedPast, looseFuture, undated]) {
      const row = await stored(id)
      expect(row.status).not.toBe('fulfilled')
      expect(row.fulfilled_mass_date).toBeNull()
    }
    const rows = (await audits(admin.id, onFuture)).filter(m => m.op === 'mark_said')
    expect(rows).toHaveLength(0)
  })
})
