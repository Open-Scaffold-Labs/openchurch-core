// CHK-05 — a Mass with historical check-ins cannot be destructively deleted.
//
// THE ATTACK THIS CLOSES. T0 deletion eligibility is a COUNT of check-ins.
// T1 a concurrent check-in lands. T2 the delete proceeds. With ON DELETE
// CASCADE still in place (the gate does not rewrite that FK), an unlocked
// COUNT-then-DELETE wipes the new row and Continuity Vault never saw it.
// The gate locks the disappearing event set FOR UPDATE, then recounts, then
// deletes. A concurrent INSERT takes KEY SHARE on the event and waits.
//
// WHAT WOULD MAKE THESE FAIL
//   - Commenting out refuseEventIfAttendance in vault/index.js (attended
//     DELETE becomes 204 and CASCADE wipes the check-ins).
//   - Counting only the named id, not the seed-cascade siblings.
//   - Returning 204 when attendance exists, or 409 without counts.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import pg from 'pg'
import 'dotenv/config'

import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'

let server
const cleanupOrgIds = []
let ipSeq = 0
const auth = t => ({ Authorization: `Bearer ${t}` })

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
}, 60_000)

afterAll(async () => {
  for (const id of cleanupOrgIds) {
    await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
  }
  await closeServer(server)
  await pool.end()
})

async function parish(tag) {
  const res = await createOrg(server, {
    organizationName: `CHK05 ${tag} ${RUN_ID}`, name: 'Admin',
    email: `chk05_${tag}_${RUN_ID}@example.com`, password: 'chk05-verify-pw-1',
  }, `10.66.5.${++ipSeq}`)
  expect(res.status).toBe(201)
  cleanupOrgIds.push(res.body.user.organization.id)
  return { token: res.body.token, orgId: res.body.user.organization.id }
}

const makeMass = (token, title, date) => request(server).post('/api/calendar').set(auth(token))
  .send({ title, date, start_time: '10:30', end_time: '11:45', type: 'service' })

async function checkin(token, eventId, body = {}) {
  const res = await request(server).post('/api/checkins').set(auth(token))
    .send({ calendar_event_id: eventId, person_name: body.person_name || `Guest ${RUN_ID}`, kind: body.kind || 'guest', ...body })
  expect([200, 201]).toContain(res.status)
  return res.body
}

describe('CHK-05 — refuse destructive Mass delete when check-ins exist', () => {
  it('a Mass with check-ins is 409 with counts; the service and the rows stay', async () => {
    const { token, orgId } = await parish('refuse')
    const mass = await makeMass(token, `Sunday Mass ${RUN_ID}`, '2032-01-04')
    expect(mass.status).toBe(201)
    await checkin(token, mass.body.id, { person_name: `A ${RUN_ID}` })
    await checkin(token, mass.body.id, { person_name: `B ${RUN_ID}` })

    const del = await request(server).delete(`/api/calendar/${mass.body.id}`).set(auth(token))
    expect(del.status).toBe(409)
    expect(del.body.code).toBe('has_attendance')
    expect(del.body.checkin_count).toBe(2)
    expect(del.body.attendance).toBe(2)
    expect(del.body.events_with_attendance).toBe(1)
    expect(del.body.error).toMatch(/2 people were checked in/i)
    expect(del.body.error).toMatch(/not erased/i)

    const ev = await pool.query(
      'SELECT 1 FROM ochr_calendar_events WHERE id = $1 AND organization_id = $2',
      [mass.body.id, orgId])
    expect(ev.rowCount).toBe(1)
    const ci = await pool.query(
      'SELECT COUNT(*)::int AS n FROM ochr_checkins WHERE calendar_event_id = $1 AND organization_id = $2',
      [mass.body.id, orgId])
    expect(ci.rows[0].n).toBe(2)
    const vault = await pool.query(
      `SELECT 1 FROM ochr_vault_entries WHERE organization_id = $1 AND kind = 'event' AND entity_id = $2`,
      [orgId, String(mass.body.id)])
    expect(vault.rowCount).toBe(0)
  })

  it('a checked-out historical check-in still blocks the delete', async () => {
    const { token, orgId } = await parish('historical')
    const mass = await makeMass(token, `Vigil ${RUN_ID}`, '2032-01-11')
    const row = await checkin(token, mass.body.id)
    const out = await request(server).post(`/api/checkins/${row.id}/checkout`).set(auth(token)).send({})
    expect(out.status).toBe(200)

    const del = await request(server).delete(`/api/calendar/${mass.body.id}`).set(auth(token))
    expect(del.status).toBe(409)
    expect(del.body.checkin_count).toBe(1)
    expect(del.body.attendance).toBe(1)
    const ev = await pool.query('SELECT 1 FROM ochr_calendar_events WHERE id = $1 AND organization_id = $2',
      [mass.body.id, orgId])
    expect(ev.rowCount).toBe(1)
  })

  it('a checkout-and-return is one person and two rows in the 409', async () => {
    const { token, orgId } = await parish('return')
    const member = await pool.query(
      `INSERT INTO ochr_clients (organization_id, name) VALUES ($1, $2) RETURNING id`,
      [orgId, `Alma ${RUN_ID}`])
    const mass = await makeMass(token, `Return Mass ${RUN_ID}`, '2032-01-12')
    const first = await request(server).post('/api/checkins').set(auth(token))
      .send({ calendar_event_id: mass.body.id, client_id: member.rows[0].id })
    expect([200, 201]).toContain(first.status)
    await request(server).post(`/api/checkins/${first.body.id}/checkout`).set(auth(token)).send({})
    const second = await request(server).post('/api/checkins').set(auth(token))
      .send({ calendar_event_id: mass.body.id, client_id: member.rows[0].id })
    expect([200, 201]).toContain(second.status)

    const del = await request(server).delete(`/api/calendar/${mass.body.id}`).set(auth(token))
    expect(del.status).toBe(409)
    expect(del.body.checkin_count).toBe(2)
    expect(del.body.attendance).toBe(1)
    expect(del.body.error).toMatch(/One person was checked in/i)
  })

  it('a Mass with no check-ins still hard-deletes through the vault', async () => {
    const { token, orgId } = await parish('empty')
    const mass = await makeMass(token, `Empty Mass ${RUN_ID}`, '2032-01-18')
    expect(mass.status).toBe(201)

    const del = await request(server).delete(`/api/calendar/${mass.body.id}`).set(auth(token))
    expect(del.status).toBe(204)
    const ev = await pool.query('SELECT 1 FROM ochr_calendar_events WHERE id = $1', [mass.body.id])
    expect(ev.rowCount).toBe(0)
    const vault = await pool.query(
      `SELECT 1 FROM ochr_vault_entries WHERE organization_id = $1 AND kind = 'event' AND entity_id = $2`,
      [orgId, String(mass.body.id)])
    expect(vault.rowCount).toBe(1)
  })

  it('removing the check-in then deleting the Mass is 204', async () => {
    const { token } = await parish('then-empty')
    const mass = await makeMass(token, `Then empty ${RUN_ID}`, '2032-01-25')
    const row = await checkin(token, mass.body.id)
    const blocked = await request(server).delete(`/api/calendar/${mass.body.id}`).set(auth(token))
    expect(blocked.status).toBe(409)
    const gone = await request(server).delete(`/api/checkins/${row.id}`).set(auth(token))
    expect(gone.status).toBe(204)
    const del = await request(server).delete(`/api/calendar/${mass.body.id}`).set(auth(token))
    expect(del.status).toBe(204)
  })

  it('does not detach check-ins (SET NULL) as a prelude to delete', async () => {
    const { token, orgId } = await parish('no-detach')
    const mass = await makeMass(token, `No detach ${RUN_ID}`, '2032-01-26')
    const row = await checkin(token, mass.body.id)
    await request(server).delete(`/api/calendar/${mass.body.id}`).set(auth(token))
    const still = await pool.query(
      'SELECT calendar_event_id FROM ochr_checkins WHERE id = $1 AND organization_id = $2',
      [row.id, orgId])
    expect(still.rowCount).toBe(1)
    expect(Number(still.rows[0].calendar_event_id)).toBe(Number(mass.body.id))
  })
})

describe('CHK-05 — series and seed cascade set', () => {
  async function series(token) {
    const made = await request(server).post('/api/calendar').set(auth(token))
      .send({
        title: `Choir ${RUN_ID}`, date: '2032-02-02',
        start_time: '19:00', end_time: '20:30', type: 'service',
        recurrence: { freq: 'weekly', interval: 1, count: 4 },
      })
    expect(made.status).toBeLessThan(300)
    const seedId = made.body.id ?? made.body.event?.id
    const all = await pool.query(
      `SELECT id FROM ochr_calendar_events
        WHERE recurrence_parent_id = $1 ORDER BY date`, [seedId])
    expect(all.rows).toHaveLength(4)
    return { seedId, ids: all.rows.map(r => r.id) }
  }

  it('a check-in on a later occurrence blocks deleting the seed', async () => {
    const { token, orgId } = await parish('seed')
    const { seedId, ids } = await series(token)
    await checkin(token, ids[2], { person_name: `Series guest ${RUN_ID}` })

    const del = await request(server).delete(`/api/calendar/${seedId}`).set(auth(token))
    expect(del.status).toBe(409)
    expect(del.body.code).toBe('has_attendance')
    expect(del.body.checkin_count).toBe(1)
    expect(del.body.events_with_attendance).toBe(1)

    const left = await pool.query(
      'SELECT COUNT(*)::int AS n FROM ochr_calendar_events WHERE id = ANY($1::int[]) AND organization_id = $2',
      [ids, orgId])
    expect(left.rows[0].n).toBe(4)
    const ci = await pool.query(
      'SELECT COUNT(*)::int AS n FROM ochr_checkins WHERE calendar_event_id = ANY($1::int[]) AND organization_id = $2',
      [ids, orgId])
    expect(ci.rows[0].n).toBe(1)
  })

  it('scope=series also refuses when any occurrence has attendance', async () => {
    const { token, orgId } = await parish('series')
    const { ids } = await series(token)
    await checkin(token, ids[1], { person_name: `Tuesday ${RUN_ID}` })

    const del = await request(server)
      .delete(`/api/calendar/${ids[1]}?scope=series`).set(auth(token))
    expect(del.status).toBe(409)
    expect(del.body.checkin_count).toBe(1)
    const left = await pool.query(
      'SELECT COUNT(*)::int AS n FROM ochr_calendar_events WHERE id = ANY($1::int[]) AND organization_id = $2',
      [ids, orgId])
    expect(left.rows[0].n).toBe(4)
  })
})

describe('CHK-05 — lock-then-recheck closes the COUNT-then-DELETE race', () => {
  function secondClient() {
    return new pg.Client({ connectionString: process.env.DATABASE_URL })
  }

  // The INSERT is issued while A holds FOR UPDATE, so it sits on KEY SHARE
  // until A COMMITs the Mass delete. Postgres then rejects it with 23503 —
  // that is the expected outcome. If the rejection lands in the gap between
  // COMMIT and the later `expect(...).rejects`, Node treats it as
  // unhandledRejection and CI fails the file. Attach the handler in the
  // same tick as the query.
  function raceInsert(client, sql, params) {
    return client.query(sql, params).then(
      () => {
        throw new Error('expected racing INSERT to fail with FK 23503 after the Mass delete committed')
      },
      (err) => err,
    )
  }

  it('T0 lock+count=0, T1 check-in waits, T2 delete — the insert cannot CASCADE-wipe a committed row', async () => {
    // The vault's protocol, forced at SQL so the interleaving is not a
    // hope. Session A locks the event (FOR UPDATE), sees zero check-ins,
    // then deletes. Session B's INSERT needs KEY SHARE on that row and
    // cannot commit in the gap. After A commits, B fails because the
    // Mass is gone. Nothing committed was wiped.
    const { token, orgId } = await parish('race')
    const mass = await makeMass(token, `Race Mass ${RUN_ID}`, '2032-03-07')
    const eventId = mass.body.id

    const a = await pool.connect()
    const b = secondClient()
    await b.connect()
    let insert = null
    try {
      await a.query('BEGIN')
      await a.query(
        `SELECT id FROM ochr_calendar_events
          WHERE organization_id = $2
            AND (id = $1 OR recurrence_parent_id = $1)
          ORDER BY id FOR UPDATE`,
        [eventId, orgId])
      const counted = await a.query(
        'SELECT COUNT(*)::int AS n FROM ochr_checkins WHERE calendar_event_id = $1 AND organization_id = $2',
        [eventId, orgId])
      expect(counted.rows[0].n).toBe(0)

      insert = raceInsert(b,
        `INSERT INTO ochr_checkins (organization_id, calendar_event_id, person_name, kind)
         VALUES ($1, $2, $3, 'guest') RETURNING id`,
        [orgId, eventId, `Race guest ${RUN_ID}`])
      await new Promise(r => setTimeout(r, 75))

      await a.query(
        'DELETE FROM ochr_calendar_events WHERE id = $1 AND organization_id = $2',
        [eventId, orgId])
      await a.query('COMMIT')
    } finally {
      a.release()
    }

    await expect(insert).resolves.toMatchObject({ code: '23503' })
    await b.end()

    const ev = await pool.query('SELECT 1 FROM ochr_calendar_events WHERE id = $1', [eventId])
    expect(ev.rowCount).toBe(0)
    const ci = await pool.query(
      'SELECT COUNT(*)::int AS n FROM ochr_checkins WHERE calendar_event_id = $1', [eventId])
    expect(ci.rows[0].n).toBe(0)
  })

  it('T0 lock the seed, T1 check-in on a sibling waits, T2 seed delete cannot wipe it', async () => {
    const { token, orgId } = await parish('seed-race')
    const made = await request(server).post('/api/calendar').set(auth(token))
      .send({
        title: `Seed race ${RUN_ID}`, date: '2032-03-14',
        start_time: '09:00', end_time: '10:00', type: 'service',
        recurrence: { freq: 'weekly', interval: 1, count: 3 },
      })
    const seedId = made.body.id
    const all = await pool.query(
      `SELECT id FROM ochr_calendar_events
        WHERE recurrence_parent_id = $1 AND organization_id = $2 ORDER BY date`,
      [seedId, orgId])
    const siblingId = all.rows[all.rows.length - 1].id
    expect(siblingId).not.toBe(seedId)

    const a = await pool.connect()
    const b = secondClient()
    await b.connect()
    let insert = null
    try {
      await a.query('BEGIN')
      await a.query(
        `SELECT id FROM ochr_calendar_events
          WHERE organization_id = $2
            AND (id = $1 OR recurrence_parent_id = $1)
          ORDER BY id FOR UPDATE`,
        [seedId, orgId])
      const counted = await a.query(
        `SELECT COUNT(*)::int AS n FROM ochr_checkins
          WHERE organization_id = $2 AND calendar_event_id = ANY($1::int[])`,
        [all.rows.map(r => r.id), orgId])
      expect(counted.rows[0].n).toBe(0)

      insert = raceInsert(b,
        `INSERT INTO ochr_checkins (organization_id, calendar_event_id, person_name, kind)
         VALUES ($1, $2, $3, 'guest') RETURNING id`,
        [orgId, siblingId, `Sibling race ${RUN_ID}`])
      await new Promise(r => setTimeout(r, 75))

      await a.query(
        'DELETE FROM ochr_calendar_events WHERE id = $1 AND organization_id = $2',
        [seedId, orgId])
      await a.query('COMMIT')
    } finally {
      a.release()
    }

    await expect(insert).resolves.toMatchObject({ code: '23503' })
    await b.end()

    const left = await pool.query(
      'SELECT COUNT(*)::int AS n FROM ochr_calendar_events WHERE recurrence_parent_id = $1 AND organization_id = $2',
      [seedId, orgId])
    expect(left.rows[0].n).toBe(0)
    const ci = await pool.query(
      'SELECT COUNT(*)::int AS n FROM ochr_checkins WHERE calendar_event_id = $1', [siblingId])
    expect(ci.rows[0].n).toBe(0)
  })

  it('a check-in that commits before the lock makes HTTP delete 409 and keeps the row', async () => {
    const { token, orgId } = await parish('lock-after')
    const mass = await makeMass(token, `Lock after ${RUN_ID}`, '2032-03-21')
    await checkin(token, mass.body.id, { person_name: `Before lock ${RUN_ID}` })

    const del = await request(server).delete(`/api/calendar/${mass.body.id}`).set(auth(token))
    expect(del.status).toBe(409)
    const still = await pool.query(
      'SELECT COUNT(*)::int AS n FROM ochr_checkins WHERE calendar_event_id = $1 AND organization_id = $2',
      [mass.body.id, orgId])
    expect(still.rows[0].n).toBe(1)
  })

  it('concurrent HTTP check-in and delete never destroy a successful check-in', async () => {
    const { token, orgId } = await parish('http-race')
    const mass = await makeMass(token, `HTTP race ${RUN_ID}`, '2032-03-28')
    const eventId = mass.body.id

    const [del, ci] = await Promise.all([
      request(server).delete(`/api/calendar/${eventId}`).set(auth(token)),
      request(server).post('/api/checkins').set(auth(token))
        .send({ calendar_event_id: eventId, person_name: `HTTP guest ${RUN_ID}`, kind: 'guest' }),
    ])

    const still = await pool.query(
      'SELECT COUNT(*)::int AS n FROM ochr_checkins WHERE calendar_event_id = $1 AND organization_id = $2',
      [eventId, orgId])
    const ev = await pool.query(
      'SELECT COUNT(*)::int AS n FROM ochr_calendar_events WHERE id = $1 AND organization_id = $2',
      [eventId, orgId])

    if (ci.status === 201 || ci.status === 200) {
      expect(still.rows[0].n).toBeGreaterThan(0)
      expect(ev.rows[0].n).toBe(1)
      expect(del.status).toBe(409)
    } else {
      expect(del.status).toBe(204)
      expect(still.rows[0].n).toBe(0)
      expect(ev.rows[0].n).toBe(0)
    }
  })
})
