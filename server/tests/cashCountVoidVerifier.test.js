// 123 — cash counts: signed-in verifier and reasoned void (José, 21 Oct 2026,
// #62 comment 6330130546). Real Postgres, synthetic tenants only.
//
// Verifier: a second signed-in staff user in the same parish confirms; the
// user who saved the count cannot verify it. One person may post it only as
// an explicit single count, labelled 'Single count, not verified'.
//
// Void: admin-only, reason required, the count and its gift are kept, a
// linked reversing fact nets the books, a second void (sequential or
// concurrent) posts nothing more, and a gift posted by a count can no longer
// be deleted from the log.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'
import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'

const PW = 'cc123-test-pw'
let server, A, B, staff1, staff2, viewer
let ipSeq = 1
const nextIp = () => `10.123.${(ipSeq >> 8) & 255}.${(ipSeq++) & 255 || 1}`
const auth = t => ({ Authorization: `Bearer ${t}` })

async function signup(tag) {
  const email = `cc123_${tag}_${RUN_ID}@example.com`
  const r = await createOrg(server, { organizationName: `CC123 ${tag} ${RUN_ID}`, name: `Admin ${tag}`, email, password: PW }, nextIp())
  expect(r.status).toBe(201)
  return { id: r.body.user.organization.id, userId: r.body.user.id, token: r.body.token }
}
async function addUser(org, role, name, tag) {
  const email = `cc123_${tag}_${RUN_ID}@example.com`
  const c = await request(server).post('/api/users').set(auth(org.token)).set('X-Forwarded-For', nextIp())
    .send({ name, email, password: PW, role })
  expect(c.status).toBe(201)
  const l = await request(server).post('/api/auth/login').set('X-Forwarded-For', nextIp()).send({ email, password: PW })
  expect(l.status).toBe(200)
  return { id: l.body.user.id, token: l.body.token, name }
}

const posted = async name => (await pool.query(
  `SELECT COUNT(*)::int AS n FROM ochr_donations WHERE donor_name = $1`, [`${name} (Cash Collection)`])).rows[0].n
const sessionRow = async id => (await pool.query('SELECT * FROM ochr_cash_count_sessions WHERE id = $1', [id])).rows[0]
const reversals = async donationId => (await pool.query(
  `SELECT id, amount, kind, reason, status FROM ochr_donation_refunds WHERE donation_id = $1 ORDER BY id`, [donationId])).rows
const live = async donationId => Number((await pool.query(
  'SELECT live_amount FROM ochr_donation_live WHERE id = $1', [donationId])).rows[0].live_amount)

async function saveCount(by, name, total = 40) {
  const r = await request(server).post('/api/donations/cash-counts').set(auth(by.token))
    .send({ service_name: name, counted_by: by.name || 'Counter', total, denominations: { 20: total / 20 } })
  expect(r.status).toBe(201)
  return r.body
}
const confirm = (id, by, body) => request(server).patch(`/api/donations/cash-counts/${id}/confirm`).set(auth(by.token)).send(body ?? {})
const voidCount = (id, by, body) => request(server).post(`/api/donations/cash-counts/${id}/void`).set(auth(by.token)).send(body ?? {})

async function confirmedCount(name, total = 40) {
  const c = await saveCount(staff1, name, total)
  const r = await confirm(c.id, staff2)
  expect(r.status).toBe(200)
  return { id: c.id, donationId: r.body.donation.id }
}

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  A = await signup('a')
  B = await signup('b')
  staff1 = await addUser(A, 'staff', 'Staff One', 's1')
  staff2 = await addUser(A, 'staff', 'Staff Two', 's2')
  viewer = await addUser(A, 'viewer', 'Viewer', 'v')
  A.name = 'Admin a'
}, 90_000)

afterAll(async () => {
  for (const id of [A?.id, B?.id]) if (id) await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
  await closeServer(server)
  await pool.end()
})

describe('123 migration', () => {
  it('follows 122 and adds only nullable/defaulted columns', async () => {
    const { MIGRATION_NAMES, EXPECTED_MIGRATION } = await import('../src/migrations/names.js')
    expect(MIGRATION_NAMES).toContain(EXPECTED_MIGRATION)
    expect(MIGRATION_NAMES[MIGRATION_NAMES.indexOf('123-cash-count-void-verifier') - 1]).toBe('122-mass-intention-book-revision')
    const { rows } = await pool.query(`
      SELECT column_name, is_nullable, column_default FROM information_schema.columns
       WHERE table_name = 'ochr_cash_count_sessions'
         AND column_name IN ('counted_by_user_id','confirmed_by_user_id','confirmed_by_name','confirmed_at',
                             'verification','voided_at','voided_by_user_id','voided_by_name','void_reason','void_refund_id')`)
    expect(rows).toHaveLength(10)
    for (const r of rows) expect(r.is_nullable).toBe('YES')
    const k = await pool.query(`SELECT is_nullable, column_default FROM information_schema.columns
       WHERE table_name = 'ochr_donation_refunds' AND column_name = 'kind'`)
    expect(k.rows[0].column_default).toMatch(/'refund'/)
  })

  it('re-running up() is a no-op', async () => {
    const { up } = await import('../src/migrations/123-cash-count-void-verifier.js')
    await up()
    await up()
  })
})

describe('signed-in verifier', () => {
  it('records the signed-in counter on save; a typed verifier is refused', async () => {
    const c = await saveCount(staff1, `Saved ${RUN_ID}`)
    expect(Number(c.counted_by_user_id)).toBe(Number(staff1.id))
    const typed = await request(server).post('/api/donations/cash-counts').set(auth(staff1.token))
      .send({ service_name: `Typed ${RUN_ID}`, counted_by: 'X', verified_by: 'Joseph', total: 10 })
    expect(typed.status).toBe(422)
  })

  it('a second signed-in staff user confirms: two_person, who/when recorded, posts once', async () => {
    const name = `TwoPerson ${RUN_ID}`
    const c = await saveCount(staff1, name)
    const r = await confirm(c.id, staff2)
    expect(r.status).toBe(200)
    expect(r.body.session.verification).toBe('two_person')
    expect(Number(r.body.session.confirmed_by_user_id)).toBe(Number(staff2.id))
    expect(r.body.session.confirmed_by_name).toBe('Staff Two')
    expect(r.body.session.confirmed_at).toBeTruthy()
    expect(r.body.donation.notes).toMatch(/verified by Staff Two/)
    expect(await posted(name)).toBe(1)
  })

  it('the counter cannot verify their own count: 409 verifier_required, nothing posted', async () => {
    const name = `Self ${RUN_ID}`
    const c = await saveCount(staff1, name)
    const r = await confirm(c.id, staff1)
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('verifier_required')
    expect((await sessionRow(c.id)).status).toBe('pending')
    expect(await posted(name)).toBe(0)
  })

  it('one person can post it only as an explicit single count, labelled not verified', async () => {
    const name = `Single ${RUN_ID}`
    const c = await saveCount(staff1, name)
    const r = await confirm(c.id, staff1, { single_count: true })
    expect(r.status).toBe(200)
    expect(r.body.session.verification).toBe('single')
    expect(r.body.donation.notes).toMatch(/^Single count, not verified\./)
    expect(await posted(name)).toBe(1)
  })

  it('typed verifier names and non-boolean single_count are refused on new counts', async () => {
    const c = await saveCount(staff1, `TypedConfirm ${RUN_ID}`)
    expect((await confirm(c.id, staff2, { verified_by: 'Joseph' })).status).toBe(422)
    expect((await confirm(c.id, staff1, { single_count: 'yes' })).status).toBe(422)
    expect((await sessionRow(c.id)).status).toBe('pending')
  })

  it('another parish cannot confirm, and a viewer cannot confirm', async () => {
    const name = `Foreign ${RUN_ID}`
    const c = await saveCount(staff1, name)
    expect((await confirm(c.id, B)).status).toBe(404)
    expect((await confirm(c.id, viewer)).status).toBe(403)
    expect(await posted(name)).toBe(0)
  })

  it('pre-123 typed-name counts stay readable and confirm as typed_names', async () => {
    const name = `Legacy ${RUN_ID}`
    const c = await saveCount(staff1, name)
    await pool.query(`UPDATE ochr_cash_count_sessions SET counted_by_user_id = NULL, counted_by = 'Margaret', verified_by = 'Joseph' WHERE id = $1`, [c.id])
    const r = await confirm(c.id, staff1)
    expect(r.status).toBe(200)
    expect(r.body.session.verification).toBe('typed_names')
    expect(r.body.session.verified_by).toBe('Joseph')
    const list = await request(server).get('/api/donations/cash-counts').set(auth(A.token))
    const row = list.body.find(x => x.id === c.id)
    expect(row.counted_by).toBe('Margaret')
    expect(row.verified_by).toBe('Joseph')
  })
})

describe('reasoned void', () => {
  it('admin voids with a reason: originals kept, linked reversal, books net to zero, who/when recorded', async () => {
    const name = `Void ${RUN_ID}`
    const { id, donationId } = await confirmedCount(name, 60)
    const giftBefore = (await pool.query('SELECT * FROM ochr_donations WHERE id = $1', [donationId])).rows[0]
    const r = await voidCount(id, A, { reason: '  Counted the wrong bag  ' })
    expect(r.status).toBe(200)
    expect(r.body.session.void_reason).toBe('Counted the wrong bag')
    expect(r.body.session.voided_by_name).toBe('Admin a')
    expect(r.body.session.voided_at).toBeTruthy()
    expect(r.body.session.status).toBe('confirmed')
    const rev = await reversals(donationId)
    expect(rev).toHaveLength(1)
    expect(rev[0]).toMatchObject({ kind: 'void', status: 'posted', reason: 'Counted the wrong bag' })
    expect(Number(rev[0].amount)).toBe(60)
    expect(Number(r.body.session.void_refund_id)).toBe(Number(rev[0].id))
    // the gift row is untouched and still there
    const giftAfter = (await pool.query('SELECT * FROM ochr_donations WHERE id = $1', [donationId])).rows[0]
    expect(giftAfter).toEqual(giftBefore)
    expect(await live(donationId)).toBe(0)
    const s = await sessionRow(id)
    expect(Number(s.total)).toBe(60)
    expect(Number(s.voided_by_user_id)).toBe(Number(A.userId))
  })

  it('a reason is required (missing, blank, non-string → 422, nothing posted)', async () => {
    const { id, donationId } = await confirmedCount(`NoReason ${RUN_ID}`)
    for (const body of [{}, { reason: '' }, { reason: '   ' }, { reason: 7 }, { reason: { x: 1 } }]) {
      expect((await voidCount(id, A, body)).status).toBe(422)
    }
    expect(await reversals(donationId)).toHaveLength(0)
    expect((await sessionRow(id)).voided_at).toBeNull()
  })

  it('admin only: staff 403, viewer 403, another parish 404 — nothing posted', async () => {
    const { id, donationId } = await confirmedCount(`Perm ${RUN_ID}`)
    expect((await voidCount(id, staff1, { reason: 'x' })).status).toBe(403)
    expect((await voidCount(id, viewer, { reason: 'x' })).status).toBe(403)
    expect((await voidCount(id, B, { reason: 'x' })).status).toBe(404)
    expect(await reversals(donationId)).toHaveLength(0)
  })

  it('a pending count cannot be voided', async () => {
    const c = await saveCount(staff1, `PendingVoid ${RUN_ID}`)
    expect((await voidCount(c.id, A, { reason: 'x' })).status).toBe(409)
  })

  it('a second void is idempotent: same void returned, no second reversal, first reason kept', async () => {
    const { id, donationId } = await confirmedCount(`Twice ${RUN_ID}`)
    expect((await voidCount(id, A, { reason: 'first' })).status).toBe(200)
    const again = await voidCount(id, A, { reason: 'second' })
    expect(again.status).toBe(200)
    expect(again.body.already_voided).toBe(true)
    expect(again.body.session.void_reason).toBe('first')
    expect(await reversals(donationId)).toHaveLength(1)
  })

  it('CONCURRENT double void posts exactly one reversal', async () => {
    const { id, donationId } = await confirmedCount(`Race ${RUN_ID}`, 80)
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => voidCount(id, A, { reason: `race ${i}` })))
    expect(results.map(r => r.status)).toEqual([200, 200, 200, 200, 200])
    expect(results.filter(r => r.body.already_voided !== true)).toHaveLength(1)
    const rev = await reversals(donationId)
    expect(rev).toHaveLength(1)
    expect(Number(rev[0].amount)).toBe(80)
    expect(await live(donationId)).toBe(0)
  })

  it('the database refuses a second void fact even without the route lock', async () => {
    const { id, donationId } = await confirmedCount(`DbGuard ${RUN_ID}`)
    expect((await voidCount(id, A, { reason: 'once' })).status).toBe(200)
    await expect(pool.query(
      `INSERT INTO ochr_donation_refunds (organization_id, donation_id, amount, status, kind, reason)
       VALUES ($1, $2, 1, 'posted', 'void', 'bypass')`, [A.id, donationId])).rejects.toThrow()
  })

  it('a confirmed count and its posted gift cannot be deleted (void instead)', async () => {
    const { id, donationId } = await confirmedCount(`NoDelete ${RUN_ID}`)
    expect((await request(server).delete(`/api/donations/cash-counts/${id}`).set(auth(A.token))).status).toBe(409)
    const d = await request(server).delete(`/api/donations/${donationId}`).set(auth(A.token))
    expect(d.status).toBe(409)
    expect(d.body.code).toBe('cash_count_gift')
    expect((await pool.query('SELECT 1 FROM ochr_donations WHERE id = $1', [donationId])).rowCount).toBe(1)
  })

  it('a manual gift not from a count still deletes as before', async () => {
    const g = await request(server).post('/api/donations').set(auth(A.token))
      .send({ donor_name: `Manual ${RUN_ID}`, amount: 5, method: 'cash' })
    expect(g.status).toBe(201)
    const d = await request(server).delete(`/api/donations/${g.body.id}`).set(auth(A.token))
    expect(d.status).toBe(204)
  })

  it('a void inside a period already sent to the diocese records a period adjustment; frozen totals unchanged', async () => {
    const tag = `pa${RUN_ID}`.slice(0, 30)
    const dioEmail = `cc123_dio_${RUN_ID}@example.com`
    const parEmail = `cc123_par_${RUN_ID}@example.com`
    const dr = await createOrg(server, { organizationName: `CC123 Dio ${RUN_ID}`, name: 'Canon', email: dioEmail, password: PW, organizationType: 'diocese' }, nextIp())
    const pr = await createOrg(server, { organizationName: `CC123 Par ${RUN_ID}`, name: 'Par Admin', email: parEmail, password: PW }, nextIp())
    expect(dr.status).toBe(201); expect(pr.status).toBe(201)
    const dio = { id: dr.body.user.organization.id, token: dr.body.token }
    const par = { id: pr.body.user.organization.id, token: pr.body.token, name: 'Par Admin' }
    try {
      expect((await request(server).post('/api/diocese/parishes/invite').set(auth(dio.token)).send({ email: parEmail })).status).toBeLessThan(300)
      expect((await request(server).post('/api/affiliation/accept').set(auth(par.token)).send({ grant_level: 'detail' })).status).toBe(200)
      const helper = await (async () => {
        const email = `cc123_parstaff_${RUN_ID}@example.com`
        const c = await request(server).post('/api/users').set(auth(par.token)).set('X-Forwarded-For', nextIp())
          .send({ name: 'Par Staff', email, password: PW, role: 'staff' })
        expect(c.status).toBe(201)
        const l = await request(server).post('/api/auth/login').set('X-Forwarded-For', nextIp()).send({ email, password: PW })
        return { token: l.body.token }
      })()
      const save = await request(server).post('/api/donations/cash-counts').set(auth(par.token))
        .send({ service_name: `Frozen ${tag}`, service_date: '2031-03-02', counted_by: 'Par Admin', total: 50 })
      expect(save.status).toBe(201)
      const conf = await confirm(save.body.id, helper)
      expect(conf.status).toBe(200)
      const sub = await request(server).post('/api/finance/submissions').set(auth(par.token))
        .send({ period_start: '2031-03-01', period_end: '2031-03-31' })
      expect(sub.status).toBe(201)
      const subId = Number(sub.body.submission?.id ?? sub.body.id)
      const frozen = (await pool.query('SELECT totals_json FROM ochr_report_submissions WHERE id = $1', [subId])).rows[0].totals_json
      const v = await voidCount(save.body.id, par, { reason: 'Duplicate bag' })
      expect(v.status).toBe(200)
      expect(v.body.period_adjustment?.submission_id).toBe(subId)
      const adj = (await pool.query(
        'SELECT amount, donation_refund_id FROM ochr_period_adjustments WHERE submission_id = $1', [subId])).rows
      expect(adj).toHaveLength(1)
      expect(Number(adj[0].amount)).toBe(50)
      expect(Number(adj[0].donation_refund_id)).toBe(Number(v.body.reversal.id))
      const after = (await pool.query('SELECT totals_json FROM ochr_report_submissions WHERE id = $1', [subId])).rows[0].totals_json
      expect(after).toEqual(frozen)
    } finally {
      for (const id of [par.id, dio.id]) await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
    }
  })
})
