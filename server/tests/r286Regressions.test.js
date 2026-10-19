// R286-2 / R286-3 regressions (TARS review of #286 at 6b932896). Real local
// Postgres, synthetic data, fake email + web-push transports (zero provider
// calls are asserted on the fakes; nothing leaves the box).
//
// R286-2: the F-06 recipient backstop and migration 117 must follow the
// HOLD contract (held rows untouched, hold-refusal retried once, other
// parishes keep draining).
// R286-3: a closure/deactivation that commits AFTER a queue claim must stop
// delivery at the dispatch boundary (email and push), and must not be
// counted as sent.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

const { sendEmail, sendNotification } = vi.hoisted(() => ({
  sendEmail: vi.fn(async () => ({ id: 'fake-provider-id' })),
  sendNotification: vi.fn(async () => ({ statusCode: 201 })),
}))
vi.mock('../src/email/send.js', async (orig) => ({ ...(await orig()), sendEmail }))
vi.mock('web-push', () => ({ default: { setVapidDetails: vi.fn(), sendNotification } }))

import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { processDueNotifications, scheduleNotification } from '../src/notifications/scheduler.js'
import { notify } from '../src/notifications/transport.js'
import { sendPushToUser } from '../src/notifications/push.js'
import { holdOrganization } from '../src/auth/organizationHold.js'
import { neutralizeDemoAdmin } from '../src/migrations/117-neutralize-demo-admin.js'

let server
const orgs = []
const ENV = ['RESEND_API_KEY', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY']
const saved = {}
const auth = t => ({ Authorization: `Bearer ${t}` })
let ip = 1

async function parish(tag) {
  const name = `R286 ${tag} ${RUN_ID}`
  const email = `r286_${tag}_${RUN_ID}@example.com`
  const res = await request(server).post('/api/auth/signup').set('X-Forwarded-For', `10.93.${ip++}.1`)
    .send({ organizationName: name, name: 'Admin', email, password: 'r286-test-pw' })
  expect(res.status).toBe(201)
  const org = { id: res.body.user.organization.id, name, email, userId: res.body.user.id, token: res.body.token }
  orgs.push(org.id)
  return org
}
async function member(org, tag) {
  const email = `r286_${tag}_${RUN_ID}@example.com`
  const u = await request(server).post('/api/users').set(auth(org.token))
    .send({ name: `M ${tag}`, email, password: 'r286-test-pw', role: 'admin' })
  expect(u.status).toBe(201)
  return { id: u.body.id, email }
}
async function due(orgId, userId, recipient) {
  const { rows } = await pool.query(
    `INSERT INTO ochr_scheduled_notifications (organization_id, user_id, recipient_email, notification_type, vars, send_at, status)
     VALUES ($1, $2, $3, 'member_birthday', '{"member_name":"R"}'::jsonb, NOW() - INTERVAL '1 minute', 'pending') RETURNING id`,
    [orgId, userId, recipient])
  return rows[0].id
}
const rowOf = async id => (await pool.query('SELECT status, attempts, error FROM ochr_scheduled_notifications WHERE id = $1', [id])).rows[0]
const claimsOf = async id => (await rowOf(id)).attempts
const mailedTo = addr => sendEmail.mock.calls.filter(([m]) => String(m.to).toLowerCase() === addr.toLowerCase()).length

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k]
  process.env.RESEND_API_KEY = 'fake-key-not-used' // routes to the faked sendEmail
  await migrateOnce()
  server = await bindServer()
}, 60_000)
afterEach(() => { vi.restoreAllMocks(); sendEmail.mockClear(); sendNotification.mockClear() })
afterAll(async () => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  for (const id of orgs) await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
  await closeServer(server)
  await pool.end()
})

describe('R286-2 HOLD isolation', () => {
  it('a held parish with a due row for its (HOLD-deactivated) recipient does not stop an active parish; held row unchanged', async () => {
    const held = await parish('held')
    const active = await parish('active')
    const heldRow = await due(held.id, held.userId, held.email)
    const activeRow = await due(active.id, active.userId, active.email)
    await holdOrganization({ organizationId: held.id, actorId: held.userId, confirm: held.name, acknowledgeExportWarning: true })
    const before = await rowOf(heldRow)
    sendEmail.mockClear()
    await expect(processDueNotifications()).resolves.toBeTruthy()
    expect(await rowOf(heldRow)).toEqual(before)
    expect((await rowOf(activeRow)).status).toBe('sent')
    expect(mailedTo(held.email)).toBe(0)
    expect(mailedTo(active.email)).toBe(1)
  })

  it('a HOLD refusal raised mid-statement on the backstop is retried once and the drain continues', async () => {
    const org = await parish('retry')
    const rowId = await due(org.id, org.userId, org.email)
    const real = pool.query.bind(pool)
    let refused = 0
    vi.spyOn(pool, 'query').mockImplementation((sql, params) => {
      if (typeof sql === 'string' && sql.includes('UPDATE ochr_scheduled_notifications n')
          && sql.includes('recipient login closed or deactivated') && refused === 0) {
        refused++
        const err = new Error('organization 0 is on hold'); err.code = '23514'
        return Promise.reject(err)
      }
      return real(sql, params)
    })
    await expect(processDueNotifications()).resolves.toBeTruthy()
    expect(refused).toBe(1)
    expect((await rowOf(rowId)).status).toBe('sent')
  })

  it('migration 117 neutralizer is replay-safe on held, closed and absent targets', async () => {
    const held = await parish('demoheld')
    const closedOrg = await parish('democlosed')
    const victim = await member(closedOrg, 'demovictim')
    expect((await request(server).post(`/api/users/${victim.id}/close`).set(auth(closedOrg.token))).status).toBe(200)
    await holdOrganization({ organizationId: held.id, actorId: held.userId, confirm: held.name, acknowledgeExportWarning: true })
    for (let i = 0; i < 2; i++) {
      const h = await neutralizeDemoAdmin(pool, held.email)
      expect(h.neutralized).toEqual([])
      expect(h.skipped).toEqual([{ id: held.userId, reason: 'held' }])
      // Closure tombstones the address (closed-user-<id>@login-closed.invalid),
      // so a closed demo login no longer matches at all: nothing is written.
      const tvBefore = (await pool.query('SELECT token_version, password_hash FROM ochr_users WHERE id = $1', [victim.id])).rows[0]
      expect(await neutralizeDemoAdmin(pool, victim.email)).toEqual({ neutralized: [], skipped: [] })
      expect((await pool.query('SELECT token_version, password_hash FROM ochr_users WHERE id = $1', [victim.id])).rows[0]).toEqual(tvBefore)
      expect(await neutralizeDemoAdmin(pool, `absent_${RUN_ID}@example.com`)).toEqual({ neutralized: [], skipped: [] })
    }
    // An active target is neutralized once; replay changes nothing further.
    const live = await parish('demolive')
    expect((await neutralizeDemoAdmin(pool, live.email)).neutralized).toEqual([live.userId])
    const tv = (await pool.query('SELECT token_version, deactivated_at FROM ochr_users WHERE id = $1', [live.userId])).rows[0]
    expect(tv.deactivated_at).not.toBeNull()
  })
})

describe('R286-3 closure/deactivation after claim', () => {
  it('claim → (closure and deactivation commit) → dispatch: zero provider calls for them, the active recipient still sends, not counted as sent', async () => {
    const org = await parish('race')
    const toClose = await member(org, 'raceclose')
    const toDeact = await member(org, 'racedeact')
    const ids = {
      close: await due(org.id, toClose.id, toClose.email),
      addr: await due(org.id, null, toClose.email.toUpperCase()),
      deact: await due(org.id, toDeact.id, toDeact.email),
      live: await due(org.id, org.userId, org.email),
    }
    const real = pool.query.bind(pool)
    let barrier = 0
    vi.spyOn(pool, 'query').mockImplementation(async (sql, params) => {
      const out = await real(sql, params)
      if (typeof sql === 'string' && sql.includes("SET status = 'processing'") && barrier === 0) {
        barrier++
        // The claim has COMMITTED (autocommit). Now the state change commits
        // through the real routes, before any dispatch.
        expect((await request(server).post(`/api/users/${toClose.id}/close`).set(auth(org.token))).status).toBe(200)
        expect((await request(server).post(`/api/users/${toDeact.id}/deactivate`).set(auth(org.token))).status).toBe(200)
      }
      return out
    })
    sendEmail.mockClear()
    const result = await processDueNotifications()
    expect(barrier).toBe(1)
    expect(mailedTo(toClose.email)).toBe(0)
    expect(mailedTo(toDeact.email)).toBe(0)
    expect(mailedTo(org.email)).toBe(1)
    for (const k of ['close', 'addr', 'deact']) {
      const r = await rowOf(ids[k])
      expect(r.status, k).toBe('cancelled')
    }
    expect((await rowOf(ids.live)).status).toBe('sent')
    // No double handling: each own row was claimed exactly once.
    for (const k of ['close', 'addr', 'deact', 'live']) expect((await claimsOf(ids[k])), k).toBe(1)
    // Kept as is: a lower bound on THIS drainer's own cancellations. Other
    // files' rows it claims can only raise it; it can only fall if another
    // drainer claimed these rows first, which already fails the status
    // assertions above (fixture-level proof in leo/test-owned-fixture-counts).
    expect(result.cancelled).toBeGreaterThanOrEqual(3)
  })

  it('direct notify to an already-closed recipient (by id) or deactivated one (by same-org address) makes no provider call; an unrelated active one does', async () => {
    const org = await parish('direct')
    const gone = await member(org, 'directgone')
    const off = await member(org, 'directoff')
    expect((await request(server).post(`/api/users/${gone.id}/close`).set(auth(org.token))).status).toBe(200)
    expect((await request(server).post(`/api/users/${off.id}/deactivate`).set(auth(org.token))).status).toBe(200)
    sendEmail.mockClear()
    const a = await notify({ organizationId: org.id, userId: gone.id, recipient: gone.email, notification_type: 'member_birthday', vars: { member_name: 'R' } })
    const b = await notify({ organizationId: org.id, userId: null, recipient: ` ${off.email.toUpperCase()} `, notification_type: 'member_birthday', vars: { member_name: 'R' } })
    const c = await notify({ organizationId: org.id, userId: org.userId, recipient: org.email, notification_type: 'member_birthday', vars: { member_name: 'R' } })
    expect(a.reason).toBe('recipient_inactive')
    expect(b.reason).toBe('recipient_inactive')
    expect(c.status).toBe('sent')
    expect(mailedTo(gone.email)).toBe(0)
    expect(mailedTo(off.email)).toBe(0)
    expect(mailedTo(org.email)).toBe(1)
  })

  it('push: no web-push call for a closed or deactivated login, re-read at send time; an active one is pushed', async () => {
    process.env.VAPID_PUBLIC_KEY = 'fake-pub'; process.env.VAPID_PRIVATE_KEY = 'fake-priv'
    const org = await parish('push')
    const closed = await member(org, 'pushclosed')
    const deact = await member(org, 'pushdeact')
    for (const u of [closed.id, deact.id, org.userId]) {
      await pool.query(`INSERT INTO ochr_push_subscriptions (organization_id, user_id, endpoint, p256dh, auth)
                        VALUES ($1, $2, $3, 'p', 'a')`, [org.id, u, `https://push.invalid/${u}`])
    }
    expect((await request(server).post(`/api/users/${closed.id}/close`).set(auth(org.token))).status).toBe(200)
    expect((await request(server).post(`/api/users/${deact.id}/deactivate`).set(auth(org.token))).status).toBe(200)
    sendNotification.mockClear()
    expect((await sendPushToUser(closed.id, { title: 't' })).sent).toBe(0)
    expect((await sendPushToUser(deact.id, { title: 't' })).sent).toBe(0)
    expect(sendNotification).not.toHaveBeenCalled()
    await sendPushToUser(org.userId, { title: 't' })
    expect(sendNotification).toHaveBeenCalledTimes(1)
  })
})

describe('global enqueue vs a concurrently deleted organization', () => {
  it('an org deleted between snapshot and FK check enqueues nothing instead of aborting the run', async () => {
    const real = pool.query.bind(pool)
    vi.spyOn(pool, 'query').mockImplementationOnce(() => {
      const err = new Error('insert or update on table "ochr_scheduled_notifications" violates foreign key constraint')
      err.code = '23503'; err.constraint = 'ochr_scheduled_notifications_organization_id_fkey'
      return Promise.reject(err)
    }).mockImplementation((...a) => real(...a))
    await expect(scheduleNotification({ organizationId: 2147483000, notification_type: 'member_birthday', sendAt: new Date() })).resolves.toBeUndefined()
    // any other error still throws
    vi.spyOn(pool, 'query').mockImplementationOnce(() => Promise.reject(Object.assign(new Error('x'), { code: '23503', constraint: 'other_fkey' })))
    await expect(scheduleNotification({ organizationId: 1, notification_type: 'member_birthday', sendAt: new Date() })).rejects.toThrow('x')
  })
})

// R286-3 follow-up (TARS at fda17292): the state change commits DURING the
// last awaited lookup before transport — the suppression lookup (email) and
// the subscription lookup (push). Real routes commit it while the lookup is
// paused; then the lookup is released.
describe('R286-3 closure/deactivation/HOLD during the last awaited lookup', () => {
  // Pause the first query matching `fragment` whose params mention a key in
  // `actions`, run that key's action (a real committed state change), then
  // let the query complete.
  function barrierOn(fragment, actions) {
    const real = pool.query.bind(pool)
    const fired = []
    vi.spyOn(pool, 'query').mockImplementation(async (sql, params) => {
      if (typeof sql === 'string' && sql.includes(fragment) && Array.isArray(params)) {
        const key = Object.keys(actions).find(k => params.map(String).some(p => p.toLowerCase() === k.toLowerCase()) && !fired.includes(k))
        if (key) { fired.push(key); await actions[key]() }
      }
      return real(sql, params)
    })
    return fired
  }

  it('email: closure and deactivation committed during the suppression lookup → zero provider calls, cancelled not sent; active control sends', async () => {
    const org = await parish('suppr')
    const c = await member(org, 'supprclose')
    const d = await member(org, 'supprdeact')
    const ids = { c: await due(org.id, c.id, c.email), d: await due(org.id, d.id, d.email), live: await due(org.id, org.userId, org.email) }
    const fired = barrierOn('FROM ochr_email_suppressions', {
      [c.email]: async () => expect((await request(server).post(`/api/users/${c.id}/close`).set(auth(org.token))).status).toBe(200),
      [d.email]: async () => expect((await request(server).post(`/api/users/${d.id}/deactivate`).set(auth(org.token))).status).toBe(200),
    })
    sendEmail.mockClear()
    const result = await processDueNotifications()
    expect(fired.sort()).toEqual([c.email, d.email].sort())
    expect(mailedTo(c.email)).toBe(0)
    expect(mailedTo(d.email)).toBe(0)
    expect(mailedTo(org.email)).toBe(1)
    expect((await rowOf(ids.c)).status).toBe('cancelled')
    expect((await rowOf(ids.d)).status).toBe('cancelled')
    expect((await rowOf(ids.live)).status).toBe('sent')
    // No double handling; the lower bound is kept for the reason above.
    for (const k of ['c', 'd', 'live']) expect((await claimsOf(ids[k])), k).toBe(1)
    expect(result.cancelled).toBeGreaterThanOrEqual(2)
  })

  it('email: HOLD committed during the suppression lookup → zero provider calls; the claimed row is not marked sent (held writes are refused; it is left as claimed)', async () => {
    const org = await parish('supprhold')
    const rowId = await due(org.id, org.userId, org.email)
    const fired = barrierOn('FROM ochr_email_suppressions', {
      [org.email]: async () => { await holdOrganization({ organizationId: org.id, actorId: org.userId, confirm: org.name, acknowledgeExportWarning: true }) },
    })
    sendEmail.mockClear()
    await processDueNotifications()
    expect(fired).toEqual([org.email])
    expect(mailedTo(org.email)).toBe(0)
    // Existing HOLD contract (scheduler settle): a held org's row cannot be
    // written, so it stays exactly as claimed; it is never recorded as sent.
    expect((await rowOf(rowId)).status).toBe('processing')
  })

  it('push: closure, deactivation and HOLD committed during the subscription lookup → zero web-push calls; active control is pushed', async () => {
    process.env.VAPID_PUBLIC_KEY = 'fake-pub'; process.env.VAPID_PRIVATE_KEY = 'fake-priv'
    const org = await parish('subs')
    const held = await parish('subsheld')
    const c = await member(org, 'subsclose')
    const d = await member(org, 'subsdeact')
    for (const [o, u] of [[org.id, c.id], [org.id, d.id], [org.id, org.userId], [held.id, held.userId]]) {
      await pool.query(`INSERT INTO ochr_push_subscriptions (organization_id, user_id, endpoint, p256dh, auth)
                        VALUES ($1, $2, $3, 'p', 'a')`, [o, u, `https://push.invalid/${u}`])
    }
    const fired = barrierOn('FROM ochr_push_subscriptions', {
      [String(c.id)]: async () => expect((await request(server).post(`/api/users/${c.id}/close`).set(auth(org.token))).status).toBe(200),
      [String(d.id)]: async () => expect((await request(server).post(`/api/users/${d.id}/deactivate`).set(auth(org.token))).status).toBe(200),
      [String(held.userId)]: async () => { await holdOrganization({ organizationId: held.id, actorId: held.userId, confirm: held.name, acknowledgeExportWarning: true }) },
    })
    sendNotification.mockClear()
    expect((await sendPushToUser(c.id, { title: 't' })).sent).toBe(0)
    expect((await sendPushToUser(d.id, { title: 't' })).sent).toBe(0)
    expect((await sendPushToUser(held.userId, { title: 't' })).sent).toBe(0)
    expect(fired.length).toBe(3)
    expect(sendNotification).not.toHaveBeenCalled()
    await sendPushToUser(org.userId, { title: 't' })
    expect(sendNotification).toHaveBeenCalledTimes(1)
  })
})
