// Reset PR11 (ARG-PR6-1): the closed/deactivated-recipient rules match an
// address with tab, newline, CRLF, NBSP or other Unicode whitespace padding,
// not only U+0020. JS and SQL normalisation agree. Local synthetic data;
// fake email transport (zero provider calls asserted).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

const { sendEmail } = vi.hoisted(() => ({ sendEmail: vi.fn(async () => ({ id: 'fake' })) }))
vi.mock('../src/email/send.js', async (orig) => ({ ...(await orig()), sendEmail }))

import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { processDueNotifications } from '../src/notifications/scheduler.js'
import { notify } from '../src/notifications/transport.js'
import { normEmail, sqlNormEmail } from '../src/utils/emailNorm.js'

const R = RUN_ID.replace(/[^a-z0-9]/gi, '').toLowerCase()
const auth = t => ({ Authorization: `Bearer ${t}` })
const VARIANTS = {
  tab: e => `\t${e}`, newline: e => `${e}\n`, crlf: e => `\r\n${e}\r\n`,
  nbsp: e => `\u00a0${e}\u00a0`, ideographic: e => `\u3000${e}`, bom: e => `\ufeff${e}`,
  upperTabNbsp: e => `\t${e.toUpperCase()}\u00a0`,
}
let server, token, orgId, savedKey
// Pending rows are scheduled in the FUTURE so no other file's global drain
// can claim them; the backstop case uses a past row and runs serially.
async function queue(recipient, when = new Date(Date.now() + 3600_000)) {
  const { rows } = await pool.query(
    `INSERT INTO ochr_scheduled_notifications (organization_id, user_id, recipient_email, notification_type, vars, send_at, status)
     VALUES ($1, NULL, $2, 'member_birthday', '{"member_name":"G"}'::jsonb, $3, 'pending') RETURNING id`,
    [orgId, recipient, when.toISOString()])
  return rows[0].id
}
const statuses = async ids => (await pool.query(
  'SELECT status FROM ochr_scheduled_notifications WHERE id = ANY($1) ORDER BY id', [ids])).rows.map(r => r.status)
async function member(tag) {
  const email = `pr11_${tag}_${R}@example.com`
  const u = await request(server).post('/api/users').set(auth(token)).send({ name: tag, email, password: 'pr11-test-pw', role: 'staff' })
  expect(u.status).toBe(201)
  return { id: u.body.id, email }
}

beforeAll(async () => {
  savedKey = process.env.RESEND_API_KEY
  process.env.RESEND_API_KEY = 'fake-key-not-used'
  await migrateOnce(); server = await bindServer()
  const res = await request(server).post('/api/auth/signup').set('X-Forwarded-For', '10.96.1.1')
    .send({ organizationName: `PR11 ${R}`, name: 'Admin', email: `pr11_a_${R}@example.com`, password: 'pr11-test-pw' })
  expect(res.status).toBe(201)
  token = res.body.token; orgId = res.body.user.organization.id
}, 60_000)
afterAll(async () => {
  if (savedKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = savedKey
  await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [orgId]).catch(() => {})
  await closeServer(server); await pool.end()
})

describe('PR11 whitespace-variant address normalisation', () => {
  it('JS and SQL normalise every variant identically; plain padding equals lower(btrim(x))', async () => {
    const e = `Pr11.Mixed_${R}@Example.Test`
    for (const [name, f] of Object.entries(VARIANTS)) {
      const { rows } = await pool.query(`SELECT ${sqlNormEmail('$1::text')} AS n`, [f(e)])
      expect(rows[0].n, name).toBe(e.toLowerCase())
      expect(normEmail(f(e)), name).toBe(e.toLowerCase())
    }
    const { rows } = await pool.query(`SELECT lower(btrim($1::text)) AS old, ${sqlNormEmail('$1::text')} AS new`, [`  ${e} `])
    expect(rows[0].new).toBe(rows[0].old)
    expect(normEmail(null)).toBeNull()
  })

  it('deactivation cancels address-only rows with every padding variant', async () => {
    const m = await member('deact')
    const ids = []; for (const f of Object.values(VARIANTS)) ids.push(await queue(f(m.email)))
    const keep = await queue(`\tsomeone_else_${R}@example.com`)
    expect((await request(server).post(`/api/users/${m.id}/deactivate`).set(auth(token))).status).toBe(200)
    expect(await statuses(ids)).toEqual(ids.map(() => 'cancelled'))
    expect(await statuses([keep])).toEqual(['pending'])
  })

  it('closure cancels address-only rows for the pre-closure address with every padding variant', async () => {
    const m = await member('close')
    const ids = []; for (const f of Object.values(VARIANTS)) ids.push(await queue(f(m.email)))
    expect((await request(server).post(`/api/users/${m.id}/close`).set(auth(token))).status).toBe(200)
    expect(await statuses(ids)).toEqual(ids.map(() => 'cancelled'))
  })

  it('direct notify to a padded address of a deactivated login is refused with zero provider calls; an active one sends', async () => {
    const m = await member('notify')
    expect((await request(server).post(`/api/users/${m.id}/deactivate`).set(auth(token))).status).toBe(200)
    sendEmail.mockClear()
    for (const [name, f] of Object.entries(VARIANTS)) {
      const r = await notify({ organizationId: orgId, recipient: f(m.email), notification_type: 'member_birthday', vars: { member_name: 'G' } })
      expect(r.reason, name).toBe('recipient_inactive')
    }
    expect(sendEmail).not.toHaveBeenCalled()
    const ok = await notify({ organizationId: orgId, recipient: `pr11_a_${R}@example.com`, notification_type: 'member_birthday', vars: { member_name: 'G' } })
    expect(ok.status).toBe('sent')
    expect(sendEmail).toHaveBeenCalledTimes(1)
  })

  it('scheduler backstop cancels due padded address-only rows queued AFTER deactivation (no provider call)', async () => {
    const m = await member('backstop')
    expect((await request(server).post(`/api/users/${m.id}/deactivate`).set(auth(token))).status).toBe(200)
    const ids = []; for (const f of Object.values(VARIANTS)) ids.push(await queue(f(m.email), new Date(Date.now() - 60_000)))
    sendEmail.mockClear()
    await processDueNotifications()
    expect(await statuses(ids)).toEqual(ids.map(() => 'cancelled'))
    expect(sendEmail.mock.calls.filter(([x]) => normEmail(x.to) === m.email)).toHaveLength(0)
  })
})
