// 124 — staff request, admin approve/reject for voiding a confirmed cash
// count (José, 21 Oct 2026, 7:38 PM PT). Real Postgres, synthetic tenants.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'
import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'

const PW = 'cc124-test-pw'
let server, A, B, admin2, staff1, staff2, viewer
let ipSeq = 1
const nextIp = () => `10.124.${(ipSeq >> 8) & 255}.${(ipSeq++) & 255 || 1}`
const auth = t => ({ Authorization: `Bearer ${t}` })

async function signup(tag) {
  const email = `cc124_${tag}_${RUN_ID}@example.com`
  const r = await createOrg(server, { organizationName: `CC124 ${tag} ${RUN_ID}`, name: `Admin ${tag}`, email, password: PW }, nextIp())
  expect(r.status).toBe(201)
  return { id: r.body.user.organization.id, userId: r.body.user.id, token: r.body.token, name: `Admin ${tag}` }
}
async function addUser(org, role, name, tag) {
  const email = `cc124_${tag}_${RUN_ID}@example.com`
  const c = await request(server).post('/api/users').set(auth(org.token)).set('X-Forwarded-For', nextIp())
    .send({ name, email, password: PW, role })
  expect(c.status).toBe(201)
  const l = await request(server).post('/api/auth/login').set('X-Forwarded-For', nextIp()).send({ email, password: PW })
  expect(l.status).toBe(200)
  return { id: l.body.user.id, token: l.body.token, name }
}

const reversals = async donationId => (await pool.query(
  `SELECT id, amount, kind, reason FROM ochr_donation_refunds WHERE donation_id = $1 ORDER BY id`, [donationId])).rows
const sessionRow = async id => (await pool.query('SELECT * FROM ochr_cash_count_sessions WHERE id = $1', [id])).rows[0]
const reqRow = async id => (await pool.query('SELECT * FROM ochr_cash_count_void_requests WHERE id = $1', [id])).rows[0]
const bell = async who => (await request(server).get('/api/notifications').set(auth(who.token))).body

async function confirmedCount(name, total = 40) {
  const c = await request(server).post('/api/donations/cash-counts').set(auth(staff1.token))
    .send({ service_name: name, counted_by: 'Staff One', total })
  expect(c.status).toBe(201)
  const r = await request(server).patch(`/api/donations/cash-counts/${c.body.id}/confirm`).set(auth(staff2.token)).send({})
  expect(r.status).toBe(200)
  return { id: c.body.id, donationId: r.body.donation.id }
}
const ask = (id, by, body) => request(server).post(`/api/donations/cash-counts/${id}/void-requests`).set(auth(by.token)).send(body ?? {})
const approve = (rid, by) => request(server).post(`/api/donations/cash-counts/void-requests/${rid}/approve`).set(auth(by.token)).send({})
const reject = (rid, by, body) => request(server).post(`/api/donations/cash-counts/void-requests/${rid}/reject`).set(auth(by.token)).send(body ?? {})

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  A = await signup('a')
  B = await signup('b')
  admin2 = await addUser(A, 'admin', 'Admin Two', 'a2')
  staff1 = await addUser(A, 'staff', 'Staff One', 's1')
  staff2 = await addUser(A, 'staff', 'Staff Two', 's2')
  viewer = await addUser(A, 'viewer', 'Viewer', 'v')
}, 90_000)

afterAll(async () => {
  for (const id of [A?.id, B?.id]) if (id) await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
  await closeServer(server)
  await pool.end()
})

describe('124 migration', () => {
  it('follows 123, and re-runs as a no-op', async () => {
    const { MIGRATION_NAMES, EXPECTED_MIGRATION } = await import('../src/migrations/names.js')
    expect(EXPECTED_MIGRATION).toBe('144-online-giving-clearing')
    const i124 = MIGRATION_NAMES.indexOf('124-cash-count-void-requests')
    expect(i124).toBeGreaterThan(0)
    expect(MIGRATION_NAMES[i124 - 1]).toBe('123-cash-count-void-verifier')
    const { up } = await import('../src/migrations/124-cash-count-void-requests.js')
    await up(); await up()
    const col = await pool.query(`SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'ochr_notifications' AND column_name = 'recipient_user_id'`)
    expect(col.rows[0].is_nullable).toBe('YES')
    const g = await pool.query(`SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE c.relname = 'ochr_cash_count_void_requests' AND t.tgname = 'ochr_organization_hold_guard'`)
    expect(g.rowCount).toBe(1)
  })
})

describe('staff request', () => {
  it('records requester, time and reason; moves no money; notifies every admin in the parish only', async () => {
    const { id, donationId } = await confirmedCount(`Req ${RUN_ID}`)
    const r = await ask(id, staff1, { reason: '  Wrong bag counted  ' })
    expect(r.status).toBe(201)
    expect(r.body.request).toMatchObject({ status: 'pending', reason: 'Wrong bag counted', requested_by_name: 'Staff One' })
    expect(Number(r.body.request.requested_by_user_id)).toBe(Number(staff1.id))
    expect(r.body.request.requested_at).toBeTruthy()
    expect(r.body.admins_notified).toBe(2)
    expect(await reversals(donationId)).toHaveLength(0)
    expect((await sessionRow(id)).voided_at).toBeNull()
    const msg = n => n.type === 'cash_count_void_request' && n.message.includes(`Req ${RUN_ID}`)
    expect((await bell(A)).filter(msg)).toHaveLength(1)
    expect((await bell(admin2)).filter(msg)).toHaveLength(1)
    // addressed rows are not in staff/viewer/other-parish bells
    expect((await bell(staff1)).filter(msg)).toHaveLength(0)
    expect((await bell(staff2)).filter(msg)).toHaveLength(0)
    expect((await bell(B)).filter(msg)).toHaveLength(0)
  })

  it('reason required; viewer 403; other parish 404; pending count 409', async () => {
    const { id } = await confirmedCount(`ReqGuard ${RUN_ID}`)
    for (const body of [{}, { reason: '' }, { reason: '  ' }, { reason: 3 }]) expect((await ask(id, staff1, body)).status).toBe(422)
    expect((await ask(id, viewer, { reason: 'x' })).status).toBe(403)
    expect((await ask(id, B, { reason: 'x' })).status).toBe(404)
    const p = await request(server).post('/api/donations/cash-counts').set(auth(staff1.token))
      .send({ service_name: `P ${RUN_ID}`, counted_by: 'X', total: 5 })
    expect((await ask(p.body.id, staff1, { reason: 'x' })).status).toBe(409)
  })

  it('one open request per count: repeats (even concurrent, even by someone else) return the same request', async () => {
    const { id } = await confirmedCount(`ReqOnce ${RUN_ID}`)
    const rs = await Promise.all([ask(id, staff1, { reason: 'a' }), ask(id, staff2, { reason: 'b' }), ask(id, staff1, { reason: 'c' })])
    expect(rs.map(r => r.status).sort()).toEqual([200, 200, 201])
    const ids = new Set(rs.map(r => String(r.body.request.id)))
    expect(ids.size).toBe(1)
    const n = await pool.query(`SELECT COUNT(*)::int AS n FROM ochr_cash_count_void_requests WHERE cash_count_id = $1`, [id])
    expect(n.rows[0].n).toBe(1)
  })
})

describe('admin decision', () => {
  it('approve posts the #358 void in the same transaction with approver, time and the original reason', async () => {
    const { id, donationId } = await confirmedCount(`Appr ${RUN_ID}`, 70)
    const r = await ask(id, staff1, { reason: 'Duplicate entry' })
    const a = await approve(r.body.request.id, A)
    expect(a.status).toBe(200)
    expect(a.body.request).toMatchObject({ status: 'approved', decided_by_name: 'Admin a' })
    expect(a.body.request.decided_at).toBeTruthy()
    expect(a.body.session).toMatchObject({ void_reason: 'Duplicate entry', voided_by_name: 'Admin a' })
    const rev = await reversals(donationId)
    expect(rev).toHaveLength(1)
    expect(rev[0]).toMatchObject({ kind: 'void', reason: 'Duplicate entry' })
    expect(Number(rev[0].amount)).toBe(70)
    expect(Number(a.body.request.void_refund_id)).toBe(Number(rev[0].id))
  })

  it('the requester cannot approve their own request, even as an admin; another admin can', async () => {
    const { id, donationId } = await confirmedCount(`Own ${RUN_ID}`)
    const r = await ask(id, A, { reason: 'mine' })
    expect(r.body.admins_notified).toBe(1)
    const self = await approve(r.body.request.id, A)
    expect(self.status).toBe(403)
    expect(self.body.code).toBe('own_request')
    expect(await reversals(donationId)).toHaveLength(0)
    expect((await reqRow(r.body.request.id)).status).toBe('pending')
    expect((await approve(r.body.request.id, admin2)).status).toBe(200)
  })

  it('staff cannot approve or reject; other parish cannot see the request', async () => {
    const { id } = await confirmedCount(`Perm ${RUN_ID}`)
    const r = await ask(id, staff1, { reason: 'x' })
    expect((await approve(r.body.request.id, staff2)).status).toBe(403)
    expect((await reject(r.body.request.id, staff2)).status).toBe(403)
    expect((await approve(r.body.request.id, B)).status).toBe(404)
    expect((await reject(r.body.request.id, B)).status).toBe(404)
    expect((await reqRow(r.body.request.id)).status).toBe('pending')
  })

  it('reject records who, when and an optional note; no money moves; count can be requested again', async () => {
    const { id, donationId } = await confirmedCount(`Rej ${RUN_ID}`)
    const r = await ask(id, staff1, { reason: 'x' })
    expect((await reject(r.body.request.id, A, { note: 7 })).status).toBe(422)
    const j = await reject(r.body.request.id, A, { note: ' Count matches the deposit slip ' })
    expect(j.status).toBe(200)
    expect(j.body.request).toMatchObject({ status: 'rejected', decided_by_name: 'Admin a', decision_note: 'Count matches the deposit slip' })
    expect(j.body.request.decided_at).toBeTruthy()
    expect(await reversals(donationId)).toHaveLength(0)
    expect((await approve(r.body.request.id, admin2)).status).toBe(409)
    expect((await ask(id, staff1, { reason: 'again' })).status).toBe(201)
  })

  it('CONCURRENT double approve posts exactly one reversal', async () => {
    const { id, donationId } = await confirmedCount(`DblAppr ${RUN_ID}`, 90)
    const r = await ask(id, staff1, { reason: 'race' })
    const res = await Promise.all([approve(r.body.request.id, A), approve(r.body.request.id, admin2), approve(r.body.request.id, A)])
    expect(res.map(x => x.status).sort()).toEqual([200, 409, 409])
    expect(await reversals(donationId)).toHaveLength(1)
  })

  it('CONCURRENT approve vs reject: exactly one decision wins and money matches it', async () => {
    for (let i = 0; i < 4; i++) {
      const { id, donationId } = await confirmedCount(`AvR${i} ${RUN_ID}`)
      const r = await ask(id, staff1, { reason: 'race' })
      const [a, j] = await Promise.all([approve(r.body.request.id, A), reject(r.body.request.id, admin2)])
      expect([a.status, j.status].sort()).toEqual([200, 409])
      const final = (await reqRow(r.body.request.id)).status
      const rev = await reversals(donationId)
      if (final === 'approved') { expect(a.status).toBe(200); expect(rev).toHaveLength(1) }
      else { expect(final).toBe('rejected'); expect(j.status).toBe(200); expect(rev).toHaveLength(0) }
    }
  })

  it('an admin can still void directly; that supersedes the pending request', async () => {
    const { id, donationId } = await confirmedCount(`Direct ${RUN_ID}`)
    const r = await ask(id, staff1, { reason: 'please' })
    const v = await request(server).post(`/api/donations/cash-counts/${id}/void`).set(auth(admin2.token)).send({ reason: 'direct' })
    expect(v.status).toBe(200)
    expect((await reqRow(r.body.request.id)).status).toBe('superseded')
    expect((await approve(r.body.request.id, A)).status).toBe(409)
    expect(await reversals(donationId)).toHaveLength(1)
    expect((await ask(id, staff1, { reason: 'again' })).status).toBe(409)
  })

  it('list shows pending requests to staff', async () => {
    const { id } = await confirmedCount(`List ${RUN_ID}`)
    const r = await ask(id, staff1, { reason: 'listed' })
    const l = await request(server).get('/api/donations/cash-counts/void-requests').set(auth(staff2.token))
    expect(l.status).toBe(200)
    expect(l.body.some(x => String(x.id) === String(r.body.request.id))).toBe(true)
    const lb = await request(server).get('/api/donations/cash-counts/void-requests').set(auth(B.token))
    expect(lb.body.some(x => String(x.id) === String(r.body.request.id))).toBe(false)
  })
})
