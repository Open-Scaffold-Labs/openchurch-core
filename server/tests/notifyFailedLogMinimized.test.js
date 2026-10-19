// TARS 317-a (#62 comment 6255613442, #317 review 6255605786): a NEW
// unconfigured or provider-failed email notification-log row must not
// persist the raw recipient, subject or body. It keeps tenant, user, type,
// channel, status and a redacted error, and stores the recipient only as
// maskEmail() output. Delivery, admission, provider calls, queue outcome
// and counters, sent/stub rows and retries are unchanged; the controls
// below pin that.
//
// Real local Postgres, synthetic sentinel content, faked email transport;
// no provider key is used and nothing leaves the box. Every assertion is on
// rows this file owns (its own organizations and users). This file calls
// notify() directly and never runs the global queue drain, so it cannot
// settle another file's due rows; the queued-path counterparts live in
// notifyUnconfiguredP1.test.js, which already owns those drains.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

const { sendEmail } = vi.hoisted(() => ({
  sendEmail: vi.fn(async () => ({ id: 'fake-provider-id' })),
}))
vi.mock('../src/email/send.js', async (orig) => ({ ...(await orig()), sendEmail }))

import pool from '../src/db.js'
import { signToken } from '../src/middleware/auth.js'
import { maskEmail } from '../src/utils/redact.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { notify, failureDiagnostic, UNCONFIGURED_ERROR } from '../src/notifications/transport.js'

let server
const orgs = []
const ENV = ['RESEND_API_KEY', 'NODE_ENV', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY']
const saved = {}
let n = 0

// Sentinels: unique per run and per case, so a match can only come from
// this file's own content.
function sentinels(tag) {
  const k = `${RUN_ID}_${tag}_${n++}`.toLowerCase()
  // Subject/body sentinels are space-separated short words on purpose:
  // scrubText() already redacts any 20+ character token, so a long
  // sentinel would be hidden by it and would not test the echo removal.
  const words = k.split('_').join(' ')
  return {
    addr: `fl.addr.${k}@sentinel-mail.example.com`,
    subj: `Subjsent ${words}`, // rendered into subject (and body)
    body: `Bodysent ${words}`, // rendered into body only
  }
}
const vars = s => ({ member_name: s.subj, recipient_name: s.body, birthday_date: 'Jan 1' })

async function parish(tag, addr) {
  const o = await pool.query(
    `INSERT INTO ochr_organizations (name, slug, org_type, tradition)
     VALUES ($1, $2, 'parish', 'episcopal') RETURNING id`,
    [`FLM ${tag} ${RUN_ID}`, `flm-${tag}-${RUN_ID}`.toLowerCase().replace(/_/g, '-')])
  const orgId = o.rows[0].id
  orgs.push(orgId)
  const u = await pool.query(
    `INSERT INTO ochr_users (organization_id, name, email, password_hash, role)
     VALUES ($1, 'FLM Admin', $2, 'x', 'admin') RETURNING id, token_version`, [orgId, addr])
  const token = signToken({ userId: u.rows[0].id, organizationId: orgId, email: addr,
    name: 'FLM Admin', role: 'admin', tv: u.rows[0].token_version })
  return { id: orgId, userId: u.rows[0].id, token }
}
const ownLogs = async org => (await pool.query(
  `SELECT organization_id, user_id, recipient_email, notification_type, channel,
          subject, body, status, error, provider_message_id, row_to_json(l)::text AS whole
     FROM ochr_notification_log l
    WHERE organization_id = $1 AND notification_type = 'member_birthday' AND channel = 'email'
    ORDER BY id`, [org.id])).rows
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
const DEV_NO_KEY = { key: undefined, nodeEnv: 'test' }
const echoingFailure = () => sendEmail.mockImplementation(async ({ to, subject, text }) => {
  throw new Error(`Resend send failed (422): to=${to} subject=${subject} text=${text}`)
})

// The minimized shape, asserted on every column and on the whole row.
function expectMinimized(log, org, s) {
  expect(log.organization_id).toBe(org.id)
  expect(log.user_id).toBe(org.userId)
  expect(log.notification_type).toBe('member_birthday')
  expect(log.channel).toBe('email')
  expect(log.status).toBe('failed')
  expect(log.recipient_email).toBe(maskEmail(s.addr))
  expect(log.subject).toBeNull()
  expect(log.body).toBeNull()
  const whole = log.whole.toLowerCase()
  expect(whole).not.toContain(s.addr.toLowerCase())
  expect(whole).not.toContain(s.subj.toLowerCase())
  expect(whole).not.toContain(s.body.toLowerCase())
}

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k]
  delete process.env.VAPID_PUBLIC_KEY; delete process.env.VAPID_PRIVATE_KEY
  await migrateOnce()
  server = await bindServer()
}, 60_000)
afterEach(() => { sendEmail.mockReset(); sendEmail.mockImplementation(async () => ({ id: 'fake-provider-id' })) })
afterAll(async () => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  for (const id of orgs) await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
  await closeServer(server)
  await pool.end()
})

describe('TARS 317-a: failed log rows are minimized', () => {
  it('unconfigured (direct notify): no raw address/subject/body; return value unchanged; zero provider calls', async () => {
    const s = sentinels('unconf')
    const org = await parish('unconf', s.addr)
    const res = await asEnv(PROD_NO_KEY, () => notify({
      organizationId: org.id, userId: org.userId, recipient: s.addr,
      notification_type: 'member_birthday', vars: vars(s),
    }))
    expect(res).toMatchObject({ status: 'failed', reason: 'unconfigured', detail: UNCONFIGURED_ERROR })
    const logs = await ownLogs(org)
    expect(logs).toHaveLength(1)
    expectMinimized(logs[0], org, s)
    expect(logs[0].error).toBe(UNCONFIGURED_ERROR)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('provider failure (direct notify): echoed address/subject/body are not stored; provider called once', async () => {
    const s = sentinels('provfail')
    const org = await parish('provfail', s.addr)
    echoingFailure()
    const res = await asEnv(PROD_KEY, () => notify({
      organizationId: org.id, userId: org.userId, recipient: s.addr,
      notification_type: 'member_birthday', vars: vars(s),
    }))
    expect(res.status).toBe('failed')
    expect(res.reason).toBe('provider_failed')
    expect(sendEmail).toHaveBeenCalledTimes(1)
    // The provider still received the full message; only the log changed.
    const [msg] = sendEmail.mock.calls[0]
    expect(msg.to).toBe(s.addr)
    expect(msg.subject).toContain(s.subj)
    expect(msg.text).toContain(s.body)
    const logs = await ownLogs(org)
    expect(logs).toHaveLength(1)
    expectMinimized(logs[0], org, s)
    // R319-1: closed diagnostic only. TARS 319 residuals: the returned
    // detail (persisted as the queue error) is the same closed diagnostic.
    expect(logs[0].error).toBe('provider_failed: provider=resend status=422')
    expect(res.detail).toBe('provider_failed: provider=resend status=422')
  })

  it('admin log reader shows the masked marker, no subject, the status and the error', async () => {
    const s = sentinels('reader')
    const org = await parish('reader', s.addr)
    await asEnv(PROD_NO_KEY, () => notify({
      organizationId: org.id, userId: org.userId, recipient: s.addr,
      notification_type: 'member_birthday', vars: vars(s),
    }))
    const res = await request(server).get('/api/admin/notifications/log')
      .set('Authorization', `Bearer ${org.token}`)
    expect(res.status).toBe(200)
    const mine = res.body.log.filter(l => l.notification_type === 'member_birthday')
    expect(mine).toHaveLength(1)
    expect(mine[0]).toMatchObject({
      recipient_email: maskEmail(s.addr), channel: 'email', subject: null,
      status: 'failed', error: UNCONFIGURED_ERROR,
    })
    expect(JSON.stringify(res.body)).not.toContain(s.addr)
  })
})

// R319-1 (TARS #319 comment 6255927571): an exact provider echo of the
// full message must leave nothing in the stored row, including when the
// echo is truncated, when the subject sits inside the body, and when
// scrubText() rewrites an email or URL inside the body.
describe('R319-1: exact provider echoes leave no message content', () => {
  const short = () => sentinels('x').body.split(' ').slice(1).join(' ')
  const fullEcho = () => sendEmail.mockImplementation(async ({ subject, text }) => {
    throw new Error(`Resend send failed (422): {"subject":"${subject}","text":"${text}"}`)
  })
  async function failWith(tag, v) {
    const s = sentinels(tag)
    const org = await parish(tag, s.addr)
    fullEcho()
    const res = await asEnv(PROD_KEY, () => notify({
      organizationId: org.id, userId: org.userId, recipient: s.addr,
      notification_type: 'member_birthday', vars: { birthday_date: 'Jan 1', ...v },
    }))
    expect(res).toMatchObject({ status: 'failed', reason: 'provider_failed' })
    expect(sendEmail).toHaveBeenCalledTimes(1)
    const logs = await ownLogs(org)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({
      organization_id: org.id, user_id: org.userId, notification_type: 'member_birthday',
      channel: 'email', status: 'failed', recipient_email: maskEmail(s.addr), subject: null, body: null,
    })
    expect(logs[0].whole.toLowerCase()).not.toContain(s.addr.toLowerCase())
    return { log: logs[0], res, msg: sendEmail.mock.calls[0][0] }
  }

  it('long body echo truncated at 500 characters: no fragment survives', async () => {
    const k = short()
    const phrase = `Private pastoral note about Synthetic Alice Ruiz ${k}.`
    const { log, res, msg } = await failWith('long', { member_name: `Synthetic Bob ${k}`, recipient_name: Array(20).fill(phrase).join(' ') })
    expect(msg.text.length).toBeGreaterThan(1000) // the provider saw the whole body
    expect(res.detail).toBe('provider_failed: provider=resend status=422') // residuals: closed detail
    expect(log.whole).not.toContain('Private pastoral note')
    expect(log.whole).not.toContain('Synthetic Alice Ruiz')
    expect(log.whole).not.toContain(k)
    expect(log.error).toBe('provider_failed: provider=resend status=422')
  })

  it('subject inside the body: overlapping echo leaves neither', async () => {
    const k = short()
    const member = `Synthetic Jane Smith ${k}`
    const subject = `Tomorrow: ${member}’s birthday`
    const { log, msg } = await failWith('overlap', {
      member_name: member, recipient_name: `${subject} Private care for Synthetic Alice Ruiz ${k}.`,
    })
    expect(msg.subject).toBe(subject)
    expect(msg.text).toContain(subject)
    expect(log.whole).not.toContain('Private care for Synthetic Alice Ruiz')
    expect(log.whole).not.toContain('Synthetic Jane Smith')
    expect(log.whole).not.toContain(k)
    expect(log.error).toBe('provider_failed: provider=resend status=422')
  })

  it('scrubText-altered body (email and URL inside it): no remaining words survive', async () => {
    const k = short()
    const { log, res } = await failWith('scrub', {
      member_name: `Synthetic Carol ${k}`,
      recipient_name: `write pastor.private.${k.split(' ').join('')}@sentinel-church.example.org or https://sentinel.example.org/care/${k.split(' ').join('')} Confidential sentinel words ${k}`,
    })
    expect(res.detail).toBe('provider_failed: provider=resend status=422') // residuals: closed detail
    expect(log.whole).not.toContain('Confidential sentinel words')
    expect(log.whole).not.toContain('sentinel-church')
    expect(log.whole).not.toContain('sentinel.example.org')
    expect(log.whole).not.toContain(k)
    expect(log.error).toBe('provider_failed: provider=resend status=422')
  })

  it('non-sensitive diagnostic control: allowlisted parts only', () => {
    expect(failureDiagnostic(new Error('Resend send failed (503): upstream'))).toBe('provider_failed: provider=resend status=503')
    expect(failureDiagnostic(new Error('Resend send failed (422): '))).toBe('provider_failed: provider=resend status=422')
    // the prefix must start the message; a status must be 1xx-5xx
    expect(failureDiagnostic(new Error('echo Resend send failed (422): x'))).toBe('provider_failed: unclassified')
    expect(failureDiagnostic(new Error('Resend send failed (999): x'))).toBe('provider_failed: unclassified')
    expect(failureDiagnostic(Object.assign(new Error('connect timed out to secret.example.org'), { code: 'ETIMEDOUT' })))
      .toBe('provider_failed: code=ETIMEDOUT')
    expect(failureDiagnostic(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })))
      .toBe('provider_failed: code=ECONNRESET')
    expect(failureDiagnostic(Object.assign(new Error('x'), { code: 'ESENTINEL_PRIVATE' }))).toBe('provider_failed: unclassified')
    expect(failureDiagnostic('a bare string with Private words')).toBe('provider_failed: unclassified')
    expect(failureDiagnostic(null)).toBe('provider_failed: unclassified')
  })

  it('a network-coded failure stores only the code', async () => {
    const s = sentinels('code')
    const org = await parish('code', s.addr)
    sendEmail.mockImplementation(async ({ text }) => {
      throw Object.assign(new Error(`socket closed while sending ${text}`), { code: 'ECONNRESET' })
    })
    const res = await asEnv(PROD_KEY, () => notify({
      organizationId: org.id, userId: org.userId, recipient: s.addr,
      notification_type: 'member_birthday', vars: vars(s),
    }))
    expect(res.reason).toBe('provider_failed')
    const logs = await ownLogs(org)
    expect(logs).toHaveLength(1)
    expectMinimized(logs[0], org, s)
    expect(logs[0].error).toBe('provider_failed: code=ECONNRESET')
  })
})

describe('TARS 317-a controls: non-failed rows unchanged', () => {
  it('provider success keeps the raw recipient, subject, body and provider id', async () => {
    const s = sentinels('sent')
    const org = await parish('sent', s.addr)
    const res = await asEnv(PROD_KEY, () => notify({
      organizationId: org.id, userId: org.userId, recipient: s.addr,
      notification_type: 'member_birthday', vars: vars(s),
    }))
    expect(res.status).toBe('sent')
    const logs = await ownLogs(org)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ status: 'sent', recipient_email: s.addr, provider_message_id: 'fake-provider-id' })
    expect(logs[0].subject).toContain(s.subj)
    expect(logs[0].body).toContain(s.body)
  })

  it('dev/test stub keeps the raw recipient, subject and body, zero provider calls', async () => {
    const s = sentinels('stub')
    const org = await parish('stub', s.addr)
    const res = await asEnv(DEV_NO_KEY, () => notify({
      organizationId: org.id, userId: org.userId, recipient: s.addr,
      notification_type: 'member_birthday', vars: vars(s),
    }))
    expect(res.status).toBe('stubbed')
    const logs = await ownLogs(org)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ status: 'stubbed', recipient_email: s.addr })
    expect(logs[0].subject).toContain(s.subj)
    expect(logs[0].body).toContain(s.body)
    expect(sendEmail).not.toHaveBeenCalled()
  })
})
