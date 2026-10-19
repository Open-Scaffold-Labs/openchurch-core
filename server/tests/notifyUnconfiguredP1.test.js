// P-1 (TARS bridge #62 comment 6245266325): a production notification with
// no email provider key, or a provider failure, must never be recorded as
// sent. Real local Postgres, synthetic data, fake email + web-push
// transports; nothing leaves the box and no real key is used.
//
// Assertions are on rows this file owns (its own queue rows and log rows),
// never on whole-database counters.

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
import { processDueNotifications } from '../src/notifications/scheduler.js'
import { notify } from '../src/notifications/transport.js'
import { holdOrganization } from '../src/auth/organizationHold.js'
import { maskEmail } from '../src/utils/redact.js'

let server
const orgs = []
const ENV = ['RESEND_API_KEY', 'NODE_ENV', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY']
const saved = {}
let ip = 1
const FAKE_SECRET = 're_FAKEPROVIDERSECRET0123456789abcdef'

async function parish(tag) {
  const name = `P1U ${tag} ${RUN_ID}`
  const email = `p1u_${tag}_${RUN_ID}@example.com`
  const res = await request(server).post('/api/auth/signup').set('X-Forwarded-For', `10.94.${ip++}.1`)
    .send({ organizationName: name, name: 'Admin', email, password: 'p1u-test-pw' })
  expect(res.status).toBe(201)
  const org = { id: res.body.user.organization.id, name, email, userId: res.body.user.id }
  orgs.push(org.id)
  sendEmail.mockClear() // signup mail is not part of what these tests measure
  return org
}
async function due(org, { pushOnly = false } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO ochr_scheduled_notifications (organization_id, user_id, recipient_email, notification_type, vars, send_at, status)
     VALUES ($1, $2, $3, 'member_birthday', '{"member_name":"R"}'::jsonb, NOW() - INTERVAL '1 minute', 'pending') RETURNING id`,
    [org.id, org.userId, pushOnly ? null : org.email])
  return rows[0].id
}
// The drain is global: processDueNotifications() also settles due rows that
// other test files (running concurrently against the same database) left
// behind, and their pushes reach this file's web-push mock. Count only pushes
// to subscriptions this file created; another file's push is not this
// file's evidence. (Observed: R299-3 complaint saw 41 foreign pushes.)
const OWN_ENDPOINT = `https://push.invalid/p1u/${RUN_ID}/`
const pushedTo = () => sendNotification.mock.calls
  .filter(([sub]) => String(sub?.endpoint ?? '').startsWith(OWN_ENDPOINT)).length
let subN = 0
async function subscribe(org, n = 1) {
  for (let i = 0; i < n; i++) {
    await pool.query(
      `INSERT INTO ochr_push_subscriptions (organization_id, user_id, endpoint, p256dh, auth)
       VALUES ($1, $2, $3, 'fake-p256dh', 'fake-auth')`,
      [org.id, org.userId, `${OWN_ENDPOINT}${subN++}`])
  }
}
const pushLogs = async org => (await pool.query(
  `SELECT status, error FROM ochr_notification_log
    WHERE organization_id = $1 AND channel = 'push' ORDER BY id`, [org.id])).rows
const rowOf = async id => (await pool.query(
  'SELECT status, attempts, error, sent_at FROM ochr_scheduled_notifications WHERE id = $1', [id])).rows[0]
const logsOf = async org => (await pool.query(
  `SELECT status, error, provider_message_id, recipient_email, subject, body FROM ochr_notification_log
    WHERE organization_id = $1 AND notification_type = 'member_birthday' ORDER BY id`, [org.id])).rows
// TARS 317-a: a failed email log row stores the masked address only, and
// no subject or body; sent and stubbed rows keep them.
const expectMinimizedLog = (log, org) => {
  expect(log.recipient_email).toBe(maskEmail(org.email))
  expect(log.recipient_email).not.toBe(org.email)
  expect(log.subject).toBeNull()
  expect(log.body).toBeNull()
}
const expectFullLog = (log, org) => {
  expect(log.recipient_email).toBe(org.email)
  expect(log.subject).toEqual(expect.any(String))
  expect(log.body).toEqual(expect.any(String))
}
const mailedTo = addr => sendEmail.mock.calls.filter(([m]) => String(m.to).toLowerCase() === addr.toLowerCase()).length
const asEnv = async (env, fn) => {
  const prev = { k: process.env.RESEND_API_KEY, n: process.env.NODE_ENV }
  if (env.key === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = env.key
  process.env.NODE_ENV = env.nodeEnv
  try { return await fn() } finally {
    if (prev.k === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = prev.k
    process.env.NODE_ENV = prev.n
  }
}
const PROD_NO_KEY = { key: undefined, nodeEnv: 'production' }
const PROD_KEY = { key: 'fake-key-not-used', nodeEnv: 'production' }
const setVapid = () => { process.env.VAPID_PUBLIC_KEY = 'fake-vapid-public'; process.env.VAPID_PRIVATE_KEY = 'fake-vapid-private' }
const clearVapid = () => { delete process.env.VAPID_PUBLIC_KEY; delete process.env.VAPID_PRIVATE_KEY } // routes to the faked sendEmail
const DEV_NO_KEY = { key: undefined, nodeEnv: 'test' }

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k]
  clearVapid()
  await migrateOnce()
  server = await bindServer()
}, 60_000)
afterEach(() => { vi.restoreAllMocks(); sendEmail.mockReset(); sendEmail.mockImplementation(async () => ({ id: 'fake-provider-id' })); sendNotification.mockReset(); sendNotification.mockImplementation(async () => ({ statusCode: 201 })) })
afterAll(async () => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  for (const id of orgs) await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
  await closeServer(server)
  await pool.end()
})

describe('P-1 production with no email key', () => {
  it('direct notify(): refused visibly as unconfigured, not stubbed, zero provider calls', async () => {
    const org = await parish('direct')
    const res = await asEnv(PROD_NO_KEY, () => notify({
      organizationId: org.id, userId: org.userId, recipient: org.email,
      notification_type: 'member_birthday', vars: { member_name: 'R' },
    }))
    expect(res.status).not.toBe('stubbed')
    expect(res.status).toBe('failed')
    expect(res.reason).toBe('unconfigured')
    const logs = await logsOf(org)
    expect(logs).toHaveLength(1)
    expect(logs[0].status).toBe('failed')
    expect(logs[0].error).toMatch(/^unconfigured:/)
    expect(logs[0].error).not.toContain(org.email)
    expect(mailedTo(org.email)).toBe(0)
  })

  it('direct sendEmail(): still refuses in production (EMAIL_TRANSPORT_UNCONFIGURED)', async () => {
    const real = await vi.importActual('../src/email/send.js')
    await asEnv(PROD_NO_KEY, () => expect(real.sendEmail({ to: 'x@example.com', subject: 's', text: 't' }))
      .rejects.toMatchObject({ code: 'EMAIL_TRANSPORT_UNCONFIGURED' }))
  })

  it('queued: the owned row settles failed/unconfigured, never sent; metrics count it', async () => {
    const org = await parish('queued')
    const id = await due(org)
    const result = await asEnv(PROD_NO_KEY, () => processDueNotifications())
    const row = await rowOf(id)
    expect(row.status).toBe('failed')
    expect(row.status).not.toBe('sent')
    expect(row.sent_at).toBeNull()
    expect(row.error).toMatch(/^unconfigured:/)
    expect(row.attempts).toBe(1)
    expect(result.unconfigured).toBeGreaterThanOrEqual(1)
    const logs = await logsOf(org)
    expect(logs.map(l => l.status)).toEqual(['failed'])
    expectMinimizedLog(logs[0], org)
    expect(mailedTo(org.email)).toBe(0)
  })

  it('opt-out settles as a deliberate no-send (cancelled, opted_out), neither provider called; HOLD preserved', async () => {
    setVapid()
    try {
      const off = await parish('optout')
      await subscribe(off)
      await pool.query(
        `INSERT INTO ochr_notification_prefs (user_id, notification_type, enabled) VALUES ($1, 'member_birthday', false)`,
        [off.userId])
      const offRow = await due(off)
      const held = await parish('held')
      const heldRow = await due(held)
      await holdOrganization({ organizationId: held.id, actorId: held.userId, confirm: held.name, acknowledgeExportWarning: true })
      const heldBefore = await rowOf(heldRow)
      const result = await asEnv(PROD_KEY, () => processDueNotifications())
      expect((await logsOf(off)).map(l => l.status)).toEqual(['skipped'])
      const r = await rowOf(offRow)
      expect(r.status).toBe('cancelled')
      expect(r.status).not.toBe('sent')
      expect(r.sent_at).toBeNull()
      expect(r.error).toMatch(/^opted_out:/)
      expect(result.opted_out).toBeGreaterThanOrEqual(1)
      expect(mailedTo(off.email)).toBe(0)
      expect(pushedTo()).toBe(0)
      expect(await rowOf(heldRow)).toEqual(heldBefore)
      expect(await logsOf(held)).toHaveLength(0)
    } finally { clearVapid() }
  })
})

describe('R299-1 push-only (production, no email address)', () => {
  // Order matters: push.js caches VAPID configuration once set, so the
  // missing-VAPID case runs before any case that sets fake VAPID keys.
  it('missing VAPID: push-only row is not sent (push_not_accepted)', async () => {
    const org = await parish('novapid')
    await subscribe(org)
    const id = await due(org, { pushOnly: true })
    const result = await asEnv(PROD_NO_KEY, () => processDueNotifications())
    const row = await rowOf(id)
    expect(row.status).toBe('failed')
    expect(row.error).toMatch(/^push_not_accepted: no_vapid_configured/)
    expect(result.push_not_accepted).toBeGreaterThanOrEqual(1)
    expect(pushedTo()).toBe(0)
    expect((await pushLogs(org)).map(l => l.status)).toEqual(['failed'])
  })

  it('provider-accepted push (sent > 0) settles the push-only row sent, logged on the push channel', async () => {
    setVapid()
    try {
      const org = await parish('pushok')
      await subscribe(org)
      const id = await due(org, { pushOnly: true })
      await asEnv(PROD_NO_KEY, () => processDueNotifications())
      const row = await rowOf(id)
      expect(row.status).toBe('sent')
      expect(row.error).toBeNull()
      expect(pushedTo()).toBe(1)
      expect((await pushLogs(org)).map(l => l.status)).toEqual(['sent'])
      expect((await logsOf(org)).filter(l => l.status === 'stubbed')).toHaveLength(0)
    } finally { clearVapid() }
  })

  it('a delayed push result is awaited: the row stays processing until acceptance is observed', async () => {
    setVapid()
    try {
      const org = await parish('pushslow')
      await subscribe(org)
      const id = await due(org, { pushOnly: true })
      let release
      sendNotification.mockImplementation(() => new Promise(r => { release = () => r({ statusCode: 201 }) }))
      const drain = asEnv(PROD_NO_KEY, () => processDueNotifications())
      for (let i = 0; i < 200 && !release; i++) await new Promise(r => setTimeout(r, 10))
      expect(release).toBeTypeOf('function')
      expect((await rowOf(id)).status).toBe('processing')
      release()
      await drain
      expect((await rowOf(id)).status).toBe('sent')
    } finally { clearVapid() }
  })

  it('no subscriptions, and all endpoints failing, are not sent', async () => {
    setVapid()
    try {
      const none = await parish('nosubs')
      const noneRow = await due(none, { pushOnly: true })
      const dead = await parish('deadsubs')
      await subscribe(dead, 2)
      const deadRow = await due(dead, { pushOnly: true })
      sendNotification.mockImplementation(async () => { const e = new Error('gone'); e.statusCode = 410; throw e })
      await asEnv(PROD_NO_KEY, () => processDueNotifications())
      const a = await rowOf(noneRow), b = await rowOf(deadRow)
      expect(a.status).toBe('failed')
      expect(a.error).toMatch(/^push_not_accepted: no_subscriptions/)
      expect(b.status).toBe('failed')
      expect(b.error).toMatch(/^push_not_accepted: ok/)
    } finally { clearVapid() }
  })

  it('email failure stays visible even when the companion push is accepted', async () => {
    setVapid()
    try {
      const org = await parish('emailfailpush')
      await subscribe(org)
      const id = await due(org)
      await asEnv(PROD_NO_KEY, () => processDueNotifications())
      for (let i = 0; i < 100 && pushedTo() === 0; i++) await new Promise(r => setTimeout(r, 10))
      expect(pushedTo()).toBe(1) // the companion push did go out and was accepted
      const row = await rowOf(id)
      expect(row.status).toBe('failed')
      expect(row.error).toMatch(/^unconfigured:/)
      expect((await logsOf(org)).filter(l => l.status === 'sent')).toHaveLength(0)
    } finally { clearVapid() }
  })
})

describe('R299-2 suppression', () => {
  for (const reason of ['bounce', 'complaint']) {
    it(`configured ${reason} suppression settles cancelled/suppressed, not sent, no provider call`, async () => {
      const org = await parish(`supp${reason}`)
      await pool.query(
        `INSERT INTO ochr_email_suppressions (email, reason, provider, detail) VALUES ($1, $2, 'fake', 'test')
         ON CONFLICT DO NOTHING`, [org.email, reason])
      const id = await due(org)
      const result = await asEnv(PROD_KEY, () => processDueNotifications())
      const row = await rowOf(id)
      expect(row.status).toBe('cancelled')
      expect(row.sent_at).toBeNull()
      expect(row.error).toMatch(/^suppressed:/)
      expect(row.error).not.toContain(org.email)
      expect(result.suppressed).toBeGreaterThanOrEqual(1)
      expect((await logsOf(org)).map(l => l.status)).toEqual(['suppressed'])
      expect(mailedTo(org.email)).toBe(0)
      await pool.query('DELETE FROM ochr_email_suppressions WHERE lower(email) = lower($1)', [org.email])
    })
  }
})

describe('R299-3 suppression blocks the companion push', () => {
  it('isolation: a push the global drain sends to a subscription this file did not create is not counted', async () => {
    setVapid()
    try {
      // Stands in for another test file's due push row, which the global
      // drain settles too. Its endpoint is outside OWN_ENDPOINT.
      const foreign = await parish('foreignpush')
      await pool.query(
        `INSERT INTO ochr_push_subscriptions (organization_id, user_id, endpoint, p256dh, auth)
         VALUES ($1, $2, $3, 'fake-p256dh', 'fake-auth')`,
        [foreign.id, foreign.userId, `https://push.invalid/other-file/${RUN_ID}`])
      await due(foreign, { pushOnly: true })
      await asEnv(PROD_KEY, () => processDueNotifications())
      expect(sendNotification.mock.calls.length).toBeGreaterThanOrEqual(1)
      expect(pushedTo()).toBe(0)
    } finally { clearVapid() }
  })

  for (const reason of ['bounce', 'complaint']) {
    it(`${reason}: active push subscription, neither email nor push provider called, cancelled/suppressed`, async () => {
      setVapid()
      try {
        const org = await parish(`suppush${reason}`)
        await subscribe(org)
        await pool.query(
          `INSERT INTO ochr_email_suppressions (email, reason, provider, detail) VALUES ($1, $2, 'fake', 'test')
           ON CONFLICT DO NOTHING`, [org.email, reason])
        const id = await due(org)
        const result = await asEnv(PROD_KEY, () => processDueNotifications())
        await new Promise(r => setTimeout(r, 200)) // a fire-and-forget push would have started by now
        const row = await rowOf(id)
        expect(row.status).toBe('cancelled')
        expect(row.sent_at).toBeNull()
        expect(row.error).toMatch(/^suppressed:/)
        expect(result.suppressed).toBeGreaterThanOrEqual(1)
        expect(mailedTo(org.email)).toBe(0)
        expect(pushedTo()).toBe(0)
        expect(await pushLogs(org)).toHaveLength(0)
        await pool.query('DELETE FROM ochr_email_suppressions WHERE lower(email) = lower($1)', [org.email])
      } finally { clearVapid() }
    })
  }
})

describe('P-1 configured provider', () => {
  it('provider failure: owned row settles failed/provider_failed, never sent; error redacted', async () => {
    const org = await parish('provfail')
    const id = await due(org)
    sendEmail.mockImplementation(async ({ to, subject, text }) => {
      throw new Error(`Resend send failed (422): {"to":"${to}","key":"${FAKE_SECRET}","subject":"${subject}","text":"${text}"}`)
    })
    const result = await asEnv(PROD_KEY, () => processDueNotifications())
    const row = await rowOf(id)
    expect(row.status).toBe('failed')
    expect(row.sent_at).toBeNull()
    expect(row.error).toMatch(/^provider_failed:/)
    // TARS 319 residuals: the queue error is the closed diagnostic only;
    // the echoed subject and body ('R' is the member name) do not persist.
    expect(row.error).toBe('provider_failed: provider=resend status=422')
    expect(row.error).not.toContain('birthday')
    expect(row.error).not.toContain(org.email)
    expect(row.error).not.toContain(FAKE_SECRET)
    expect(result.provider_failed).toBeGreaterThanOrEqual(1)
    const logs = await logsOf(org)
    expect(logs.map(l => l.status)).toEqual(['failed'])
    expect(logs[0].error).not.toContain(org.email)
    expect(logs[0].error).not.toContain(FAKE_SECRET)
    expectMinimizedLog(logs[0], org)
    expect(mailedTo(org.email)).toBe(1)
  })

  it('provider success: owned row settles sent with the provider id (control)', async () => {
    const org = await parish('provok')
    const id = await due(org)
    await asEnv(PROD_KEY, () => processDueNotifications())
    const row = await rowOf(id)
    expect(row.status).toBe('sent')
    expect(row.error).toBeNull()
    const logs = await logsOf(org)
    expect(logs.map(l => [l.status, l.provider_message_id])).toEqual([['sent', 'fake-provider-id']])
    expectFullLog(logs[0], org)
    expect(mailedTo(org.email)).toBe(1)
  })
})

describe('P-1 dev/test stub control', () => {
  it('outside production, no key still stubs and settles as before, zero provider calls', async () => {
    const org = await parish('devstub')
    const id = await due(org)
    await asEnv(DEV_NO_KEY, () => processDueNotifications())
    expect((await rowOf(id)).status).toBe('sent')
    const stubLogs = await logsOf(org)
    expect(stubLogs.map(l => l.status)).toEqual(['stubbed'])
    expectFullLog(stubLogs[0], org)
    expect(mailedTo(org.email)).toBe(0)
  })
})
