// Login DEACTIVATION must not drop mail addressed to a member or donor
// RECORD that shares the deactivated login's address (Ledger #430 P3-1,
// CAROLINA-430 #9/#10, #293 F1 class: deactivation is not member removal).
// On main it did, three ways:
//   1. queue time: deactivateLogin cancelled every queued row matched by
//      address, whatever its type ("cancelled: login closed or deactivated");
//   2. send time: transport.js by_address refused every type to an address
//      held by a deactivated login, so an immediate donation_receipt was
//      refused and never sent;
//   3. dispatcher backstop: scheduler.js cancelled due rows matched by that
//      address, whatever their type.
// With the fix, record-addressed types (RECORD_ADDRESSED_TYPES) matched by
// address are kept and delivered; login-addressed and unknown types to that
// address, and anything addressed to the deactivated login's id, are still
// cancelled or refused. Red on main, green with the fix. Real transport,
// stub provider (RESEND_API_KEY unset). Local synthetic data only.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { scheduleNotification, processDueNotifications } from '../src/notifications/scheduler.js'
import { notify, recipientRefusal, REFUSAL_REASONS } from '../src/notifications/transport.js'

let server
let ipN = 1
const ip = () => `10.97.${Math.floor(ipN / 200)}.${(ipN++ % 200) + 1}`
const auth = (t) => ({ Authorization: `Bearer ${t}` })
const PW = 'drq-pw-123456'
const R = RUN_ID.replace(/[^a-z0-9]/gi, '').toLowerCase()
const em = (t) => `drq_${t}_${R}@example.com`
const past = () => new Date(Date.now() - 60_000)
const orgs = []

async function signup(tag) {
  const res = await request(server).post('/api/auth/signup').set('X-Forwarded-For', ip())
    .send({ organizationName: `DRQ ${tag} ${R}`, name: `Fic Admin ${tag}`, email: em(tag), password: PW })
  expect(res.status).toBe(201)
  orgs.push(res.body.user.organization.id)
  return { token: res.body.token, id: res.body.user.id, org: res.body.user.organization.id }
}

async function addUser(adm, tag) {
  const u = await request(server).post('/api/users').set(auth(adm.token))
    .send({ name: `Fic ${tag}`, email: em(tag), password: PW, role: 'staff' })
  expect(u.status).toBe(201)
  const l = await request(server).post('/api/auth/login').set('X-Forwarded-For', ip())
    .send({ email: em(tag), password: PW })
  expect(l.status).toBe(200)
  return { token: l.body.token, id: u.body.id, org: adm.org, email: em(tag) }
}

// Queued BEFORE deactivation, due tomorrow: only the up-front cancel acts.
async function queue(org, u) {
  const { rows } = await pool.query(
    `INSERT INTO ochr_scheduled_notifications
       (organization_id, user_id, recipient_email, notification_type, send_at)
     VALUES ($1, NULL, $2, 'donation_receipt',       NOW() + INTERVAL '1 day'),
            ($1, NULL, $2, 'recurring_gift_stopped', NOW() + INTERVAL '1 day'),
            ($1, NULL, $2, 'assignment_reminder',    NOW() + INTERVAL '1 day'),
            ($1, NULL, $2, 'task_due_reminder',      NOW() + INTERVAL '1 day'),
            ($1, $3,   $2, 'donation_receipt',       NOW() + INTERVAL '1 day')
     RETURNING id`,
    [org, u.email.toUpperCase(), u.id])
  return rows.map(r => r.id)
}

const row = async (id) => (await pool.query(
  'SELECT status, error FROM ochr_scheduled_notifications WHERE id = $1', [id])).rows[0]

function expectFiltered(s) {
  const reason = 'cancelled: login closed or deactivated'
  // record-addressed, matched by address only: kept
  expect(s[0], 'donation_receipt by address').toMatchObject({ status: 'pending', error: null })
  expect(s[1], 'recurring_gift_stopped by address').toMatchObject({ status: 'pending', error: null })
  expect(s[2], 'assignment_reminder by address').toMatchObject({ status: 'pending', error: null })
  // login-addressed type matched by address: still cancelled
  expect(s[3], 'task_due_reminder by address').toMatchObject({ status: 'cancelled', error: reason })
  // addressed to the deactivated login's id: cancelled whatever its type
  expect(s[4], 'donation_receipt by user id').toMatchObject({ status: 'cancelled', error: reason })
}

beforeAll(async () => {
  delete process.env.RESEND_API_KEY
  await migrateOnce()
  server = await bindServer()
}, 60_000)

afterAll(async () => {
  for (const id of orgs) await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
  await closeServer(server)
  await pool.end()
})

describe('deactivation keeps queued record-addressed mail (queue time)', () => {
  it('admin deactivate', async () => {
    const a = await signup('adm')
    const u = await addUser(a, 'admu')
    const ids = await queue(a.org, u)
    const r = await request(server).post(`/api/users/${u.id}/deactivate`).set(auth(a.token)).send({})
    expect(r.status).toBe(200)
    expectFiltered(await Promise.all(ids.map(row)))
  })

  it('self deactivate', async () => {
    const a = await signup('self')
    const u = await addUser(a, 'selfu')
    const ids = await queue(a.org, u)
    const r = await request(server).post('/api/auth/deactivate').set(auth(u.token)).send({})
    expect(r.status).toBe(200)
    expectFiltered(await Promise.all(ids.map(row)))
  })
})

describe('deactivation does not refuse record-addressed mail to the shared address (send time)', () => {
  it('immediate sends: receipt delivered; login-addressed, unknown and by-id still refused', async () => {
    const a = await signup('send')
    const u = await addUser(a, 'sendu')
    expect((await request(server).post(`/api/users/${u.id}/deactivate`).set(auth(a.token))).status).toBe(200)
    const send = (recipient, notification_type, userId = null) =>
      notify({ organizationId: a.org, userId, recipient, notification_type, vars: {} })

    // A donor/member record sharing the address still gets its receipt.
    expect((await send(` ${u.email.toUpperCase()} `, 'donation_receipt')).status).toBe('stubbed')
    expect((await send(u.email, 'recurring_gift_stopped')).status).toBe('stubbed')

    // Login-addressed mail to the deactivated login's address: refused.
    const birthday = await send(u.email, 'member_birthday')
    expect(birthday).toMatchObject({ reason: 'recipient_inactive', detail: REFUSAL_REASONS.by_address })
    // An unclassified or missing type fails closed at admission.
    for (const notification_type of ['password_reset', 'login_invite', null]) {
      expect(await recipientRefusal({ organizationId: a.org, recipient: u.email, notification_type }), String(notification_type))
        .toBe(REFUSAL_REASONS.by_address)
    }
    // Login mail proper (password reset) to the deactivated login is still
    // refused by its own route: generic 200, no reset token stored.
    const fp = await request(server).post('/api/auth/forgot-password').set('X-Forwarded-For', ip()).send({ email: u.email })
    expect(fp.status).toBe(200)
    expect((await pool.query('SELECT count(*)::int AS n FROM ochr_password_reset_tokens WHERE user_id = $1', [u.id])).rows[0].n).toBe(0)
    // Anything addressed to the deactivated login's id: refused, any type.
    const byId = await send(u.email, 'donation_receipt', u.id)
    expect(byId).toMatchObject({ reason: 'recipient_inactive', detail: REFUSAL_REASONS.by_id })

  })

  it('dispatcher backstop: rows queued after deactivation — receipt sent, login mail cancelled', async () => {
    const a = await signup('drain')
    const u = await addUser(a, 'drainu')
    expect((await request(server).post(`/api/users/${u.id}/deactivate`).set(auth(a.token))).status).toBe(200)
    const q = (notification_type, userId = null) => scheduleNotification({
      organizationId: a.org, userId, recipient: u.email.toUpperCase(), notification_type, vars: {}, sendAt: past() })
    const receipt = await q('donation_receipt')
    const assign = await q('assignment_reminder')
    const login = await q('task_due_reminder')
    const own = await q('donation_receipt', u.id)
    await processDueNotifications({ now: new Date(), batchSize: 500 })
    expect((await row(receipt.id)).status, 'donation_receipt by address').toBe('sent')
    expect((await row(assign.id)).status, 'assignment_reminder by address').toBe('sent')
    expect((await row(login.id)).status, 'task_due_reminder by address').toBe('cancelled')
    expect((await row(own.id)).status, 'donation_receipt by user id').toBe('cancelled')
  })
})
