// TARS 319 residuals (#62 comment 6255928935; #319 review 6255927571): the
// three copies #319 left open, as one bounded follow-up on transport.js:
//   (1) the provider-failure detail notify() returns, which the scheduler
//       persists as the queue row's error (the queued case is asserted in
//       notifyUnconfiguredP1.test.js, which owns the drains);
//   (2) the notify.dispatch monitor event, and so any forwarded Sentry event;
//   (3) NEW production push-only failed log rows (no subject or body).
// Status, reason, queue accounting, provider calls, admission, retries and
// sent controls are unchanged. Older rows are not touched.
//
// Real local Postgres, synthetic sentinels, fake email + web-push providers
// and a fake Sentry client; no key is real and nothing leaves the box. This
// file calls notify() directly and never runs the global queue drain.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import 'dotenv/config'

const { sendEmail, sendNotification } = vi.hoisted(() => ({
  sendEmail: vi.fn(async () => ({ id: 'fake-provider-id' })),
  sendNotification: vi.fn(async () => ({ statusCode: 201 })),
}))
vi.mock('../src/email/send.js', async (orig) => ({ ...(await orig()), sendEmail }))
vi.mock('web-push', () => ({ default: { setVapidDetails: vi.fn(), sendNotification } }))

import pool from '../src/db.js'
import { monitor, _setSentryForTests } from '../src/monitoring/index.js'
import { RUN_ID, migrateOnce } from './support/harness.js'
import { notify } from '../src/notifications/transport.js'

const orgs = []
const ENV = ['RESEND_API_KEY', 'NODE_ENV', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY']
const saved = {}
let n = 0
const DIAG = 'provider_failed: provider=resend status=422'

function sentinels(tag) {
  const k = `${RUN_ID}_${tag}_${n++}`.toLowerCase()
  const words = k.split('_').join(' ')
  return {
    addr: `rs.addr.${k}@sentinel-mail.example.com`,
    subj: `Subjres ${words}`,
    body: `Private residual note for Synthetic Alice ${words}`,
  }
}
const vars = s => ({ member_name: s.subj, recipient_name: s.body, birthday_date: 'Jan 1' })
async function parish(tag, addr) {
  const o = await pool.query(
    `INSERT INTO ochr_organizations (name, slug, org_type, tradition)
     VALUES ($1, $2, 'parish', 'episcopal') RETURNING id`,
    [`FLR ${tag} ${RUN_ID}`, `flr-${tag}-${RUN_ID}`.toLowerCase().replace(/_/g, '-')])
  orgs.push(o.rows[0].id)
  const u = await pool.query(
    `INSERT INTO ochr_users (organization_id, name, email, password_hash, role)
     VALUES ($1, 'FLR Admin', $2, 'x', 'admin') RETURNING id`, [o.rows[0].id, addr])
  return { id: o.rows[0].id, userId: u.rows[0].id }
}
const logsOf = async (org, channel) => (await pool.query(
  `SELECT recipient_email, channel, subject, body, status, error, row_to_json(l)::text AS whole
     FROM ochr_notification_log l
    WHERE organization_id = $1 AND notification_type = 'member_birthday' AND channel = $2
    ORDER BY id`, [org.id, channel])).rows
const asEnv = async (env, fn) => {
  const prev = { k: process.env.RESEND_API_KEY, n: process.env.NODE_ENV }
  if (env.key === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = env.key
  process.env.NODE_ENV = env.nodeEnv
  try { return await fn() } finally {
    if (prev.k === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = prev.k
    process.env.NODE_ENV = prev.n
  }
}
const PROD_KEY = { key: 'fake-key-not-used', nodeEnv: 'production' }
const PROD_NO_KEY = { key: undefined, nodeEnv: 'production' }
const lacks = (text, s) => {
  const t = String(text).toLowerCase()
  for (const v of [s.addr, s.subj, s.body]) expect(t).not.toContain(v.toLowerCase())
  expect(t).not.toContain('private residual note')
}

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k]
  delete process.env.VAPID_PUBLIC_KEY; delete process.env.VAPID_PRIVATE_KEY
  await migrateOnce()
}, 60_000)
afterEach(() => {
  vi.restoreAllMocks()
  sendEmail.mockReset(); sendEmail.mockImplementation(async () => ({ id: 'fake-provider-id' }))
  sendNotification.mockReset(); sendNotification.mockImplementation(async () => ({ statusCode: 201 }))
})
afterAll(async () => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  for (const id of orgs) await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
  await pool.end()
})

describe('(1)+(2) provider failure: returned detail and monitor/Sentry events are closed', () => {
  it('a full message echo reaches neither the detail nor notify.dispatch nor Sentry; status/reason unchanged', async () => {
    const s = sentinels('mon')
    const org = await parish('mon', s.addr)
    sendEmail.mockImplementation(async ({ to, subject, text }) => {
      throw new Error(`Resend send failed (422): {"to":"${to}","subject":"${subject}","text":"${text}"}`)
    })
    const errSpy = vi.spyOn(monitor, 'error')
    const captured = []
    const restoreSentry = _setSentryForTests({ captureException: (e, ctx) => captured.push({ message: e?.message, stack: e?.stack, ctx }) })
    let res
    try {
      res = await asEnv(PROD_KEY, () => notify({
        organizationId: org.id, userId: org.userId, recipient: s.addr,
        notification_type: 'member_birthday', vars: vars(s),
      }))
    } finally { restoreSentry() }
    expect(res.status).toBe('failed')
    expect(res.reason).toBe('provider_failed')
    expect(res.detail).toBe(DIAG)
    expect(sendEmail).toHaveBeenCalledTimes(1)
    expect(sendEmail.mock.calls[0][0].text).toContain(s.body) // the provider still got the message
    const mine = errSpy.mock.calls.filter(([scope]) => scope === 'notify.dispatch')
    expect(mine).toHaveLength(1)
    expect(mine[0][1].message).toBe(DIAG)
    lacks(JSON.stringify({ msg: mine[0][1].message, stack: mine[0][1].stack, ctx: mine[0][2] }), s)
    const ev = captured.filter(c => c.ctx?.tags?.scope === 'notify.dispatch')
    expect(ev).toHaveLength(1)
    expect(ev[0].message).toBe(DIAG)
    lacks(JSON.stringify(ev[0]), s)
    const logs = await logsOf(org, 'email')
    expect(logs).toHaveLength(1)
    expect(logs[0].error).toBe(DIAG)
    lacks(logs[0].whole, s)
  })

  it('control: a provider success has no detail and logs no notify.dispatch event', async () => {
    const s = sentinels('ok')
    const org = await parish('ok', s.addr)
    const errSpy = vi.spyOn(monitor, 'error')
    const res = await asEnv(PROD_KEY, () => notify({
      organizationId: org.id, userId: org.userId, recipient: s.addr,
      notification_type: 'member_birthday', vars: vars(s),
    }))
    expect(res.status).toBe('sent')
    expect(res.detail).toBeUndefined()
    expect(errSpy.mock.calls.filter(([scope]) => scope === 'notify.dispatch')).toHaveLength(0)
    const logs = await logsOf(org, 'email')
    expect(logs[0]).toMatchObject({ status: 'sent', recipient_email: s.addr })
    expect(logs[0].body).toContain(s.body)
  })
})

describe('(3) production push-only rows', () => {
  // push.js caches VAPID configuration once set: the missing-VAPID case runs first.
  it('not accepted (no VAPID): failed push row has no subject or body; status/reason/detail unchanged', async () => {
    const s = sentinels('pushfail')
    const org = await parish('pushfail', s.addr)
    const res = await asEnv(PROD_NO_KEY, () => notify({
      organizationId: org.id, userId: org.userId, recipient: null,
      notification_type: 'member_birthday', vars: vars(s),
    }))
    expect(res).toMatchObject({ status: 'failed', channel: 'push', reason: 'push_not_accepted',
      detail: 'push_not_accepted: no_vapid_configured' })
    const logs = await logsOf(org, 'push')
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ status: 'failed', recipient_email: null, subject: null, body: null,
      error: 'push_not_accepted: no_vapid_configured' })
    lacks(logs[0].whole, s)
  })

  it('not accepted (every endpoint fails): failed push row has no subject or body', async () => {
    process.env.VAPID_PUBLIC_KEY = 'fake-vapid-public'; process.env.VAPID_PRIVATE_KEY = 'fake-vapid-private'
    const s = sentinels('pushdead')
    const org = await parish('pushdead', s.addr)
    await pool.query(
      `INSERT INTO ochr_push_subscriptions (organization_id, user_id, endpoint, p256dh, auth)
       VALUES ($1, $2, $3, 'fake-p256dh', 'fake-auth')`, [org.id, org.userId, `https://push.invalid/flr/${RUN_ID}/dead`])
    sendNotification.mockImplementation(async () => { const e = new Error('gone'); e.statusCode = 410; throw e })
    const res = await asEnv(PROD_NO_KEY, () => notify({
      organizationId: org.id, userId: org.userId, recipient: null,
      notification_type: 'member_birthday', vars: vars(s),
    }))
    expect(res).toMatchObject({ status: 'failed', reason: 'push_not_accepted' })
    const logs = await logsOf(org, 'push')
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ status: 'failed', subject: null, body: null })
    lacks(logs[0].whole, s)
  })

  it('control: an accepted push keeps its subject and body', async () => {
    const s = sentinels('pushok')
    const org = await parish('pushok', s.addr)
    await pool.query(
      `INSERT INTO ochr_push_subscriptions (organization_id, user_id, endpoint, p256dh, auth)
       VALUES ($1, $2, $3, 'fake-p256dh', 'fake-auth')`, [org.id, org.userId, `https://push.invalid/flr/${RUN_ID}/ok`])
    const res = await asEnv(PROD_NO_KEY, () => notify({
      organizationId: org.id, userId: org.userId, recipient: null,
      notification_type: 'member_birthday', vars: vars(s),
    }))
    expect(res).toMatchObject({ status: 'sent', channel: 'push' })
    const logs = await logsOf(org, 'push')
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ status: 'sent', error: null })
    expect(logs[0].subject).toContain(s.subj)
    expect(logs[0].body).toContain(s.body)
  })
})
