// F-06 (Carolina via ARGUS B2): closure cancels the closed login's queued
// mail, and the birthday / sacrament-anniversary digests never pick a
// closed or deactivated admin as a recipient. Local synthetic data only.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { scheduleNotification, processDueNotifications } from '../src/notifications/scheduler.js'
import { parishAdmins } from '../src/services/recurringGifts.js'
import { enqueueDailyBirthdayReminders } from '../src/notifications/birthdays.js'
import { enqueueSacramentAnniversaryDigests } from '../src/notifications/sacramentAnniversaries.js'

let server, token, orgId
const people = {}
const auth = (t) => ({ Authorization: `Bearer ${t}` })
const pad = n => String(n).padStart(2, '0')

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  const res = await request(server).post('/api/auth/signup').set('X-Forwarded-For', '10.92.1.1')
    .send({ organizationName: `F06 ${RUN_ID}`, name: 'Active Admin', email: `f06_a_${RUN_ID}@example.com`, password: 'f06-test-pw' })
  expect(res.status).toBe(201)
  token = res.body.token
  orgId = res.body.user.organization.id
  people.active = res.body.user.id
  for (const tag of ['closed', 'deact']) {
    const u = await request(server).post('/api/users').set(auth(token))
      .send({ name: `Admin ${tag}`, email: `f06_${tag}_${RUN_ID}@example.com`, password: 'f06-test-pw', role: 'admin' })
    expect(u.status).toBe(201)
    people[tag] = u.body.id
  }
  expect((await request(server).post(`/api/users/${people.deact}/deactivate`).set(auth(token))).status).toBe(200)
}, 60_000)

afterAll(async () => {
  await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [orgId]).catch(() => {})
  await closeServer(server)
  await pool.end()
})

describe('F-06 closure and digests', () => {
  it('closing a login cancels its pending scheduled notifications (by id and by address)', async () => {
    const closedEmail = `f06_closed_${RUN_ID}@example.com`
    const future = new Date(Date.now() + 3600_000)
    const byId = await scheduleNotification({ organizationId: orgId, userId: people.closed, recipient: closedEmail,
      notification_type: 'member_birthday', vars: { member_name: 'X' }, sendAt: future })
    // Future, like the others: closure cancels pending rows regardless of
    // send time, and a past-due row here is claimable by any other test
    // file's global drain running in parallel.
    const byAddr = await scheduleNotification({ organizationId: orgId, userId: null, recipient: closedEmail.toUpperCase(),
      notification_type: 'member_birthday', vars: { member_name: 'Y' }, sendAt: future })
    const other = await scheduleNotification({ organizationId: orgId, userId: people.active, recipient: `f06_a_${RUN_ID}@example.com`,
      notification_type: 'member_birthday', vars: { member_name: 'Z' }, sendAt: future })

    const closed = await request(server).post(`/api/users/${people.closed}/close`).set(auth(token))
    expect(closed.status).toBe(200)

    const { rows } = await pool.query(
      'SELECT id, status FROM ochr_scheduled_notifications WHERE id = ANY($1) ORDER BY id',
      [[byId.id, byAddr.id, other.id]])
    const st = Object.fromEntries(rows.map(r => [r.id, r.status]))
    expect(st[byId.id]).toBe('cancelled')
    expect(st[byAddr.id]).toBe('cancelled')
    expect(st[other.id]).toBe('pending')
  })

  it('the birthday digest skips closed and deactivated admins', async () => {
    const now = new Date(); now.setHours(12, 0, 0, 0); now.setDate(now.getDate() + 200)
    const t = new Date(now); t.setDate(t.getDate() + 1)
    if (t.getMonth() === 1 && t.getDate() === 29) { now.setDate(now.getDate() + 1); t.setDate(t.getDate() + 1) }
    await pool.query(
      `INSERT INTO ochr_clients (organization_id, name, birth_date) VALUES ($1, $2, $3)`,
      [orgId, `F06 Bday ${RUN_ID}`, `1990-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`])
    await enqueueDailyBirthdayReminders({ now })
    const { rows } = await pool.query(
      `SELECT DISTINCT user_id FROM ochr_scheduled_notifications
        WHERE organization_id = $1 AND notification_type = 'member_birthday' AND status = 'pending'
          AND vars->>'member_name' = $2`,
      [orgId, `F06 Bday ${RUN_ID}`])
    const ids = rows.map(r => r.user_id)
    expect(ids).toContain(people.active)
    expect(ids).not.toContain(people.closed)
    expect(ids).not.toContain(people.deact)
  })

  it('the sacrament anniversary digest skips closed and deactivated admins', async () => {
    const now = new Date(); now.setHours(0, 0, 0, 0); now.setDate(now.getDate() + 200)
    const d = new Date(now); d.setDate(d.getDate() + 2)
    if (d.getMonth() === 1 && d.getDate() === 29) d.setDate(d.getDate() + 1)
    const member = await request(server).post('/api/clients').set(auth(token)).send({ name: `F06 Sac ${RUN_ID}` })
    expect(member.status).toBe(201)
    const rec = await request(server).post('/api/sacraments').set(auth(token))
      .send({ client_id: member.body.id, type: 'confirmation', date: `${d.getFullYear() - 5}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` })
    expect(rec.status).toBe(201)
    await enqueueSacramentAnniversaryDigests({ now })
    const { rows } = await pool.query(
      `SELECT user_id FROM ochr_scheduled_notifications
        WHERE organization_id = $1 AND notification_type = 'sacrament_anniversary_digest'`,
      [orgId])
    const ids = rows.map(r => r.user_id)
    expect(ids).toContain(people.active)
    expect(ids).not.toContain(people.closed)
    expect(ids).not.toContain(people.deact)
  })

  it('deactivating a login cancels its pending notifications (ARG-PATCH-2-1)', async () => {
    const u = await request(server).post('/api/users').set(auth(token))
      .send({ name: 'Admin deact2', email: `f06_deact2_${RUN_ID}@example.com`, password: 'f06-test-pw', role: 'admin' })
    expect(u.status).toBe(201)
    const row = await scheduleNotification({ organizationId: orgId, userId: u.body.id, recipient: `f06_deact2_${RUN_ID}@example.com`,
      notification_type: 'member_birthday', vars: { member_name: 'D2' }, sendAt: new Date(Date.now() + 3600_000) })
    expect((await request(server).post(`/api/users/${u.body.id}/deactivate`).set(auth(token))).status).toBe(200)
    const { rows: [r] } = await pool.query('SELECT status FROM ochr_scheduled_notifications WHERE id = $1', [row.id])
    expect(r.status).toBe('cancelled')
  })

  it('the dispatcher refuses due rows for closed/deactivated recipients, by id or by address', async () => {
    const past = new Date(Date.now() - 60_000)
    const deactEmail = `f06_deact_${RUN_ID}@example.com`
    // Queued AFTER the state change (bypassing the up-front cancel), so only
    // the dispatcher backstop can stop them.
    const byId = await scheduleNotification({ organizationId: orgId, userId: people.deact, recipient: deactEmail,
      notification_type: 'member_birthday', vars: { member_name: 'PII-1' }, sendAt: past })
    const byAddr = await scheduleNotification({ organizationId: orgId, userId: null, recipient: deactEmail.toUpperCase(),
      notification_type: 'member_birthday', vars: { member_name: 'PII-2' }, sendAt: past })
    const closedId = await scheduleNotification({ organizationId: orgId, userId: people.closed, recipient: `closed-user-${people.closed}@login-closed.invalid`,
      notification_type: 'member_birthday', vars: { member_name: 'PII-3' }, sendAt: past })
    const ok = await scheduleNotification({ organizationId: orgId, userId: people.active, recipient: `f06_a_${RUN_ID}@example.com`,
      notification_type: 'member_birthday', vars: { member_name: 'OK' }, sendAt: past })
    await processDueNotifications({ batchSize: 500 })
    const { rows } = await pool.query('SELECT id, status FROM ochr_scheduled_notifications WHERE id = ANY($1)',
      [[byId.id, byAddr.id, closedId.id, ok.id]])
    const st = Object.fromEntries(rows.map(r => [r.id, r.status]))
    expect(st[byId.id]).toBe('cancelled')
    expect(st[byAddr.id]).toBe('cancelled')
    expect(st[closedId.id]).toBe('cancelled')
    expect(['sent', 'failed']).toContain(st[ok.id]) // claimed and attempted, not cancelled
  })

  it('recurring-gift stop notices skip closed and deactivated admins (ARG-PATCH-2-2)', async () => {
    const ids = (await parishAdmins(orgId)).map(r => r.id)
    expect(ids).toContain(people.active)
    expect(ids).not.toContain(people.closed)
    expect(ids).not.toContain(people.deact)
  })
})
