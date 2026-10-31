// C3 review regressions (Carolina, CAROLINA-423 on #423 head 3de03850).
// Synthetic local data only. One case per finding: H1, H2, M1, M2, M3, L1.
//
// H1  the last-admin guard ignores an admin invite nobody accepted.
// H2  audit rows the person only WROTE keep their metadata; only the actor
//     columns are replaced with the tombstone.
// M1  audit rows ABOUT the person and invited_by_name snapshots of the
//     person are minimized the same way closure does it.
// M2  a queued record-addressed mail (donation receipt) to a member or
//     donor who shares the address is not cancelled.
// M3  the deletion itself writes one audit row, actor = tombstone.
// L1  an audit or telemetry write that lands after the deletion gets the
//     tombstone instead of the deleted id.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'

let server
let ipN = 1
const ip = () => `10.96.${Math.floor(ipN / 200)}.${(ipN++ % 200) + 1}`
const auth = (t) => ({ Authorization: `Bearer ${t}` })
const PW = 'c3-find-pw-123'
const em = (t) => `c3f_${t}_${RUN_ID}@example.com`
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

async function one(sql, params) {
  const { rows } = await pool.query(sql, params)
  return rows[0] || null
}

async function signup(tag) {
  const res = await request(server).post('/api/auth/signup').set('X-Forwarded-For', ip())
    .send({ organizationName: `C3F ${tag} ${RUN_ID}`, name: `Fic Admin ${tag}`, email: em(tag), password: PW })
  expect(res.status).toBe(201)
  return { token: res.body.token, id: res.body.user.id, org: res.body.user.organization.id, email: em(tag), name: `Fic Admin ${tag}` }
}

async function addUser(adm, tag, role) {
  const u = await request(server).post('/api/users').set(auth(adm.token))
    .send({ name: `Fic ${tag}`, email: em(tag), password: PW, role })
  expect(u.status).toBe(201)
  const l = await request(server).post('/api/auth/login').set('X-Forwarded-For', ip())
    .send({ email: em(tag), password: PW })
  expect(l.status).toBe(200)
  return { token: l.body.token, id: u.body.id, org: adm.org, email: em(tag), name: `Fic ${tag}` }
}

async function deleteSelf(u) {
  const r1 = await request(server).post('/api/auth/deletion-request').set(auth(u.token)).set('X-Forwarded-For', ip()).send({})
  const r2 = await request(server).post('/api/auth/deletion-request/confirm').set(auth(u.token)).set('X-Forwarded-For', ip())
    .send({ password: PW })
  return { r1, r2 }
}

// The audit middleware writes after the response. Wait for the row.
async function waitAudit(sql, params) {
  for (let i = 0; i < 50; i++) {
    const row = await one(sql, params)
    if (row) return row
    await new Promise(r => setTimeout(r, 50))
  }
  throw new Error(`audit row never appeared: ${sql}`)
}

async function tombstoneOf(u) {
  const row = await one(
    'SELECT tombstone_id FROM ochr_login_deletion_tombstones WHERE organization_id = $1 AND user_id = $2',
    [u.org, u.id])
  return row?.tombstone_id ?? null
}

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
})

afterAll(async () => {
  await closeServer(server)
  await pool.end()
})

describe('C3 review regressions (CAROLINA-423)', () => {
  it('H1: a pending admin invite does not count as another admin', async () => {
    const solo = await signup('h1')
    const invite = await request(server).post('/api/users/invite').set(auth(solo.token))
      .send({ name: 'Fic Pending Admin', email: em('h1pending'), role: 'admin' })
    expect(invite.status).toBe(201)
    const pending = await one(
      'SELECT role, invited_at, invite_accepted_at FROM ochr_users WHERE id = $1',
      [invite.body.user.id])
    expect(pending.role).toBe('admin')
    expect(pending.invite_accepted_at).toBeNull()

    const before = await one('SELECT email, name, closed_at FROM ochr_users WHERE id = $1', [solo.id])
    const { r1, r2 } = await deleteSelf(solo)
    expect(r1.body.last_active_admin).toBe(true)
    expect(r2.status).toBe(409)
    expect(r2.body.error).toMatch(/Transfer administration first/)
    expect(r2.body.personal_login_deleted).toBe(false)
    expect(await one('SELECT email, name, closed_at FROM ochr_users WHERE id = $1', [solo.id])).toEqual(before)
    expect((await request(server).get('/api/auth/me').set(auth(solo.token))).status).toBe(200)
  })

  it('H2: rows the person only wrote keep their metadata; the actor is tombstoned', async () => {
    const a = await signup('h2')
    const u = await addUser(a, 'h2u', 'admin')
    const jane = await request(server).post('/api/clients').set(auth(u.token))
      .send({ name: 'Fictional Jane Roe', email: em('h2jane') })
    expect(jane.status).toBe(201)
    const cuatro = await request(server).post('/api/users').set(auth(u.token))
      .send({ name: 'Fic Cuatro', email: em('h2cuatro'), password: PW, role: 'staff' })
    expect(cuatro.status).toBe(201)
    const janeRow = await waitAudit(
      `SELECT id, metadata, summary FROM ochr_audit_log
        WHERE organization_id = $1 AND user_id = $2 AND entity_type = 'client'`, [a.org, u.id])
    const cuatroRow = await waitAudit(
      `SELECT id, metadata, summary FROM ochr_audit_log
        WHERE organization_id = $1 AND user_id = $2 AND entity_type = 'user' AND entity_id = $3`,
      [a.org, u.id, String(cuatro.body.id)])
    expect(janeRow.metadata.name).toBe('Fictional Jane Roe')
    expect(cuatroRow.metadata.name).toBe('Fic Cuatro')

    const { r2 } = await deleteSelf(u)
    expect(r2.status).toBe(200)
    const tomb = await tombstoneOf(u)
    expect(tomb).toMatch(UUID)

    const janeAfter = await one(
      'SELECT user_id, user_email, user_name, actor_tombstone_id, metadata, summary FROM ochr_audit_log WHERE id = $1',
      [janeRow.id])
    expect(janeAfter).toMatchObject({ user_id: null, user_email: null, user_name: null, actor_tombstone_id: tomb })
    expect(janeAfter.metadata).toEqual(janeRow.metadata)
    expect(janeAfter.summary).toBe(janeRow.summary)
    const cuatroAfter = await one(
      'SELECT user_id, actor_tombstone_id, metadata, summary FROM ochr_audit_log WHERE id = $1',
      [cuatroRow.id])
    expect(cuatroAfter).toMatchObject({ user_id: null, actor_tombstone_id: tomb })
    expect(cuatroAfter.metadata).toEqual(cuatroRow.metadata)
    expect(cuatroAfter.summary).toBe(cuatroRow.summary)
  })

  it('M1: copies about the person (audit subject rows, invited_by_name) are minimized', async () => {
    const a = await signup('m1')
    const u = await addUser(a, 'm1u', 'admin')
    const created = await waitAudit(
      `SELECT id, user_id, summary, metadata FROM ochr_audit_log
        WHERE organization_id = $1 AND user_id = $2 AND entity_type = 'user' AND entity_id = $3`,
      [a.org, a.id, String(u.id)])
    expect(created.summary).toBe(`Created user: ${u.name}`)
    expect(created.metadata.email).toBe(u.email)

    const inv = await request(server).post('/api/users/invite').set(auth(u.token))
      .send({ name: 'Fic Invitee', email: em('m1inv'), role: 'staff' })
    expect(inv.status).toBe(201)
    expect((await one('SELECT invited_by_name FROM ochr_users WHERE id = $1', [inv.body.user.id])).invited_by_name).toBe(u.name)
    // Somebody else's invite with a different inviter name is not touched.
    const invA = await request(server).post('/api/users/invite').set(auth(a.token))
      .send({ name: 'Fic Invitee A', email: em('m1invA'), role: 'staff' })
    expect(invA.status).toBe(201)

    const { r2 } = await deleteSelf(u)
    expect(r2.status).toBe(200)

    const after = await one('SELECT user_id, summary, metadata FROM ochr_audit_log WHERE id = $1', [created.id])
    expect(after.user_id).toBe(a.id)
    expect(after.summary).toBe(`Created user #${u.id}`)
    expect(after.metadata.name).toBeUndefined()
    expect(after.metadata.email).toBeUndefined()
    expect(after.metadata.role).toBe('admin')
    expect((await one('SELECT invited_by_name FROM ochr_users WHERE id = $1', [inv.body.user.id])).invited_by_name).toBeNull()
    expect((await one('SELECT invited_by_name FROM ochr_users WHERE id = $1', [invA.body.user.id])).invited_by_name).toBe(a.name)
  })

  it('M2: a queued donation receipt to a member sharing the address is not cancelled', async () => {
    const a = await signup('m2')
    const u = await addUser(a, 'm2u', 'staff')
    const { rows } = await pool.query(
      `INSERT INTO ochr_scheduled_notifications
         (organization_id, user_id, recipient_email, notification_type, send_at)
       VALUES ($1, NULL, $2, 'donation_receipt', NOW() + INTERVAL '1 day'),
              ($1, NULL, $2, 'task_due_reminder', NOW() + INTERVAL '1 day'),
              ($1, $3, $2, 'task_due_reminder', NOW() + INTERVAL '1 day')
       RETURNING id, notification_type, user_id`,
      [a.org, u.email, u.id])
    const { r2 } = await deleteSelf(u)
    expect(r2.status).toBe(200)
    const status = async (id) => (await one('SELECT status FROM ochr_scheduled_notifications WHERE id = $1', [id])).status
    expect(await status(rows[0].id)).toBe('pending')
    expect(await status(rows[1].id)).toBe('cancelled')
    expect(await status(rows[2].id)).toBe('cancelled')
  })

  it('M3: the deletion writes its own audit row with the tombstone as actor', async () => {
    const a = await signup('m3')
    const u = await addUser(a, 'm3u', 'staff')
    const before = await one(
      `SELECT COUNT(*)::int AS n FROM ochr_audit_log
        WHERE organization_id = $1 AND entity_type = 'user' AND entity_id = $2`, [a.org, String(u.id)])
    const { r2 } = await deleteSelf(u)
    expect(r2.status).toBe(200)
    const tomb = await tombstoneOf(u)
    const { rows } = await pool.query(
      `SELECT user_id, user_email, user_name, actor_tombstone_id, action, summary, metadata
         FROM ochr_audit_log
        WHERE organization_id = $1 AND entity_type = 'user' AND entity_id = $2 AND action = 'delete'`,
      [a.org, String(u.id)])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      user_id: null, user_email: null, user_name: null, actor_tombstone_id: tomb,
      summary: `Deleted own login #${u.id}`,
    })
    expect(rows[0].metadata).toEqual({ via: 'self_serve_deletion' })
    const after = await one(
      `SELECT COUNT(*)::int AS n FROM ochr_audit_log
        WHERE organization_id = $1 AND entity_type = 'user' AND entity_id = $2`, [a.org, String(u.id)])
    expect(after.n).toBe(before.n + 1)
    // A second confirm with the old token is refused and writes nothing.
    const again = await request(server).post('/api/auth/deletion-request/confirm').set(auth(u.token)).send({ password: PW })
    expect(again.status).toBe(401)
    expect((await one(
      `SELECT COUNT(*)::int AS n FROM ochr_audit_log
        WHERE organization_id = $1 AND entity_type = 'user' AND entity_id = $2`, [a.org, String(u.id)])).n).toBe(after.n)
  })

  it('L1: a write that lands after the deletion carries the tombstone, not the id', async () => {
    const a = await signup('l1')
    const u = await addUser(a, 'l1u', 'staff')
    const { r2 } = await deleteSelf(u)
    expect(r2.status).toBe(200)
    const tomb = await tombstoneOf(u)

    const late = await one(
      `INSERT INTO ochr_audit_log
         (organization_id, user_id, user_email, user_name, action, entity_type, summary, metadata)
       VALUES ($1, $2, $3, $4, 'update', 'client', 'late write', '{"note":"kept"}'::jsonb)
       RETURNING user_id, user_email, user_name, actor_tombstone_id, metadata`,
      [a.org, u.id, u.email, u.name])
    expect(late).toEqual({ user_id: null, user_email: null, user_name: null, actor_tombstone_id: tomb, metadata: { note: 'kept' } })
    const usage = await one(
      `INSERT INTO ochr_ai_usage (organization_id, endpoint, user_id) VALUES ($1, 'generate', $2)
       RETURNING user_id, actor_tombstone_id`, [a.org, u.id])
    expect(usage).toEqual({ user_id: null, actor_tombstone_id: tomb })
    const ai = await one(
      `INSERT INTO ochr_ai_audit (application, environment, organization_id, actor_id, request_id, event)
       VALUES ('openchurch', 'test', $1, $2, $3, 'succeeded')
       RETURNING actor_id, actor_tombstone_id`, [a.org, u.id, `c3f-l1-${RUN_ID}`])
    expect(ai).toEqual({ actor_id: null, actor_tombstone_id: tomb })

    // A live login is untouched by the same trigger.
    const live = await one(
      `INSERT INTO ochr_audit_log (organization_id, user_id, user_email, user_name, action, entity_type, summary)
       VALUES ($1, $2, $3, $4, 'update', 'client', 'live write')
       RETURNING user_id, actor_tombstone_id`, [a.org, a.id, a.email, a.name])
    expect(live).toEqual({ user_id: a.id, actor_tombstone_id: null })
  })

  it('L1: an insert in flight while the deletion is open waits and then gets the tombstone', async () => {
    const a = await signup('l1b')
    const u = await addUser(a, 'l1bu', 'staff')
    const holder = await pool.connect()
    const writer = await pool.connect()
    try {
      // Stand-in for an open deletion transaction: the login row locked
      // FOR UPDATE and the tombstone inserted, not yet committed.
      await holder.query('BEGIN')
      await holder.query('SELECT id FROM ochr_users WHERE id = $1 FOR UPDATE', [u.id])
      const { rows: [t] } = await holder.query(
        `INSERT INTO ochr_login_deletion_tombstones (organization_id, user_id, tombstone_id)
         VALUES ($1, $2, gen_random_uuid()) RETURNING tombstone_id`, [a.org, u.id])
      const pending = writer.query(
        `INSERT INTO ochr_audit_log (organization_id, user_id, user_email, user_name, action, entity_type, summary)
         VALUES ($1, $2, $3, $4, 'update', 'client', 'in-flight write')
         RETURNING user_id, user_email, actor_tombstone_id`, [a.org, u.id, u.email, u.name])
      await new Promise(r => setTimeout(r, 300))
      await holder.query('COMMIT')
      const { rows: [row] } = await pending
      expect(row).toEqual({ user_id: null, user_email: null, actor_tombstone_id: t.tombstone_id })
    } finally {
      await holder.query('ROLLBACK').catch(() => {})
      holder.release()
      writer.release()
    }
  })
})
