// ARG-V2-1 (reset PR6): after a login is closed, mail queued LATER by
// address only to the former address is refused at dispatch admission
// (transport.js recipientInactive, by_former_address), the same single
// post-claim check that #286 added. Nothing here mocks the transport.
// It sends again once an active login in the org holds the address.
// Local synthetic data only.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'
import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { scheduleNotification, processDueNotifications } from '../src/notifications/scheduler.js'
import { notify, recipientInactive } from '../src/notifications/transport.js'

let server, token, orgId, otherOrg
const auth = (t) => ({ Authorization: `Bearer ${t}` })
const R = RUN_ID.replace(/[^a-z0-9]/gi, '').toLowerCase()
const past = () => new Date(Date.now() - 60_000)
// Process at real time so other files' future-dated rows are never claimed
// here; assert on DB status, since another worker may dispatch our rows.
const later = () => new Date()
const statusOf = async (id) => (await pool.query('SELECT status, error FROM ochr_scheduled_notifications WHERE id = $1', [id])).rows[0]
const logsFor = async (recipient) => (await pool.query(
  'SELECT status FROM ochr_notification_log WHERE organization_id = $1 AND recipient_email = $2 ORDER BY id', [orgId, recipient])).rows.map(r => r.status)

async function signup(tag, ip) {
  const res = await request(server).post('/api/auth/signup').set('X-Forwarded-For', ip)
    .send({ organizationName: `AV21 ${tag} ${R}`, name: 'Admin', email: `av21_${tag}_${R}@example.com`, password: 'av21-test-pw' })
  expect(res.status).toBe(201)
  return { token: res.body.token, orgId: res.body.user.organization.id }
}
async function addUser(t, email) {
  const u = await request(server).post('/api/users').set(auth(t)).send({ name: 'U', email, password: 'av21-test-pw', role: 'staff' })
  expect(u.status).toBe(201)
  return u.body.id
}
const closeUser = async (id) => expect((await request(server).post(`/api/users/${id}/close`).set(auth(token))).status).toBe(200)

beforeAll(async () => {
  delete process.env.RESEND_API_KEY // stub transport; admission runs before it
  await migrateOnce(); server = await bindServer()
  ;({ token, orgId } = await signup('a', '10.93.1.1'))
  ;({ orgId: otherOrg } = await signup('b', '10.93.2.1'))
}, 60_000)
afterAll(async () => {
  await pool.query('DELETE FROM ochr_organizations WHERE id = ANY($1)', [[orgId, otherOrg]]).catch(() => {})
  await closeServer(server); await pool.end()
})

describe('ARG-V2-1 closed-address suppression at dispatch admission', () => {
  it('closure stores the address hash, not the address; queued address-only mail (any case/whitespace, incl. Unicode) is cancelled', async () => {
    const em = `av21_closed_${R}@example.com`
    const id = await addUser(token, em)
    await closeUser(id)
    const stored = await pool.query('SELECT email_sha256 FROM ochr_closed_address_suppressions WHERE organization_id = $1', [orgId])
    expect(stored.rows).toHaveLength(1)
    expect(stored.rows[0].email_sha256).toMatch(/^[0-9a-f]{64}$/)
    const a = await scheduleNotification({ organizationId: orgId, recipient: em, notification_type: 'member_birthday', vars: { member_name: 'G' }, sendAt: past() })
    const b = await scheduleNotification({ organizationId: orgId, recipient: `\u00a0 ${em.toUpperCase()}\t`, notification_type: 'member_birthday', vars: { member_name: 'G' }, sendAt: past() })
    await processDueNotifications({ now: later() })
    for (const n of [a, b]) {
      const s = await statusOf(n.id)
      expect(s.status).toBe('cancelled')
      expect(s.error).toMatch(/former address of a closed login/)
    }
  })

  it('a direct (unqueued) notify to the former address is skipped, not sent', async () => {
    const em = `av21_direct_${R}@example.com`
    const id = await addUser(token, em)
    await closeUser(id)
    const r = await notify({ organizationId: orgId, recipient: em, notification_type: 'member_birthday', vars: { member_name: 'D' } })
    expect(r.reason).toBe('recipient_inactive')
    expect(await logsFor(em)).toEqual(['skipped'])
  })

  it('no double handling: a row by user_id for the closed login is refused once (one skipped log), not twice', async () => {
    const em = `av21_once_${R}@example.com`
    const id = await addUser(token, em)
    await closeUser(id)
    const tomb = (await pool.query('SELECT email FROM ochr_users WHERE id = $1', [id])).rows[0].email
    const r = await notify({ organizationId: orgId, userId: id, recipient: em, notification_type: 'member_birthday', vars: { member_name: 'O' } })
    expect(r.reason).toBe('recipient_inactive')
    expect(await logsFor(em)).toEqual(['skipped'])
    expect(tomb).not.toBe(em)
  })

  it('no gap for deactivation: the address is still on the row, so by_address refuses it and no hash is written', async () => {
    const em = `av21_deact_${R}@example.com`
    const id = await addUser(token, em)
    const before = (await pool.query('SELECT count(*)::int n FROM ochr_closed_address_suppressions WHERE organization_id = $1', [orgId])).rows[0].n
    expect((await request(server).post(`/api/users/${id}/deactivate`).set(auth(token))).status).toBe(200)
    expect(await recipientInactive({ organizationId: orgId, recipient: em })).toBe(true)
    const after = (await pool.query('SELECT count(*)::int n FROM ochr_closed_address_suppressions WHERE organization_id = $1', [orgId])).rows[0].n
    expect(after).toBe(before)
  })

  it('does not suppress the same address in a different org', async () => {
    const em = `av21_xorg_${R}@example.com`
    const id = await addUser(token, em)
    await closeUser(id)
    expect(await recipientInactive({ organizationId: otherOrg, recipient: em })).toBe(false)
    const n = await scheduleNotification({ organizationId: otherOrg, recipient: em, notification_type: 'member_birthday', vars: { member_name: 'X' }, sendAt: past() })
    await processDueNotifications({ now: later() })
    expect((await statusOf(n.id)).status).toBe('sent')
  })

  it('lifts once an active login in the org holds the address again', async () => {
    const em = `av21_reuse_${R}@example.com`
    const id = await addUser(token, em)
    await closeUser(id)
    expect(await recipientInactive({ organizationId: orgId, recipient: em })).toBe(true)
    await addUser(token, em) // address released by closure, re-used
    expect(await recipientInactive({ organizationId: orgId, recipient: em })).toBe(false)
    const n = await scheduleNotification({ organizationId: orgId, recipient: em, notification_type: 'member_birthday', vars: { member_name: 'Y' }, sendAt: past() })
    await processDueNotifications({ now: later() })
    expect((await statusOf(n.id)).status).toBe('sent')
  })

  it('unrelated address-only mail in the org still sends', async () => {
    const n = await scheduleNotification({ organizationId: orgId, recipient: `av21_member_${R}@example.com`, notification_type: 'member_birthday', vars: { member_name: 'Z' }, sendAt: past() })
    await processDueNotifications({ now: later() })
    expect((await statusOf(n.id)).status).toBe('sent')
  })
})
