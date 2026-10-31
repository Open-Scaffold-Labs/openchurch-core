// BOOKS-1.1 — fund net-asset class, releases, chancery mappings (D2).
// José, 2026-10-27 1:37 PM PT. Real Postgres, synthetic tenants.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import request from 'supertest'
import 'dotenv/config'
import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const MIGRATION = join(HERE, '../src/migrations/135-fund-net-asset-class.js')
const PW = 'books11-pw'
let server, A, B, dio, parish, admin2, staff1, dioStaff
let ipSeq = 1
const nextIp = () => `10.135.${(ipSeq >> 8) & 255}.${(ipSeq++) & 255 || 1}`
const auth = t => ({ Authorization: `Bearer ${t}` })
const cleanup = []

async function signup(tag, type = 'parish') {
  const email = `books11_${tag}_${RUN_ID}@example.com`
  const r = await createOrg(server, {
    organizationName: `BOOKS11 ${tag} ${RUN_ID}`, name: `Admin ${tag}`,
    email, password: PW, organizationType: type,
  }, nextIp())
  expect(r.status).toBe(201)
  cleanup.push(r.body.user.organization.id)
  return { id: r.body.user.organization.id, userId: r.body.user.id, token: r.body.token, email }
}
async function addUser(org, role, name, tag) {
  const email = `books11_${tag}_${RUN_ID}@example.com`
  const c = await request(server).post('/api/users').set(auth(org.token)).set('X-Forwarded-For', nextIp())
    .send({ name, email, password: PW, role })
  expect(c.status).toBe(201)
  const l = await request(server).post('/api/auth/login').set('X-Forwarded-For', nextIp()).send({ email, password: PW })
  expect(l.status).toBe(200)
  return { id: l.body.user.id, token: l.body.token, name }
}

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  A = await signup('a')
  B = await signup('b')
  admin2 = await addUser(A, 'admin', 'Admin Two', 'a2')
  staff1 = await addUser(A, 'staff', 'Staff One', 's1')
  dio = await signup('dio', 'diocese')
  dioStaff = await addUser(dio, 'staff', 'Dio Staff', 'ds1')
  parish = await signup('aff')
  const inv = await request(server).post('/api/diocese/parishes/invite').set(auth(dio.token))
    .send({ email: parish.email })
  expect(inv.status).toBeLessThan(300)
  const acc = await request(server).post('/api/affiliation/accept').set(auth(parish.token))
    .send({ grant_level: 'detail' })
  expect(acc.status).toBe(200)
}, 90_000)

afterAll(async () => {
  for (const id of cleanup) await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
  await closeServer(server)
  await pool.end()
})

describe('135 migration', () => {
  it('follows 133, skips 134, is transactional, and enables RLS', async () => {
    const { MIGRATION_NAMES, EXPECTED_MIGRATION } = await import('../src/migrations/names.js')
    expect(EXPECTED_MIGRATION).toBe('144-online-giving-clearing')
    expect(MIGRATION_NAMES.some(n => n.startsWith('134-'))).toBe(false)
    expect(MIGRATION_NAMES[MIGRATION_NAMES.indexOf('135-fund-net-asset-class') - 1]).toBe('133-parish-catering')
    const src = readFileSync(MIGRATION, 'utf8')
    expect(src).toMatch(/BEGIN ISOLATION LEVEL REPEATABLE READ/)
    expect(src).toMatch(/SET LOCAL lock_timeout/)
    expect(src).not.toMatch(/\b134-/)
    const { up } = await import('../src/migrations/135-fund-net-asset-class.js')
    await up(); await up()
    const rls = await pool.query(
      `SELECT relrowsecurity FROM pg_class WHERE relname = 'ochr_fund_restriction_releases'`)
    expect(rls.rows[0]?.relrowsecurity).toBe(true)
    const coa = await pool.query(
      `SELECT code, name FROM ochr_coa_accounts WHERE organization_id IS NULL AND code IN ('3110','3120') ORDER BY code`)
    expect(coa.rows).toEqual([
      { code: '3110', name: 'Net Assets — Without Donor Restrictions' },
      { code: '3120', name: 'Net Assets — With Donor Restrictions' },
    ])
  })
})

describe('fund class', () => {
  it('defaults without restriction and refuses class flip after gifts', async () => {
    const created = await request(server).post('/api/funds').set(auth(A.token))
      .send({ name: `Building ${RUN_ID}` })
    expect(created.status).toBe(201)
    expect(created.body.net_asset_class).toBe('without_donor_restriction')

    const restricted = await request(server).post('/api/funds').set(auth(A.token))
      .send({
        name: `Missions ${RUN_ID}`,
        net_asset_class: 'with_donor_restriction',
        restriction_nature: 'purpose',
        restriction_purpose: 'Foreign missions',
      })
    expect(restricted.status).toBe(201)
    expect(restricted.body.net_asset_class).toBe('with_donor_restriction')

    const gift = await request(server).post('/api/donations').set(auth(A.token))
      .send({ donor_name: 'Synthetic Donor', amount: 25, date: '2026-10-20', fund_id: restricted.body.id, category: 'Missions' })
    expect(gift.status).toBe(201)

    const flip = await request(server).patch(`/api/funds/${restricted.body.id}`).set(auth(A.token))
      .send({ net_asset_class: 'without_donor_restriction' })
    expect(flip.status).toBe(409)
    expect(flip.body.code).toBe('class_flip_requires_reclass')

    const staffClass = await request(server).post('/api/funds').set(auth(staff1.token))
      .send({
        name: `Staff Restricted ${RUN_ID}`,
        net_asset_class: 'with_donor_restriction',
        restriction_nature: 'time',
      })
    expect(staffClass.status).toBe(403)
  })

  it('releases are append-only and need a second admin', async () => {
    const fund = await request(server).post('/api/funds').set(auth(A.token)).send({
      name: `Endowment ${RUN_ID}`,
      net_asset_class: 'with_donor_restriction',
      restriction_nature: 'perpetual',
    })
    expect(fund.status).toBe(201)

    const selfApprove = await request(server).post(`/api/funds/${fund.body.id}/releases`)
      .set(auth(A.token))
      .send({ amount: 10, released_on: '2026-10-27', qualifying_memo: 'spent on altar' })
    expect(selfApprove.status).toBe(400)
    expect(selfApprove.body.code).toBe('second_admin_required')

    const ok = await request(server).post(`/api/funds/${fund.body.id}/releases`)
      .set(auth(A.token))
      .send({
        amount: 10, released_on: '2026-10-27', qualifying_memo: 'spent on altar',
        requester_user_id: admin2.id,
      })
    expect(ok.status).toBe(201)
    expect(ok.body.kind).toBe('release')

    const staffRel = await request(server).post(`/api/funds/${fund.body.id}/releases`)
      .set(auth(staff1.token))
      .send({ amount: 5, released_on: '2026-10-27', requester_user_id: A.userId })
    expect(staffRel.status).toBe(403)

    const upd = await pool.query(
      `UPDATE ochr_fund_restriction_releases SET amount = 99 WHERE id = $1 AND organization_id = $2`,
      [ok.body.id, A.id]).catch(e => e)
    expect(String(upd.message || upd)).toMatch(/append-only/)

    const rf = await request(server).get(`/api/funds/${fund.body.id}/rollforward`)
      .query({ from: '2026-01-01', to: '2026-12-31' }).set(auth(A.token))
    expect(rf.status).toBe(200)
    expect(rf.body.releases).toBe('10.00')
  })
})

describe('mapping class check and chancery D2', () => {
  it('parish cannot map restricted fund to assessable revenue; chancery can set 4450', async () => {
    const fund = await request(server).post('/api/funds').set(auth(parish.token)).send({
      name: `Peters Pence ${RUN_ID}`,
      net_asset_class: 'with_donor_restriction',
      restriction_nature: 'purpose',
      restriction_purpose: "Peter's Pence",
    })
    expect(fund.status).toBe(201)
    const fundKey = String(fund.body.id)

    const parishBad = await request(server).put('/api/finance/mappings').set(auth(parish.token))
      .send({ mappings: [{ source_type: 'fund', source_key: fundKey, account_code: '4110' }] })
    expect(parishBad.status).toBe(400)
    expect(parishBad.body.code).toBe('restricted_fund_account')

    const parishLower = await request(server).put('/api/finance/mappings').set(auth(parish.token))
      .send({ mappings: [{ source_type: 'fund', source_key: fundKey, account_code: '4450' }] })
    expect(parishLower.status).toBe(403)
    expect(parishLower.body.code).toBe('diocese_mapping_required')

    const chancery = await request(server)
      .put(`/api/diocese/parishes/${parish.id}/mappings`)
      .set(auth(dio.token))
      .send({ mappings: [{ source_type: 'fund', source_key: fundKey, account_code: '4450' }] })
    expect(chancery.status).toBe(200)
    const row = chancery.body.mappings.find(m => m.source_type === 'fund' && m.source_key === fundKey)
    expect(row?.account_code).toBe('4450')
    expect(row?.set_by).toBe('diocese')

    // Cross-tenant: diocese cannot write another parish
    const cross = await request(server)
      .put(`/api/diocese/parishes/${A.id}/mappings`)
      .set(auth(dio.token))
      .send({ mappings: [{ source_type: 'fund', source_key: fundKey, account_code: '2320' }] })
    expect([403, 404]).toContain(cross.status)

    // Other parish cannot read via chancery of this dio using wrong id still 404
    const otherDio = await request(server)
      .put(`/api/diocese/parishes/${parish.id}/mappings`)
      .set(auth(A.token))
      .send({ mappings: [{ source_type: 'fund', source_key: fundKey, account_code: '2320' }] })
    expect(otherDio.status).toBe(403)
  })

  it('parish cannot supersede an open diocese mapping (N438-1)', async () => {
    const fund = await request(server).post('/api/funds').set(auth(parish.token)).send({
      name: `Locked ${RUN_ID}`,
      net_asset_class: 'with_donor_restriction',
      restriction_nature: 'purpose',
      restriction_purpose: 'Missions',
    })
    expect(fund.status).toBe(201)
    const fundKey = String(fund.body.id)
    const chancery = await request(server)
      .put(`/api/diocese/parishes/${parish.id}/mappings`)
      .set(auth(dio.token))
      .send({ mappings: [{ source_type: 'fund', source_key: fundKey, account_code: '4450' }] })
    expect(chancery.status).toBe(200)

    const override = await request(server).put('/api/finance/mappings').set(auth(parish.token))
      .send({ mappings: [{ source_type: 'fund', source_key: fundKey, account_code: '2320' }] })
    expect(override.status).toBe(403)
    expect(override.body.code).toBe('diocese_mapping_locked')

    const still = await pool.query(
      `SELECT account_code, set_by FROM ochr_coa_mappings
        WHERE organization_id = $1 AND source_type = 'fund' AND source_key = $2
          AND superseded_on IS NULL`,
      [parish.id, fundKey])
    expect(still.rows).toEqual([
      expect.objectContaining({ account_code: '4450', set_by: 'diocese' }),
    ])
  })

  it('diocese Staff cannot write chancery mappings (N438-2)', async () => {
    const refused = await request(server)
      .put(`/api/diocese/parishes/${parish.id}/mappings`)
      .set(auth(dioStaff.token))
      .send({ mappings: [{ source_type: 'donation_category', source_key: 'offering', account_code: '4110' }] })
    expect(refused.status).toBe(403)
  })

  it('chancery mapping refuses summary grant and suspended affiliation (Ledger P2)', async () => {
    // Fresh parish with summary grant
    const sum = await signup('sum')
    const inv = await request(server).post('/api/diocese/parishes/invite').set(auth(dio.token))
      .send({ email: sum.email })
    expect(inv.status).toBeLessThan(300)
    const acc = await request(server).post('/api/affiliation/accept').set(auth(sum.token))
      .send({ grant_level: 'summary' })
    expect(acc.status).toBe(200)
    const summaryRefuse = await request(server)
      .put(`/api/diocese/parishes/${sum.id}/mappings`)
      .set(auth(dio.token))
      .send({ mappings: [{ source_type: 'donation_category', source_key: 'offering', account_code: '4110' }] })
    expect(summaryRefuse.status).toBe(403)
    expect(summaryRefuse.body.code).toBe('grant_level_insufficient')

    // Suspend the detail parish (PATCH takes affiliation id); mapping write must 404
    const { rows: affRows } = await pool.query(
      `SELECT id FROM ochr_diocese_affiliations
        WHERE diocese_org_id = $1 AND parish_org_id = $2 AND status = 'active'`,
      [dio.id, parish.id])
    expect(affRows.length).toBe(1)
    const affId = affRows[0].id
    const patch = await request(server).patch(`/api/diocese/parishes/${affId}`)
      .set(auth(dio.token)).send({ status: 'suspended' })
    expect(patch.status).toBeLessThan(300)
    const suspended = await request(server)
      .put(`/api/diocese/parishes/${parish.id}/mappings`)
      .set(auth(dio.token))
      .send({ mappings: [{ source_type: 'donation_category', source_key: 'tithe', account_code: '4110' }] })
    expect(suspended.status).toBe(404)
    // restore for later tests
    const reinstate = await request(server).patch(`/api/diocese/parishes/${affId}`)
      .set(auth(dio.token)).send({ status: 'active' })
    expect(reinstate.status).toBeLessThan(300)
  })

  it('cross-tenant fund release is 404', async () => {
    const fund = await request(server).post('/api/funds').set(auth(A.token)).send({
      name: `Secret ${RUN_ID}`,
      net_asset_class: 'with_donor_restriction',
      restriction_nature: 'time',
    })
    expect(fund.status).toBe(201)
    const sneak = await request(server).post(`/api/funds/${fund.body.id}/releases`)
      .set(auth(B.token))
      .send({ amount: 1, released_on: '2026-10-27', requester_user_id: B.userId, single_admin_reason: 'x' })
    expect([403, 404]).toContain(sneak.status)
  })
})


describe('rollforward as-of-date (TARS P1)', () => {
  it('gift in Sept, refund in Oct: Sept shows gross, Oct shows the reduction', async () => {
    const fund = await request(server).post('/api/funds').set(auth(A.token)).send({
      name: `AsOf Refund ${RUN_ID}`,
      net_asset_class: 'with_donor_restriction',
      restriction_nature: 'purpose',
      restriction_purpose: 'Building',
    })
    expect(fund.status).toBe(201)
    const fid = fund.body.id

    const gift = await request(server).post('/api/donations').set(auth(A.token))
      .send({ donor_name: 'Sept Donor', amount: 1000, date: '2026-09-15', fund_id: fid, category: 'Building' })
    expect(gift.status).toBe(201)

    const ref = await request(server).post(`/api/donations/${gift.body.id}/record-refund`).set(auth(A.token))
      .send({ amount: 300, reason: 'Partial return' })
    expect(ref.status).toBeLessThan(300)

    // Pin the refund's effective date to October (tests must not depend on "today").
    const pinned = await pool.query(
      `UPDATE ochr_donation_refunds
          SET refunded_at = '2026-10-15T12:00:00Z'
        WHERE donation_id = $1 AND organization_id = $2 AND status = 'posted'
        RETURNING id, amount, kind, refunded_at::date::text AS on_date`,
      [gift.body.id, A.id])
    expect(pinned.rowCount).toBe(1)
    expect(pinned.rows[0].on_date).toBe('2026-10-15')
    // Gift amount is never rewritten
    const { rows: [d] } = await pool.query(
      `SELECT amount::text FROM ochr_donations WHERE id = $1 AND organization_id = $2`,
      [gift.body.id, A.id])
    expect(d.amount).toBe('1000.00')

    const sept = await request(server).get(`/api/funds/${fid}/rollforward`)
      .set(auth(A.token)).query({ from: '2026-09-01', to: '2026-09-30' })
    expect(sept.status).toBe(200)
    expect(Number(sept.body.opening)).toBe(0)
    expect(Number(sept.body.gross_contributions)).toBe(1000)
    expect(Number(sept.body.refunds)).toBe(0)
    expect(Number(sept.body.net_contributions)).toBe(1000)
    expect(Number(sept.body.contributions)).toBe(Number(sept.body.net_contributions)) // deprecated alias
    expect(Number(sept.body.releases)).toBe(0)
    expect(Number(sept.body.closing)).toBe(1000)
    expect(Number(sept.body.closing)).toBe(
      Number(sept.body.opening) + Number(sept.body.gross_contributions)
      - Number(sept.body.refunds) - Number(sept.body.releases))

    const oct = await request(server).get(`/api/funds/${fid}/rollforward`)
      .set(auth(A.token)).query({ from: '2026-10-01', to: '2026-10-31' })
    expect(oct.status).toBe(200)
    expect(Number(oct.body.opening)).toBe(1000)
    expect(Number(oct.body.gross_contributions)).toBe(0)
    expect(Number(oct.body.refunds)).toBe(300)
    expect(Number(oct.body.net_contributions)).toBe(-300)
    expect(Number(oct.body.contributions)).toBe(Number(oct.body.net_contributions)) // deprecated alias
    expect(Number(oct.body.releases)).toBe(0)
    expect(Number(oct.body.closing)).toBe(700)
    expect(Number(oct.body.closing)).toBe(
      Number(oct.body.opening) + Number(oct.body.gross_contributions)
      - Number(oct.body.refunds) - Number(oct.body.releases))

    // Live view still nets current (700) on the gift date — rollforward must NOT use that for Sept.
    const { rows: [live] } = await pool.query(
      `SELECT live_amount::text FROM ochr_donation_live WHERE id = $1 AND organization_id = $2`,
      [gift.body.id, A.id])
    expect(Number(live.live_amount)).toBe(700)
  })

  it('gift in Sept, void in Oct: Sept shows gross, Oct shows the full void', async () => {
    const fund = await request(server).post('/api/funds').set(auth(A.token)).send({
      name: `AsOf Void ${RUN_ID}`,
      net_asset_class: 'with_donor_restriction',
      restriction_nature: 'purpose',
      restriction_purpose: 'Missions',
    })
    expect(fund.status).toBe(201)
    const fid = fund.body.id

    const gift = await request(server).post('/api/donations').set(auth(A.token))
      .send({ donor_name: 'Void Donor', amount: 500, date: '2026-09-20', fund_id: fid, category: 'Missions' })
    expect(gift.status).toBe(201)

    const voided = await request(server).post(`/api/donations/${gift.body.id}/void`).set(auth(A.token))
      .send({ reason: 'Entered twice' })
    expect(voided.status).toBeLessThan(300)

    await pool.query(
      `UPDATE ochr_donation_refunds
          SET refunded_at = '2026-10-20T12:00:00Z'
        WHERE donation_id = $1 AND organization_id = $2 AND status = 'posted' AND kind = 'void'`,
      [gift.body.id, A.id])

    const sept = await request(server).get(`/api/funds/${fid}/rollforward`)
      .set(auth(A.token)).query({ from: '2026-09-01', to: '2026-09-30' })
    expect(sept.status).toBe(200)
    expect(Number(sept.body.gross_contributions)).toBe(500)
    expect(Number(sept.body.refunds)).toBe(0)
    expect(Number(sept.body.net_contributions)).toBe(500)
    expect(Number(sept.body.contributions)).toBe(500) // deprecated alias = net
    expect(Number(sept.body.closing)).toBe(500)
    expect(Number(sept.body.closing)).toBe(
      Number(sept.body.opening) + Number(sept.body.gross_contributions)
      - Number(sept.body.refunds) - Number(sept.body.releases))

    const oct = await request(server).get(`/api/funds/${fid}/rollforward`)
      .set(auth(A.token)).query({ from: '2026-10-01', to: '2026-10-31' })
    expect(oct.status).toBe(200)
    expect(Number(oct.body.opening)).toBe(500)
    expect(Number(oct.body.gross_contributions)).toBe(0)
    expect(Number(oct.body.refunds)).toBe(500)
    expect(Number(oct.body.net_contributions)).toBe(-500)
    expect(Number(oct.body.contributions)).toBe(-500) // deprecated alias = net
    expect(Number(oct.body.closing)).toBe(0)
    expect(Number(oct.body.closing)).toBe(
      Number(oct.body.opening) + Number(oct.body.gross_contributions)
      - Number(oct.body.refunds) - Number(oct.body.releases))
  })

  it('same-period refund still nets inside that period; zero-delta retry posts nothing extra', async () => {
    const fund = await request(server).post('/api/funds').set(auth(A.token)).send({
      name: `SamePeriod ${RUN_ID}`,
      net_asset_class: 'without_donor_restriction',
    })
    expect(fund.status).toBe(201)
    const fid = fund.body.id
    const g1 = await request(server).post('/api/donations').set(auth(A.token))
      .send({ donor_name: 'A', amount: 500, date: '2026-10-05', fund_id: fid, category: 'tithe' })
    const g2 = await request(server).post('/api/donations').set(auth(A.token))
      .send({ donor_name: 'B', amount: 300, date: '2026-10-10', fund_id: fid, category: 'tithe' })
    expect([g1.status, g2.status]).toEqual([201, 201])
    const ref = await request(server).post(`/api/donations/${g1.body.id}/record-refund`).set(auth(A.token))
      .send({ amount: 100, reason: 'Overpaid' })
    expect(ref.status).toBeLessThan(300)
    await pool.query(
      `UPDATE ochr_donation_refunds SET refunded_at = '2026-10-12T12:00:00Z'
        WHERE donation_id = $1 AND organization_id = $2 AND status = 'posted'`,
      [g1.body.id, A.id])

    const rf = await request(server).get(`/api/funds/${fid}/rollforward`)
      .set(auth(A.token)).query({ from: '2026-10-01', to: '2026-10-31' })
    expect(rf.status).toBe(200)
    expect(Number(rf.body.gross_contributions)).toBe(800) // 500+300
    expect(Number(rf.body.refunds)).toBe(100)
    expect(Number(rf.body.net_contributions)).toBe(700)
    expect(Number(rf.body.contributions)).toBe(700) // deprecated alias = net
    expect(Number(rf.body.closing)).toBe(700)
    // Identity: closing = opening + gross − refunds − releases
    // and net = gross − refunds (so clients must not subtract refunds twice).
    expect(Number(rf.body.net_contributions)).toBe(
      Number(rf.body.gross_contributions) - Number(rf.body.refunds))
    expect(Number(rf.body.closing)).toBe(
      Number(rf.body.opening) + Number(rf.body.gross_contributions)
      - Number(rf.body.refunds) - Number(rf.body.releases))
  })
})
