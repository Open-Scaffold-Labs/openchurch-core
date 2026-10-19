// ARG-V2-2: a support-ticket status letter never goes to a deactivated or
// closed submitter; an active submitter still gets it. Local synthetic data.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
const sent = []
vi.mock('../src/notifications/transport.js', async (orig) => {
  const m = await orig()
  return { ...m, notify: vi.fn(async (a) => { sent.push(a); return { ok: true } }) }
})
import request from 'supertest'
import 'dotenv/config'
import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'

let server, token, orgId
const auth = (t) => ({ Authorization: `Bearer ${t}` })
const R = RUN_ID.replace(/[^a-z0-9]/gi, '').toLowerCase()
const tick = () => new Promise(r => setTimeout(r, 300))

beforeAll(async () => {
  await migrateOnce(); server = await bindServer()
  const res = await request(server).post('/api/auth/signup').set('X-Forwarded-For', '10.94.1.1')
    .send({ organizationName: `AV22 ${R}`, name: 'Admin', email: `av22_a_${R}@example.com`, password: 'av22-test-pw' })
  expect(res.status).toBe(201)
  token = res.body.token; orgId = res.body.user.organization.id
}, 60_000)
afterAll(async () => {
  await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [orgId]).catch(() => {})
  await closeServer(server); await pool.end()
})

async function submitterWithTicket(tag) {
  const email = `av22_${tag}_${R}@example.com`
  const u = await request(server).post('/api/users').set(auth(token)).send({ name: `S ${tag}`, email, password: 'av22-test-pw', role: 'admin' })
  expect(u.status).toBe(201)
  const l = await request(server).post('/api/auth/login').send({ email, password: 'av22-test-pw' })
  const t = await request(server).post('/api/support-tickets').set(auth(l.body.token)).send({ description: `av22 ${tag} ticket`, page_route: '/x' })
  expect(t.status).toBeLessThan(300)
  return { userId: u.body.id, ticketId: t.body.id }
}
async function resolve(ticketId) {
  sent.length = 0
  const r = await request(server).patch(`/api/support-tickets/${ticketId}`).set(auth(token)).send({ status: 'resolved' })
  expect(r.status).toBe(200)
  await tick()
  return sent.filter(s => s.notification_type === 'support_ticket_update')
}

describe('ARG-V2-2 support ticket letters', () => {
  it('active submitter gets the status letter', async () => {
    const s = await submitterWithTicket('active')
    const out = await resolve(s.ticketId)
    expect(out.length).toBe(1); expect(out[0].userId).toBe(s.userId)
  })
  it('deactivated submitter gets nothing', async () => {
    const s = await submitterWithTicket('deact')
    expect((await request(server).post(`/api/users/${s.userId}/deactivate`).set(auth(token))).status).toBe(200)
    expect((await resolve(s.ticketId)).length).toBe(0)
  })
  it('closed submitter gets nothing', async () => {
    const s = await submitterWithTicket('closed')
    expect((await request(server).post(`/api/users/${s.userId}/close`).set(auth(token))).status).toBe(200)
    expect((await resolve(s.ticketId)).length).toBe(0)
  })
})
