// Email deliverability — the parts that decide whether a message arrives
// and whether the log tells the truth about it.
//
// Three things are under test here and they share a theme: the app was
// able to report success while a real person received nothing. notify()
// wrote 'sent' the moment the provider accepted the message, and a
// provider accepts mail for a mailbox that has not existed for a year.
// There was no unsubscribe header, so the only way to stop a reminder was
// to find a settings page, and the mail clients that look for that header
// score its absence against the sending domain — which every parish
// shares. And a bounce had nowhere to land, so nothing ever corrected the
// record.
//
// The assertions below are mostly about the negative case: what must NOT
// happen when a token is forged, a signature is wrong, or an address is
// known-dead.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
import { RUN_ID, app, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { signUnsubscribe, verifyUnsubscribe } from '../src/notifications/unsubscribeToken.js'
import { notify } from '../src/notifications/transport.js'

let server
let orgId, userId, userEmail

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()

  const signup = await request(server).post('/api/auth/signup')
    .set('X-Forwarded-For', '10.99.44.11')
    .send({
      organizationName: `Email Parish ${RUN_ID}`,
      name: 'Deliverability Admin',
      email: `email_${RUN_ID}@example.com`,
      password: 'smoke-test-pw-411',
    })
  expect(signup.status).toBe(201)

  // Straight from the row rather than from the API response shape: this
  // file is testing the notification path, and it should not fail because
  // /me reorganised where it nests the organisation id.
  const { rows } = await pool.query(
    `SELECT id, email, organization_id FROM ochr_users WHERE email = $1`,
    [`email_${RUN_ID}@example.com`]
  )
  expect(rows).toHaveLength(1)
  userId    = rows[0].id
  orgId     = rows[0].organization_id
  userEmail = rows[0].email
  expect(userId).toBeGreaterThan(0)
  expect(orgId).toBeGreaterThan(0)
}, 60_000)

afterAll(async () => {
  await closeServer(server)
  await pool.end()
})

// Read a pref directly. The absence of a row means enabled — the merged
// shape the API returns would hide the difference, and here the
// difference is the point.
async function storedPref(type) {
  const { rows } = await pool.query(
    `SELECT enabled FROM ochr_notification_prefs
      WHERE user_id = $1 AND notification_type = $2`,
    [userId, type]
  )
  return rows.length ? rows[0].enabled : null
}

async function lastLog(type) {
  const { rows } = await pool.query(
    `SELECT * FROM ochr_notification_log
      WHERE organization_id = $1 AND notification_type = $2
      ORDER BY id DESC LIMIT 1`,
    [orgId, type]
  )
  return rows[0] ?? null
}

// Run one notify() against a stubbed live transport and hand back what
// the provider would have received. Nothing here talks to the network:
// fetch is replaced, and RESEND_API_KEY is only set for the duration of
// the call so no other test in this file drifts into live mode.
async function captureSend(args) {
  const calls = []
  const priorKey = process.env.RESEND_API_KEY
  process.env.RESEND_API_KEY = 'test-key-not-real'
  vi.stubGlobal('fetch', async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return { ok: true, status: 200, json: async () => ({ id: `prov_${calls.length}` }) }
  })
  try {
    const result = await notify(args)
    return { result, sent: calls[0]?.body ?? null, calls }
  } finally {
    vi.unstubAllGlobals()
    if (priorKey === undefined) delete process.env.RESEND_API_KEY
    else process.env.RESEND_API_KEY = priorKey
  }
}

describe('unsubscribe tokens', () => {
  it('ROUND-TRIPS, AND REFUSES EVERY MUTATION OF ITSELF', () => {
    const token = signUnsubscribe(userId, 'task_due_reminder')
    expect(verifyUnsubscribe(token)).toEqual({
      userId, notificationType: 'task_due_reminder',
    })

    // Each of these is something a stranger can actually type.
    expect(verifyUnsubscribe(`x${token}`)).toBeNull()
    expect(verifyUnsubscribe(token.slice(0, -2) + 'ZZ')).toBeNull()
    expect(verifyUnsubscribe(token.split('.')[0])).toBeNull()
    expect(verifyUnsubscribe('')).toBeNull()
    expect(verifyUnsubscribe(null)).toBeNull()
    expect(verifyUnsubscribe(undefined)).toBeNull()
    expect(verifyUnsubscribe({})).toBeNull()
    expect(verifyUnsubscribe('....')).toBeNull()
  })

  it('CANNOT BE RE-POINTED AT ANOTHER USER', () => {
    // The interesting forgery isn't random noise — it's taking your own
    // valid token and editing the user id inside it. The MAC covers the
    // payload, so the edit invalidates it; if the payload were ever
    // trusted before verification, this is the test that would notice.
    const mine = signUnsubscribe(userId, 'task_due_reminder')
    const [body, mac] = mine.split('.')
    const decoded = Buffer.from(body, 'base64url').toString('utf8')
    const forged  = decoded.replace(/^\d+:/, `${userId + 1}:`)
    const token   = `${Buffer.from(forged).toString('base64url')}.${mac}`

    expect(verifyUnsubscribe(token)).toBeNull()
  })
})

describe('one-click unsubscribe endpoint', () => {
  const TYPE = 'task_due_reminder'

  it('GET SHOWS A PAGE AND CHANGES NOTHING', async () => {
    // Mail scanners and link-preview bots fetch every URL in a message.
    // If GET carried the side effect they would opt people out silently,
    // and "I stopped getting reminders and never touched anything" is
    // close to undiagnosable.
    const token = signUnsubscribe(userId, TYPE)
    const res = await request(server).get(`/api/unsubscribe/${token}`)
    expect(res.status).toBe(200)
    expect(res.text).toContain('Unsubscribe from these emails?')
    expect(await storedPref(TYPE)).toBeNull()
  })

  it('POST TURNS THE PREFERENCE OFF', async () => {
    const token = signUnsubscribe(userId, TYPE)
    const res = await request(server).post(`/api/unsubscribe/${token}`)
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(await storedPref(TYPE)).toBe(false)
  })

  it('AND THE PREFERENCE IT WRITES ACTUALLY STOPS THE MAIL', async () => {
    // A working endpoint that writes a row nobody reads would pass every
    // test above and still send the email.
    const { result, calls } = await captureSend({
      organizationId: orgId, userId, recipient: userEmail,
      notification_type: TYPE, vars: { title: 'x', due: 'tomorrow' },
    })
    expect(result.status).toBe('skipped')
    expect(calls).toHaveLength(0)
  })

  it('REFUSES A FORGED TOKEN WITHOUT WRITING ANYTHING', async () => {
    const other = 'swap_requested'
    const good  = signUnsubscribe(userId, other)
    const bad   = good.slice(0, -2) + 'ZZ'

    const res = await request(server).post(`/api/unsubscribe/${bad}`)
    expect(res.status).toBe(400)
    expect(await storedPref(other)).toBeNull()
  })
})

describe('List-Unsubscribe headers', () => {
  it('RIDE ON THE MESSAGE, POINTING AT THE API AND NOT THE CLIENT', async () => {
    const { sent } = await captureSend({
      organizationId: orgId, userId, recipient: userEmail,
      notification_type: 'swap_requested',
      vars: { requester: 'A', role: 'Lector', date: 'Sunday' },
    })
    expect(sent).toBeTruthy()
    expect(sent.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')

    const header = sent.headers['List-Unsubscribe']
    expect(header).toMatch(/^<https?:\/\/.+\/api\/unsubscribe\/.+>$/)

    // The header is only worth having if the link in it resolves.
    const token = header.replace(/^<|>$/g, '').split('/api/unsubscribe/')[1]
    expect(verifyUnsubscribe(token)).toEqual({
      userId, notificationType: 'swap_requested',
    })
  })

  it('ARE OMITTED RATHER THAN SENT RELATIVE WHEN BASE_URL IS UNUSABLE', async () => {
    // vitest sets BASE_URL="/" for its own reasons, which the first cut of
    // this code turned into an empty base and a header reading
    // </api/unsubscribe/…>. A mail client has nothing to resolve that
    // against, so the link is dead while the header still advertises
    // one-click support — the worst of both. In production the honest
    // answer is no header; anywhere else a localhost default is useful.
    const priorBase = process.env.BASE_URL
    const priorEnv  = process.env.NODE_ENV
    process.env.BASE_URL  = '/'
    process.env.NODE_ENV  = 'production'
    try {
      const { sent } = await captureSend({
        organizationId: orgId, userId, recipient: userEmail,
        notification_type: 'member_birthday',
        vars: { name: 'Someone', date: 'today' },
      })
      expect(sent).toBeTruthy()
      expect(sent.headers).toBeUndefined()
    } finally {
      if (priorBase === undefined) delete process.env.BASE_URL
      else process.env.BASE_URL = priorBase
      if (priorEnv === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = priorEnv
    }
  })

  it('ARE OMITTED WHEN THERE IS NO USER TO UNSUBSCRIBE', async () => {
    // An anonymous recipient has no prefs row, so a link would render a
    // page promising something it cannot do. No header beats a broken one.
    const { sent } = await captureSend({
      organizationId: orgId, userId: null,
      recipient: `anon_${RUN_ID}@example.com`,
      notification_type: 'donation_receipt',
      vars: { amount: '$10', fund: 'General', date: 'today' },
    })
    expect(sent).toBeTruthy()
    expect(sent.headers).toBeUndefined()
  })
})

// ── Bounce and complaint handling ──────────────────────────────────

import crypto from 'node:crypto'
import { suppress, unsuppress, suppressionFor } from '../src/email/suppression.js'

const WEBHOOK_SECRET_B64 = Buffer.from('unit-test-webhook-signing-key').toString('base64')

// Build a request the way Svix does, so the test exercises the real
// verifier rather than a bypass. Anything that fakes its way past the
// signature here would fake its way past it in production too.
function signedWebhook(payload, { secret = WEBHOOK_SECRET_B64, skewSeconds = 0 } = {}) {
  const body = JSON.stringify(payload)
  const id   = `msg_${Math.random().toString(36).slice(2, 10)}`
  const ts   = String(Math.floor(Date.now() / 1000) + skewSeconds)
  const sig  = crypto.createHmac('sha256', Buffer.from(secret, 'base64'))
    .update(`${id}.${ts}.${body}`)
    .digest('base64')
  return {
    body,
    headers: { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` },
  }
}

function post(server, { body, headers }) {
  return request(server)
    .post('/api/email/webhook')
    .set({ ...headers, 'Content-Type': 'application/json' })
    .send(body)
}

describe('email suppression', () => {
  const dead = `dead_${RUN_ID}@example.com`

  it('IS IDEMPOTENT AND KEEPS THE FIRST REASON', async () => {
    // Webhooks retry. A redelivered bounce must be a no-op, and a bounce
    // arriving after a complaint must not downgrade the record — the
    // complaint is the stronger statement and the earlier truth.
    const first = await suppress({ email: dead, reason: 'complaint', provider: 'resend' })
    expect(first.created).toBe(true)

    const again = await suppress({ email: dead, reason: 'bounce', provider: 'resend' })
    expect(again.created).toBe(false)

    const row = await suppressionFor(dead)
    expect(row.reason).toBe('complaint')

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ochr_email_suppressions WHERE lower(email) = $1`,
      [dead.toLowerCase()]
    )
    expect(rows[0].n).toBe(1)
  })

  it('MATCHES REGARDLESS OF CASE', async () => {
    // A secretary typing Maria@… must not slip past a suppression
    // recorded against maria@… — that is a re-send to a dead mailbox
    // caused purely by capitalisation.
    expect(await suppressionFor(dead.toUpperCase())).toBeTruthy()
  })

  it('BLOCKS THE SEND AND SAYS SO IN THE LOG', async () => {
    const { result, calls } = await captureSend({
      organizationId: orgId, userId: null, recipient: dead,
      notification_type: 'donation_receipt',
      vars: { amount: '$5', fund: 'General', date: 'today' },
    })
    expect(calls).toHaveLength(0)            // nothing reached the provider
    expect(result.status).toBe('suppressed') // and the log is explicit
    const row = await lastLog('donation_receipt')
    expect(row.status).toBe('suppressed')
    expect(row.error).toContain('complaint')
  })

  it('LIFTS ONLY WHEN SOMETHING LIFTS IT', async () => {
    expect((await unsuppress(dead)).removed).toBe(true)
    expect(await suppressionFor(dead)).toBeNull()
  })
})

describe('delivery webhook', () => {
  const bouncer = `bounce_${RUN_ID}@example.com`
  let priorSecret

  beforeAll(() => {
    priorSecret = process.env.RESEND_WEBHOOK_SECRET
    process.env.RESEND_WEBHOOK_SECRET = `whsec_${WEBHOOK_SECRET_B64}`
  })
  afterAll(() => {
    if (priorSecret === undefined) delete process.env.RESEND_WEBHOOK_SECRET
    else process.env.RESEND_WEBHOOK_SECRET = priorSecret
  })

  const hardBounce = (email, messageId) => ({
    type: 'email.bounced',
    id: `evt_${Math.random().toString(36).slice(2, 8)}`,
    data: { email_id: messageId, to: [email], bounce: { type: 'Permanent', message: 'mailbox does not exist' } },
  })

  it('REJECTS AN UNSIGNED REQUEST AND SUPPRESSES NOTHING', async () => {
    // This is the one that matters. The endpoint is public and can stop a
    // parish's email; if a stranger's POST could suppress an address, the
    // fix for deliverability would have opened a denial of service.
    const res = await request(server).post('/api/email/webhook')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(hardBounce(bouncer, null)))
    expect(res.status).toBe(400)
    expect(await suppressionFor(bouncer)).toBeNull()
  })

  it('REJECTS A TAMPERED SIGNATURE AND SUPPRESSES NOTHING', async () => {
    const signed = signedWebhook(hardBounce(bouncer, null))
    signed.headers['svix-signature'] = signed.headers['svix-signature'].slice(0, -3) + 'AAA'
    const res = await post(server, signed)
    expect(res.status).toBe(400)
    expect(await suppressionFor(bouncer)).toBeNull()
  })

  it('REJECTS A BODY THAT CHANGED AFTER SIGNING', async () => {
    const signed = signedWebhook(hardBounce(bouncer, null))
    signed.body = signed.body.replace(bouncer, `someone_else_${RUN_ID}@example.com`)
    const res = await post(server, signed)
    expect(res.status).toBe(400)
    expect(await suppressionFor(`someone_else_${RUN_ID}@example.com`)).toBeNull()
  })

  it('REJECTS A REPLAY FROM OUTSIDE THE TIME WINDOW', async () => {
    // The body never changes, so a captured request stays validly signed
    // forever. The timestamp is the only thing that expires it.
    const res = await post(server, signedWebhook(hardBounce(bouncer, null), { skewSeconds: -3600 }))
    expect(res.status).toBe(400)
    expect(await suppressionFor(bouncer)).toBeNull()
  })

  it('REFUSES TO RUN AT ALL WITHOUT A SIGNING SECRET', async () => {
    // 503, not 400: a half-finished deploy should read as a deploy
    // problem, not as the provider sending garbage.
    const prior = process.env.RESEND_WEBHOOK_SECRET
    delete process.env.RESEND_WEBHOOK_SECRET
    try {
      const res = await post(server, signedWebhook(hardBounce(bouncer, null)))
      expect(res.status).toBe(503)
    } finally {
      process.env.RESEND_WEBHOOK_SECRET = prior
    }
  })

  it('SUPPRESSES ON A VERIFIED HARD BOUNCE AND CORRECTS THE LOG ROW', async () => {
    // Send first so there is a real 'sent' row to correct — that row
    // saying 'sent' about mail that bounced is the whole defect.
    const { result } = await captureSend({
      organizationId: orgId, userId: null, recipient: bouncer,
      notification_type: 'donation_receipt',
      vars: { amount: '$25', fund: 'General', date: 'today' },
    })
    expect(result.status).toBe('sent')

    const { rows } = await pool.query(
      `SELECT id, provider_message_id, status FROM ochr_notification_log WHERE id = $1`,
      [result.id]
    )
    expect(rows[0].provider_message_id).toBeTruthy()

    const res = await post(server, signedWebhook(hardBounce(bouncer, rows[0].provider_message_id)))
    expect(res.status).toBe(200)
    expect(res.body.kind).toBe('hard_bounce')

    expect((await suppressionFor(bouncer)).reason).toBe('bounce')

    const { rows: after } = await pool.query(
      `SELECT status, error FROM ochr_notification_log WHERE id = $1`,
      [result.id]
    )
    expect(after[0].status).toBe('bounced')
    expect(after[0].error).toContain('mailbox does not exist')
  })

  it('RECORDS A SOFT BOUNCE WITHOUT SUPPRESSING THE ADDRESS', async () => {
    // A full mailbox recovers. Suppressing it would silently delete a real
    // recipient, and the symptom — mail that stops arriving for someone
    // who never opted out — is close to undiagnosable.
    const soft = `soft_${RUN_ID}@example.com`
    const res = await post(server, signedWebhook({
      type: 'email.bounced',
      id: `evt_soft_${RUN_ID}`,
      data: { email_id: null, to: [soft], bounce: { type: 'Transient', message: 'mailbox full' } },
    }))
    expect(res.status).toBe(200)
    expect(res.body.kind).toBe('soft_bounce')
    expect(await suppressionFor(soft)).toBeNull()
  })

  it('SUPPRESSES ON A SPAM COMPLAINT', async () => {
    const angry = `angry_${RUN_ID}@example.com`
    const res = await post(server, signedWebhook({
      type: 'email.complained',
      id: `evt_c_${RUN_ID}`,
      data: { email_id: null, to: [angry] },
    }))
    expect(res.status).toBe(200)
    expect((await suppressionFor(angry)).reason).toBe('complaint')
  })

  it('IGNORES OPENS AND CLICKS WITHOUT TOUCHING ANYTHING', async () => {
    const res = await post(server, signedWebhook({
      type: 'email.opened', id: `evt_o_${RUN_ID}`,
      data: { email_id: null, to: [`reader_${RUN_ID}@example.com`] },
    }))
    expect(res.status).toBe(200)
    expect(res.body.kind).toBe('ignored')
    expect(await suppressionFor(`reader_${RUN_ID}@example.com`)).toBeNull()
  })
})

// ── Calendar subscription links ────────────────────────────────────
//
// Same env var, same defect, different consumer. A calendar app given a
// relative .ics URL does not error where anyone can see it — it just
// never syncs, and the member reports months later that their roster
// "stopped working". The header case could be answered by omitting the
// header; here the URL IS the response, so the only honest answers are a
// working link or a loud failure.

describe('calendar subscription links', () => {
  let token

  beforeAll(async () => {
    const login = await request(server).post('/api/auth/login')
      .send({ email: `email_${RUN_ID}@example.com`, password: 'smoke-test-pw-411' })
    expect(login.status).toBe(200)
    token = login.body.token

    // /my-link resolves the member from the authed user's EMAIL, and
    // signup does not create a member row. Without this the endpoint 404s
    // and every assertion below passes without executing anything — which
    // is what the first version of this block did.
    await pool.query(
      `INSERT INTO ochr_clients (organization_id, name, email, status)
       VALUES ($1, $2, $3, 'active')`,
      [orgId, 'Deliverability Admin', userEmail]
    )
  })

  it('ARE ABSOLUTE, NOT RELATIVE', async () => {
    const res = await request(server).get('/api/calendar-sync/my-link')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.url).toMatch(/^https?:\/\/.+\/api\/calendar-sync\/.+\.ics$/)
  })

  it('REFUSE TO ROTATE A TOKEN THEY COULD NOT HAND BACK', async () => {
    // The rotate endpoints invalidate the old token as their first act.
    // Discovering afterwards that the URL cannot be built would leave the
    // member with a dead subscription and nothing to replace it with, so
    // the guard runs BEFORE the write. This asserts the ordering, not just
    // the status code: the member's token must be untouched.
    // Mint a token first so there is something a bad rotate could destroy.
    const link = await request(server).get('/api/calendar-sync/my-link')
      .set('Authorization', `Bearer ${token}`)
    expect(link.status).toBe(200)

    const { rows: before } = await pool.query(
      `SELECT id, calendar_token FROM ochr_clients
        WHERE organization_id = $1 AND calendar_token IS NOT NULL LIMIT 1`,
      [orgId]
    )

    const priorBase = process.env.BASE_URL
    const priorEnv  = process.env.NODE_ENV
    process.env.BASE_URL = '/'
    process.env.NODE_ENV = 'production'
    try {
      const res = await request(server).post('/api/calendar-sync/my-rotate')
        .set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(500)
      expect(res.body.code).toBe('base_url_unconfigured')

      expect(before.length).toBeGreaterThan(0)
      const { rows: after } = await pool.query(
        `SELECT calendar_token FROM ochr_clients WHERE id = $1`, [before[0].id]
      )
      expect(after[0].calendar_token).toBe(before[0].calendar_token)
    } finally {
      if (priorBase === undefined) delete process.env.BASE_URL
      else process.env.BASE_URL = priorBase
      if (priorEnv === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = priorEnv
    }
  })
})
