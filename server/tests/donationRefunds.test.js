// GIV-06 Atlas OPTION A — a refund is a new linked financial fact.
//
// CLAIM. $100 gift + $30 refund ≠ $70 gift. Three facts: the gift, the
// refund, and the derived net. gift.amount is never rewritten. A refunded
// gift stays in the live books, including when net=0.
//
// Pattern matches financialTruth.test.js / periodAdjustment.test.js /
// falseSuccessMoney.test.js: each block signs up its own parish.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'
import { backfillStampedRefunds } from '../src/migrations/104-donation-refund-facts.js'

let server
const cleanupOrgIds = []

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
}, 60_000)

afterAll(async () => {
  for (const id of cleanupOrgIds) {
    await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
  }
  await closeServer(server)
  await pool.end()
})

let ipSeq = 0
const ip = () => `10.64.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`
const auth = t => ({ Authorization: `Bearer ${t}` })

async function signup(payload) {
  const res = await createOrg(server, payload, ip())
  expect(res.status).toBe(201)
  cleanupOrgIds.push(res.body.user.organization.id)
  return {
    token: res.body.token,
    orgId: res.body.user.organization.id,
    slug: res.body.user.organization.slug,
  }
}

async function mkFund(par, name) {
  const r = await request(server).post('/api/funds').set(auth(par.token)).send({ name })
  expect(r.status).toBe(201)
  return r.body
}

async function chargedGift(par, fund, donorName, amount = 100) {
  const r = await request(server).post(`/api/public/${par.slug}/give`)
    .set('X-Forwarded-For', ip())
    .send({ fund_id: fund.id, amount, donor_name: donorName })
  expect(r.status).toBe(201)
  const { rows } = await pool.query(
    'SELECT id, amount, payment_status FROM ochr_donations WHERE organization_id = $1 AND payment_ref = $2',
    [par.orgId, r.body.receipt.reference])
  return rows[0]
}

const refund = (par, id, body = {}) =>
  request(server).post(`/api/donations/${id}/refund`).set(auth(par.token)).send(body)

async function facts(donationId) {
  const gift = await pool.query(
    'SELECT id, amount, payment_status, refunded_at, refund_ref FROM ochr_donations WHERE id = $1', [donationId])
  const refunds = await pool.query(
    `SELECT id, amount, status, refund_ref FROM ochr_donation_refunds
      WHERE donation_id = $1 ORDER BY id`, [donationId])
  const live = await pool.query(
    'SELECT amount, refunded_total, live_amount FROM ochr_donation_live WHERE id = $1', [donationId])
  return { gift: gift.rows[0], refunds: refunds.rows, live: live.rows[0] }
}

describe('Option A — partial refund is three facts, not a rewritten gift', () => {
  let par, fund
  beforeAll(async () => {
    process.env.PAYMENTS_PROVIDER = 'stub'
    par = await signup({ organizationName: `OA partial Parish ${RUN_ID}`, name: 'Bookkeeper',
      email: `oa_part_${RUN_ID}@example.com`, password: 'oa-pw-part-1' })
    fund = await mkFund(par, `General ${RUN_ID}`)
  }, 30_000)
  afterAll(() => { delete process.env.PAYMENTS_PROVIDER })

  it('$100 gift + $30 refund leaves gift.amount=100, one refund row, live=70', async () => {
    const gift = await chargedGift(par, fund, 'OA Thirty', 100)
    const res = await refund(par, gift.id, { amount: 30 })
    expect(res.status).toBe(200)
    expect(Number(res.body.amount)).toBe(100)
    expect(res.body.payment_status).not.toBe('refunded')
    expect(Number(res.body.refund.amount)).toBe(30)
    expect(Number(res.body.refunded_total)).toBe(30)
    expect(Number(res.body.live_amount)).toBe(70)

    const { gift: row, refunds, live } = await facts(gift.id)
    expect(Number(row.amount)).toBe(100)
    expect(row.payment_status).toBe('succeeded')
    expect(refunds).toHaveLength(1)
    expect(Number(refunds[0].amount)).toBe(30)
    expect(refunds[0].status).toBe('posted')
    expect(Number(live.amount)).toBe(100)
    expect(Number(live.refunded_total)).toBe(30)
    expect(Number(live.live_amount)).toBe(70)
  })

  it('a second partial within remaining posts; a third that would exceed is 409', async () => {
    const gift = await chargedGift(par, fund, 'OA Second', 100)
    expect((await refund(par, gift.id, { amount: 40 })).status).toBe(200)
    const second = await refund(par, gift.id, { amount: 40 })
    expect(second.status).toBe(200)
    expect(Number(second.body.live_amount)).toBe(20)
    expect(Number(second.body.amount)).toBe(100)

    const over = await refund(par, gift.id, { amount: 30 })
    expect(over.status).toBe(409)
    expect(over.body.error).toMatch(/exceed|already refunded/i)

    const { gift: row, refunds, live } = await facts(gift.id)
    expect(Number(row.amount)).toBe(100)
    expect(refunds).toHaveLength(2)
    expect(Number(live.live_amount)).toBe(20)
  })

  it('a full refund stamps the gift and keeps it visible at live=0', async () => {
    const gift = await chargedGift(par, fund, 'OA Full', 80)
    const res = await refund(par, gift.id, {})
    expect(res.status).toBe(200)
    expect(res.body.payment_status).toBe('refunded')
    expect(Number(res.body.amount)).toBe(80)
    expect(Number(res.body.live_amount)).toBe(0)

    const { gift: row, refunds, live } = await facts(gift.id)
    expect(Number(row.amount)).toBe(80)
    expect(row.payment_status).toBe('refunded')
    expect(refunds).toHaveLength(1)
    expect(Number(refunds[0].amount)).toBe(80)
    expect(Number(live.live_amount)).toBe(0)

    const summary = await request(server).get('/api/donations/summary').set(auth(par.token))
    expect(summary.status).toBe(200)
    expect(Number(summary.body.total_count)).toBeGreaterThanOrEqual(1)

    const list = await request(server).get('/api/donations').set(auth(par.token))
    const listed = list.body.find(r => String(r.id) === String(gift.id))
    expect(listed).toBeTruthy()
    expect(Number(listed.amount)).toBe(80)
    expect(listed.payment_status).toBe('refunded')
  })

  it('over-refund of a fresh gift is 409 and writes no fact', async () => {
    const gift = await chargedGift(par, fund, 'OA Over', 50)
    const res = await refund(par, gift.id, { amount: 50.01 })
    expect(res.status).toBe(409)
    const { gift: row, refunds } = await facts(gift.id)
    expect(Number(row.amount)).toBe(50)
    expect(row.payment_status).toBe('succeeded')
    expect(refunds).toHaveLength(0)
  })
})

describe('Option A — concurrent partials cannot exceed the gift', () => {
  let par, fund
  beforeAll(async () => {
    process.env.PAYMENTS_PROVIDER = 'stub'
    par = await signup({ organizationName: `OA race Parish ${RUN_ID}`, name: 'Bookkeeper',
      email: `oa_race_${RUN_ID}@example.com`, password: 'oa-pw-race-1' })
    fund = await mkFund(par, `Race ${RUN_ID}`)
  }, 30_000)
  afterAll(() => { delete process.env.PAYMENTS_PROVIDER })

  it('two concurrent $60 refunds on $100 → one 200, one 409, Σ ≤ 100', async () => {
    const gift = await chargedGift(par, fund, 'OA Race', 100)
    const [a, b] = await Promise.all([
      refund(par, gift.id, { amount: 60 }),
      refund(par, gift.id, { amount: 60 }),
    ])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    const { gift: row, refunds, live } = await facts(gift.id)
    expect(Number(row.amount)).toBe(100)
    expect(refunds.filter(r => r.status === 'posted')).toHaveLength(1)
    expect(Number(live.refunded_total)).toBe(60)
    expect(Number(live.live_amount)).toBe(40)
  })
})

describe('Option A — tenancy, undeletable charged gifts, backfill', () => {
  let par, other, fund
  beforeAll(async () => {
    process.env.PAYMENTS_PROVIDER = 'stub'
    par = await signup({ organizationName: `OA ten Parish ${RUN_ID}`, name: 'Bookkeeper',
      email: `oa_ten_${RUN_ID}@example.com`, password: 'oa-pw-ten-1' })
    other = await signup({ organizationName: `OA ten Other ${RUN_ID}`, name: 'Other Admin',
      email: `oa_ten_o_${RUN_ID}@example.com`, password: 'oa-pw-ten-2' })
    fund = await mkFund(par, `Ten ${RUN_ID}`)
  }, 30_000)
  afterAll(() => { delete process.env.PAYMENTS_PROVIDER })

  it('cross-tenant refund is 404 and writes nothing', async () => {
    const gift = await chargedGift(par, fund, 'OA Tenant', 25)
    const res = await refund(other, gift.id, { amount: 25 })
    expect(res.status).toBe(404)
    const { refunds, gift: row } = await facts(gift.id)
    expect(refunds).toHaveLength(0)
    expect(Number(row.amount)).toBe(25)
    expect(row.payment_status).toBe('succeeded')
  })

  it('a charged gift stays undeletable before and after a refund', async () => {
    const gift = await chargedGift(par, fund, 'OA Keep', 15)
    const before = await request(server).delete(`/api/donations/${gift.id}`).set(auth(par.token))
    expect(before.status).toBe(409)
    expect(before.body.error).toMatch(/refund/i)

    expect((await refund(par, gift.id, {})).status).toBe(200)
    const after = await request(server).delete(`/api/donations/${gift.id}`).set(auth(par.token))
    expect(after.status).toBe(409)
    const { gift: row } = await facts(gift.id)
    expect(row).toBeTruthy()
    expect(Number(row.amount)).toBe(15)
  })

  it('backfill writes one full refund per stamped gift and invents no partials', async () => {
    const { rows } = await pool.query(
      `INSERT INTO ochr_donations
         (organization_id, donor_name, amount, category, method, date,
          source, payment_ref, payment_status, refunded_at, refund_ref)
       VALUES ($1, 'OA Legacy Stamp', 77.50, 'tithe', 'online', CURRENT_DATE,
               'online', $2, 'refunded', NOW(), $3)
       RETURNING id, amount`,
      [par.orgId, `oa_backfill_${RUN_ID}`, `legacy-ref-${RUN_ID}`])
    const id = rows[0].id
    const before = await pool.query(
      'SELECT count(*)::int AS n FROM ochr_donation_refunds WHERE donation_id = $1', [id])
    expect(before.rows[0].n).toBe(0)

    const filled = await backfillStampedRefunds(pool)
    expect(filled).toBeGreaterThanOrEqual(1)
    const again = await backfillStampedRefunds(pool)
    expect(again).toBe(0)

    const { gift: row, refunds, live } = await facts(id)
    expect(Number(row.amount)).toBe(77.5)
    expect(refunds).toHaveLength(1)
    expect(Number(refunds[0].amount)).toBe(77.5)
    expect(refunds[0].refund_ref).toBe(`legacy-ref-${RUN_ID}`)
    expect(Number(live.live_amount)).toBe(0)
  })
})

describe('Option A — live aggregates keep the gift and net the refund', () => {
  let par, fund, giftId
  const email = `oa_agg_${RUN_ID}@example.com`
  beforeAll(async () => {
    process.env.PAYMENTS_PROVIDER = 'stub'
    par = await signup({ organizationName: `OA agg Parish ${RUN_ID}`, name: 'Bookkeeper',
      email: `oa_agg_${RUN_ID}@example.com`, password: 'oa-pw-agg-1' })
    fund = await mkFund(par, `Agg ${RUN_ID}`)
    const gift = await chargedGift(par, fund, 'OA Aggregates', 100)
    giftId = gift.id
    await pool.query('UPDATE ochr_donations SET donor_email = $2 WHERE id = $1', [giftId, email])
    expect((await refund(par, giftId, { amount: 30 })).status).toBe(200)
  }, 30_000)
  afterAll(() => { delete process.env.PAYMENTS_PROVIDER })

  it('summary / by-fund / statement / ledger net $70 and still list the gift', async () => {
    const year = new Date().getFullYear()
    const summary = await request(server).get('/api/donations/summary').set(auth(par.token))
    expect(Number(summary.body.largest)).toBeGreaterThanOrEqual(70)

    const byFund = await request(server).get('/api/donations/by-fund?days=365').set(auth(par.token))
    const row = byFund.body.funds.find(f => f.category === `Agg ${RUN_ID}`)
    expect(row).toBeTruthy()
    expect(Number(row.total)).toBe(70)
    expect(Number(row.count)).toBe(1)

    const preview = await request(server)
      .get(`/api/giving-statements/preview?year=${year}`).set(auth(par.token))
    const donor = preview.body.donors.find(d => d.donor_email === email)
    expect(donor).toBeTruthy()
    expect(Number(donor.total)).toBe(70)
    expect(Number(donor.gift_count)).toBe(1)

    const statement = await request(server)
      .get(`/api/giving-statements/donor?year=${year}&key=${encodeURIComponent(email)}`)
      .set(auth(par.token))
    expect(statement.status).toBe(200)
    expect(Number(statement.body.total)).toBe(70)
    expect(statement.body.gift_count).toBe(1)
    const line = statement.body.lines.find(l => String(l.id) === String(giftId))
    expect(line).toBeTruthy()
    expect(Number(line.amount)).toBe(100)
    expect(Number(line.live_amount)).toBe(70)

    const { rows: gifts } = await pool.query(
      `SELECT amount FROM ochr_parish_ledger
        WHERE organization_id = $1 AND source_type = 'donation' AND source_id = $2`,
      [par.orgId, giftId])
    expect(gifts).toHaveLength(1)
    expect(Number(gifts[0].amount)).toBe(100)
    const { rows: refunds } = await pool.query(
      `SELECT l.amount FROM ochr_parish_ledger l
         JOIN ochr_donation_refunds r ON r.id = l.source_id
        WHERE l.organization_id = $1 AND l.source_type = 'donation_refund'
          AND r.donation_id = $2`,
      [par.orgId, giftId])
    expect(refunds).toHaveLength(1)
    expect(Number(refunds[0].amount)).toBe(-30)

    const fin = await request(server).get('/api/finance/mappings').set(auth(par.token))
    const mapped = (fin.body.funds ?? []).find(f => Number(f.id) === Number(fund.id))
    expect(mapped).toBeTruthy()
    expect(Number(mapped.gift_total)).toBe(70)
  })

  it('period adjustments are not added into live net', async () => {
    const { rows } = await pool.query(
      `SELECT pg_get_viewdef('ochr_parish_ledger', true) AS def`)
    expect(rows[0].def).not.toMatch(/ochr_period_adjustments/)
    const { rows: giftNet } = await pool.query(
      `SELECT COALESCE(SUM(l.amount), 0)::numeric(12,2) AS n
         FROM ochr_parish_ledger l
        WHERE l.organization_id = $1
          AND (
            (l.source_type = 'donation' AND l.source_id = $2)
            OR (l.source_type = 'donation_refund' AND l.source_id IN (
              SELECT id FROM ochr_donation_refunds WHERE donation_id = $2
            ))
          )`,
      [par.orgId, giftId])
    expect(Number(giftNet[0].n)).toBeCloseTo(70, 2)
  })
})

describe('Option A — money-invariants scanner', () => {
  it('asserts gift − Σ posted refunds, not omit-by-refunded', async () => {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const run = promisify(execFile)
    const script = new URL('../../scripts/money-invariants.mjs', import.meta.url).pathname
    let out = ''
    try {
      const r = await run(process.execPath, [script, '--list'],
        { cwd: new URL('../../', import.meta.url).pathname })
      out = r.stdout
    } catch (err) {
      throw new Error(`money-invariants failed:\n${err.stdout || ''}${err.stderr || ''}`)
    }
    expect(out).toMatch(/Option A/)
    expect(out).not.toMatch(/all exclude refunded gifts/)
    const n = Number(out.match(/(\d+) donation aggregates/)?.[1] ?? 0)
    expect(n, 'the scanner examined nothing').toBeGreaterThanOrEqual(6)
  })
})
