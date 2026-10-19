// PR6 follow-ups to Carolina's #293 review (F1, F3, F4 + test gaps).
// F1: closed-address suppression applies to login-addressed mail only; a
// member or donor record sharing a closed staff login's former address still
// gets its mail (main 57ffcb92 delivered it; closure is not member removal).
// Real transport, stub provider. Local synthetic data only.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'
import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { scheduleNotification, processDueNotifications } from '../src/notifications/scheduler.js'
import { notify, RECORD_ADDRESSED_TYPES, LOGIN_ADDRESSED_TYPES, REFUSAL_REASONS } from '../src/notifications/transport.js'
import { TEMPLATES } from '../src/notifications/templates.js'

let server, token, orgId
const auth = () => ({ Authorization: `Bearer ${token}` })
const R = RUN_ID.replace(/[^a-z0-9]/gi, '').toLowerCase()
const past = () => new Date(Date.now() - 60_000)
const em = (t) => `f1_${t}_${R}@example.com`
const addUser = async (email) => {
  const u = await request(server).post('/api/users').set(auth()).send({ name: 'U', email, password: 'f1-test-pw', role: 'staff' })
  expect(u.status).toBe(201); return u.body.id
}
const close = async (id) => expect((await request(server).post(`/api/users/${id}/close`).set(auth())).status).toBe(200)
const supp = async () => (await pool.query(
  'SELECT email_sha256, closed_at FROM ochr_closed_address_suppressions WHERE organization_id = $1 ORDER BY closed_at', [orgId])).rows
const send = (recipient, notification_type) => notify({ organizationId: orgId, recipient, notification_type, vars: {} })

beforeAll(async () => {
  delete process.env.RESEND_API_KEY
  await migrateOnce(); server = await bindServer()
  const res = await request(server).post('/api/auth/signup').set('X-Forwarded-For', '10.94.1.1')
    .send({ organizationName: `F1 ${R}`, name: 'Admin', email: em('admin'), password: 'f1-test-pw' })
  expect(res.status).toBe(201)
  token = res.body.token; orgId = res.body.user.organization.id
}, 60_000)
afterAll(async () => {
  await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [orgId]).catch(() => {})
  await closeServer(server); await pool.end()
})

describe('F1: suppression is scoped to login-addressed mail', () => {
  it('every template type is classified exactly once', () => {
    for (const t of Object.keys(TEMPLATES)) {
      expect(RECORD_ADDRESSED_TYPES.has(t) !== LOGIN_ADDRESSED_TYPES.has(t), t).toBe(true)
    }
  })
  it('a donor receipt to an address shared with a closed staff login is delivered', async () => {
    const a = em('donor'); await close(await addUser(a))
    expect((await send(a, 'donation_receipt')).status).toBe('stubbed')
  })
  it('an event assignment to that shared address is delivered (queued path too)', async () => {
    const a = em('assign'); await close(await addUser(a))
    expect((await send(a, 'event_assignment_added')).status).toBe('stubbed')
    const n = await scheduleNotification({ organizationId: orgId, recipient: a, notification_type: 'assignment_reminder', vars: {}, sendAt: past() })
    await processDueNotifications({ now: new Date() })
    expect((await pool.query('SELECT status FROM ochr_scheduled_notifications WHERE id = $1', [n.id])).rows[0].status).toBe('sent')
  })
  it('login-addressed mail to the same address is still refused, with its own reason', async () => {
    const a = em('staffmail'); await close(await addUser(a))
    const r = await send(a, 'member_birthday')
    expect(r.reason).toBe('recipient_inactive')
    expect(r.detail).toBe(REFUSAL_REASONS.by_former_address)
  })
})

describe('F4: distinct reason per refusal rule', () => {
  it('texts are distinct and by_id / by_address surface their own text', async () => {
    expect(new Set(Object.values(REFUSAL_REASONS)).size).toBe(4)
    const a = em('deactreason'); const id = await addUser(a)
    expect((await request(server).post(`/api/users/${id}/deactivate`).set(auth())).status).toBe(200)
    expect((await notify({ organizationId: orgId, userId: id, recipient: a, notification_type: 'member_birthday', vars: {} })).detail).toBe(REFUSAL_REASONS.by_id)
    const r = await send(a, 'member_birthday')
    expect(r.detail).toBe(REFUSAL_REASONS.by_address)
    const log = await pool.query(`SELECT error FROM ochr_notification_log WHERE id = $1`, [r.id])
    expect(log.rows[0].error).toBe(REFUSAL_REASONS.by_address)
  })
})

describe('F3 + test gaps', () => {
  it('double close writes one row with a stable closed_at; re-close of a reused address keeps the first closed_at', async () => {
    const a = em('reclose')
    const id1 = await addUser(a); await close(id1)
    const first = (await supp()).length
    const before = await supp()
    await request(server).post(`/api/users/${id1}/close`).set(auth()) // double close (status not asserted)
    expect(await supp()).toEqual(before)
    await new Promise(r => setTimeout(r, 20))
    const id2 = await addUser(a); await close(id2)
    const after = await supp()
    expect(after.length).toBe(first)
    expect(after).toEqual(before)
  })
  it('old notification rows (sent log, earlier queue rows) are untouched by closure', async () => {
    const a = em('oldrows'); const id = await addUser(a)
    const sent = await send(a, 'member_birthday')
    expect(sent.status).toBe('stubbed')
    const snap = async () => (await pool.query('SELECT status, error FROM ochr_notification_log WHERE id = $1', [sent.id])).rows[0]
    const pre = await snap(); await close(id)
    expect(await snap()).toEqual(pre)
  })
  it('deactivate then reactivate lifts the refusal and writes no suppression row', async () => {
    const a = em('react'); const id = await addUser(a); const n0 = (await supp()).length
    expect((await request(server).post(`/api/users/${id}/deactivate`).set(auth())).status).toBe(200)
    expect((await send(a, 'member_birthday')).reason).toBe('recipient_inactive')
    expect((await request(server).post(`/api/users/${id}/reactivate`).set(auth())).status).toBe(200)
    expect((await send(a, 'member_birthday')).status).toBe('stubbed')
    expect((await supp()).length).toBe(n0)
  })
  it('a pending re-invite of the former address lifts suppression; the suppression row is kept', async () => {
    const a = em('reinvite'); await close(await addUser(a))
    expect((await send(a, 'member_birthday')).reason).toBe('recipient_inactive')
    const n0 = (await supp()).length
    const inv = await request(server).post('/api/users/invite').set(auth()).send({ name: 'Re', email: a, role: 'staff' })
    expect(inv.status).toBe(201)
    expect(inv.body.user.pending).toBe(true)
    expect((await send(a, 'member_birthday')).status).toBe('stubbed')
    expect((await supp()).length).toBe(n0)
  })
})
