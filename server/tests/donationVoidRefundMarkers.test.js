// Donation-log void and refund markers. A marker is a posted reversing
// fact. The gift row stays. No payment provider is called.
//
// The concurrency and over-refund cases are the guards. Falsify them by
// removing the remaining-amount check in postRecordedAdjustment AND
// replacing ochr_donation_refunds_cap() with `RETURN NEW`. Either guard
// alone still keeps Σ(posted) ≤ the gift, so a mutation of only one of
// them stays green. Both removed, these tests go red.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'
import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'
import { AdjustmentError, decimalToCents, postRecordedAdjustment } from '../src/finance/donationRefunds.js'

let server
const cleanup = []
let ipSeq = 0
const ip = () => `10.125.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`
const auth = t => ({ Authorization: `Bearer ${t}` })

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
}, 60_000)

afterAll(async () => {
  for (const id of cleanup) {
    await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
  }
  await closeServer(server)
  await pool.end()
})

async function signup(tag, name = 'Bookkeeper') {
  const res = await createOrg(server, {
    organizationName: `Markers ${tag} ${RUN_ID}`,
    name,
    email: `mark_${tag}_${RUN_ID}@example.com`,
    password: 'mark-pw-1',
  }, ip())
  expect(res.status).toBe(201)
  cleanup.push(res.body.user.organization.id)
  return {
    token: res.body.token,
    orgId: res.body.user.organization.id,
    userId: res.body.user.id,
    name,
  }
}

async function addUser(org, role, name, tag) {
  const email = `mark_${tag}_${RUN_ID}@example.com`
  const created = await request(server).post('/api/users').set(auth(org.token)).set('X-Forwarded-For', ip())
    .send({ name, email, password: 'mark-pw-1', role })
  expect(created.status).toBe(201)
  const logged = await request(server).post('/api/auth/login').set('X-Forwarded-For', ip())
    .send({ email, password: 'mark-pw-1' })
  expect(logged.status).toBe(200)
  return { token: logged.body.token, id: logged.body.user.id, name }
}

async function gift(par, amount, extra = {}) {
  const res = await request(server).post('/api/donations').set(auth(par.token)).send({
    donor_name: extra.name || `Donor ${RUN_ID}`,
    donor_email: extra.email,
    amount,
    category: 'tithe',
    method: extra.method || 'cash',
    ...(extra.date ? { date: extra.date } : {}),
  })
  expect(res.status).toBe(201)
  return res.body
}

const today = async () => (await pool.query(`SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS d`)).rows[0].d

const voidGift = (par, id, body = {}) =>
  request(server).post(`/api/donations/${id}/void`).set(auth(par.token)).send({ reason: 'Entered twice', ...body })
const refundGift = (par, id, body = {}) =>
  request(server).post(`/api/donations/${id}/record-refund`).set(auth(par.token)).send({ reason: 'Returned', ...body })

async function rowFacts(id) {
  const giftRow = await pool.query(
    `SELECT amount, payment_status, refunded_at, refund_ref FROM ochr_donations WHERE id = $1`, [id])
  const facts = await pool.query(
    `SELECT id, amount, kind, reason, status, recorded_by_user_id, recorded_by_name, idempotency_key
       FROM ochr_donation_refunds WHERE donation_id = $1 ORDER BY id`, [id])
  const live = await pool.query(
    `SELECT amount, refunded_total, live_amount FROM ochr_donation_live WHERE id = $1`, [id])
  return { gift: giftRow.rows[0], facts: facts.rows, live: live.rows[0] }
}

describe('125 migration', () => {
  it('follows 124, precedes 126, and re-runs as a no-op', async () => {
    const { MIGRATION_NAMES, EXPECTED_MIGRATION } = await import('../src/migrations/names.js')
    expect(EXPECTED_MIGRATION).toBe('144-online-giving-clearing')
    const i125 = MIGRATION_NAMES.indexOf('125-donation-void-refund-markers')
    expect(MIGRATION_NAMES[i125 - 1]).toBe('124-cash-count-void-requests')
    expect(MIGRATION_NAMES[i125 + 1]).toBe('126-mass-intention-offering-history')
    const { up } = await import('../src/migrations/125-donation-void-refund-markers.js')
    await up(); await up()
    const fk = await pool.query(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname = 'ochr_donation_refunds_recorded_by_fk'`)
    expect(fk.rows[0].def).toMatch(/organization_id/)
    expect(fk.rows[0].def).toMatch(/ochr_users/)
  })
})

describe('decimal amounts are cents, and extra digits are refused', () => {
  it('accepts a two-place decimal and rejects a longer one', () => {
    expect(decimalToCents('10.10')).toBe(1010)
    expect(decimalToCents('60')).toBe(6000)
    expect(decimalToCents('0.00')).toBe(0)
    expect(decimalToCents('10.019')).toBeNull()
    expect(decimalToCents(true)).toBeNull()
    expect(decimalToCents('')).toBeNull()
  })
})

describe('a recorded gift can be voided or refunded without rewriting it', () => {
  let par, staff, viewer, other
  beforeAll(async () => {
    par = await signup('main', 'Ada Admin')
    staff = await addUser(par, 'staff', 'Sam Staff', 'staff')
    viewer = await addUser(par, 'viewer', 'Val Viewer', 'viewer')
    other = await signup('other', 'Other Admin')
  }, 30_000)

  it('void records who, when, and why, and leaves the gift row', async () => {
    const day = await today()
    const g = await gift(par, 80, { name: 'Voided Donor', date: day })
    const before = await request(server).get('/api/donations/summary').set(auth(par.token))
    const res = await voidGift(par, g.id, { reason: '  Wrong envelope  ' })
    expect(res.status).toBe(200)
    expect(res.body.replayed).toBe(false)
    expect(res.body.reversal.kind).toBe('void')
    expect(res.body.reversal.reason).toBe('Wrong envelope')
    expect(res.body.reversal.recorded_by_name).toBe('Ada Admin')
    expect(res.body.reversal.refunded_at).toBeTruthy()
    expect(res.body.provider_notice).toBeNull()
    expect(Number(res.body.donation.amount)).toBe(80)
    expect(res.body.donation.books.marker).toBe('voided')
    expect(Number(res.body.donation.books.live_amount)).toBe(0)
    expect(res.body.donation.books.void_reason).toBe('Wrong envelope')

    const { gift: stored, facts, live } = await rowFacts(g.id)
    expect(Number(stored.amount)).toBe(80)
    expect(stored.payment_status).toBeNull()
    expect(stored.refunded_at).toBeNull()
    expect(facts).toHaveLength(1)
    expect(facts[0].kind).toBe('void')
    expect(Number(facts[0].recorded_by_user_id)).toBe(Number(par.userId))
    expect(Number(live.amount)).toBe(80)
    expect(Number(live.live_amount)).toBe(0)

    const after = await request(server).get('/api/donations/summary').set(auth(par.token))
    expect(Number(after.body.month_total)).toBeCloseTo(Number(before.body.month_total) - 80, 2)

    const list = await request(server).get('/api/donations').set(auth(par.token))
    const listed = list.body.find(r => String(r.id) === String(g.id))
    expect(listed.donor_name).toBe('Voided Donor')
    expect(Number(listed.amount)).toBe(80)
    expect(listed.books.marker).toBe('voided')

    const again = await voidGift(par, g.id, { reason: 'Again' })
    expect(again.status).toBe(409)
    expect(again.body.error).toMatch(/already voided/i)
    expect((await rowFacts(g.id)).facts).toHaveLength(1)

    const removed = await request(server).delete(`/api/donations/${g.id}`).set(auth(par.token))
    expect(removed.status).toBe(409)
    expect((await rowFacts(g.id)).gift).toBeTruthy()
  })

  it('a partial refund nets the totals and a further refund past the remainder is refused', async () => {
    const day = await today()
    const g = await gift(par, 100, { name: 'Partial Donor', date: day })
    const before = await request(server).get('/api/donations/summary').set(auth(par.token))
    const first = await refundGift(par, g.id, { amount: '30.00', reason: 'One envelope back' })
    expect(first.status).toBe(200)
    expect(first.body.donation.books.marker).toBe('partial')
    expect(Number(first.body.donation.books.refunded_total)).toBe(30)
    expect(Number(first.body.donation.books.live_amount)).toBe(70)
    expect(Number(first.body.donation.amount)).toBe(100)
    expect(first.body.reversal.recorded_by_name).toBe('Ada Admin')

    const mid = await request(server).get('/api/donations/summary').set(auth(par.token))
    expect(Number(mid.body.month_total)).toBeCloseTo(Number(before.body.month_total) - 30, 2)

    const funds = await request(server).get('/api/donations/by-fund?days=30').set(auth(par.token))
    const tithe = funds.body.funds.find(f => f.category === 'tithe')
    expect(tithe).toBeTruthy()

    const over = await refundGift(par, g.id, { amount: '70.01', reason: 'Too much' })
    expect(over.status).toBe(409)
    expect(over.body.error).toMatch(/more than what remains/i)
    const { gift: stored, facts, live } = await rowFacts(g.id)
    expect(Number(stored.amount)).toBe(100)
    expect(stored.refunded_at).toBeNull()
    expect(facts).toHaveLength(1)
    expect(Number(live.live_amount)).toBe(70)

    const rest = await refundGift(par, g.id, { amount: '70.00', reason: 'The rest' })
    expect(rest.status).toBe(200)
    expect(rest.body.donation.books.marker).toBe('refunded')
    expect(Number(rest.body.donation.amount)).toBe(100)
    expect((await rowFacts(g.id)).facts).toHaveLength(2)
  })

  it('the same idempotency key does not post a second refund', async () => {
    const g = await gift(par, 50, { name: 'Idem Donor' })
    const body = { amount: '10.00', reason: 'Once', idempotency_key: `same-${RUN_ID}-10` }
    const a = await refundGift(par, g.id, body)
    const b = await refundGift(par, g.id, body)
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(b.body.replayed).toBe(true)
    expect(String(b.body.reversal.id)).toBe(String(a.body.reversal.id))
    expect((await rowFacts(g.id)).facts).toHaveLength(1)

    const otherAmount = await refundGift(par, g.id, { ...body, amount: '12.00' })
    expect(otherAmount.status).toBe(409)
    expect((await rowFacts(g.id)).facts).toHaveLength(1)
  })

  it('the same idempotency key does not post a second void; a new attempt is rejected', async () => {
    const g = await gift(par, 20, { name: 'Idem Void' })
    const key = `void-${RUN_ID}-once`
    const a = await voidGift(par, g.id, { reason: 'Duplicate', idempotency_key: key })
    const b = await voidGift(par, g.id, { reason: 'Duplicate', idempotency_key: key })
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(b.body.replayed).toBe(true)
    expect((await rowFacts(g.id)).facts).toHaveLength(1)
    const fresh = await voidGift(par, g.id, { reason: 'Another try', idempotency_key: `${key}-b` })
    expect(fresh.status).toBe(409)
    expect((await rowFacts(g.id)).facts).toHaveLength(1)
  })

  it('refuses a refund with no reason, a void of another parish, and staff or a viewer', async () => {
    const g = await gift(par, 15, { name: 'Guarded Donor' })
    expect((await refundGift(par, g.id, { reason: '   ' })).status).toBe(422)
    expect((await voidGift(par, g.id, { reason: '' })).status).toBe(422)
    const cross = await voidGift(other, g.id, { reason: 'Not yours' })
    expect(cross.status).toBe(404)
    expect((await voidGift(staff, g.id, { reason: 'Staff' })).status).toBe(403)
    expect((await refundGift(viewer, g.id, { reason: 'Viewer', amount: '1.00' })).status).toBe(403)
    expect((await rowFacts(g.id)).facts).toHaveLength(0)
    expect(Number((await rowFacts(g.id)).gift.amount)).toBe(15)
  })

  it('an online gift is marked only, and the provider is not called', async () => {
    const previous = process.env.PAYMENTS_PROVIDER
    process.env.PAYMENTS_PROVIDER = 'marker-probe-not-a-provider'
    try {
      const g = await gift(par, 40, { name: 'Online Donor', method: 'online' })
      await pool.query(
        `UPDATE ochr_donations SET source = 'online', payment_ref = $2, payment_status = 'succeeded' WHERE id = $1`,
        [g.id, `pi_marker_${RUN_ID}`]
      )
      const res = await refundGift(par, g.id, { amount: '40.00', reason: 'Donor asked' })
      expect(res.status).toBe(200)
      expect(res.body.provider_notice).toMatch(/payment provider/i)
      expect(res.body.donation.payment_status).toBe('succeeded')
      expect(res.body.donation.books.marker).toBe('refunded')
      const { gift: stored, facts } = await rowFacts(g.id)
      expect(stored.payment_status).toBe('succeeded')
      expect(stored.refund_ref).toBeNull()
      expect(stored.refunded_at).toBeNull()
      expect(facts[0].kind).toBe('refund')
      expect(Number(facts[0].amount)).toBe(40)
    } finally {
      if (previous === undefined) delete process.env.PAYMENTS_PROVIDER
      else process.env.PAYMENTS_PROVIDER = previous
    }
  })

  it('a cash-count gift is voided with the count, not from the donation row', async () => {
    const created = await request(server).post('/api/donations/cash-counts').set(auth(par.token))
      .send({ service_name: `Count ${RUN_ID}`, counted_by: 'Ada Admin', total: 25 })
    expect(created.status).toBe(201)
    const confirmed = await request(server).patch(`/api/donations/cash-counts/${created.body.id}/confirm`)
      .set(auth(par.token)).send({ single_count: true })
    expect(confirmed.status).toBe(200)
    const donationId = confirmed.body.donation.id
    const res = await voidGift(par, donationId, { reason: 'From the log' })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/cash count/i)
    expect((await rowFacts(donationId)).facts).toHaveLength(0)
  })

  it('an issued statement is flagged and not rewritten', async () => {
    const email = `stmt_${RUN_ID}@example.com`
    const g = await gift(par, 250, { name: 'Rosa Vega', email, date: '2026-06-01' })
    const issued = await request(server).post('/api/giving-statements/issue').set(auth(par.token))
      .send({ year: 2026, key: email, by: 'email', issue_key: `ik-mark-${RUN_ID}` })
    expect(issued.status).toBe(201)
    const before = issued.body.statement.snapshot_json
    const res = await voidGift(par, g.id, { reason: 'Recorded after the statement' })
    expect(res.status).toBe(200)
    expect(res.body.issued_statements).toHaveLength(1)
    expect(String(res.body.issued_statements[0].id)).toBe(String(issued.body.statement.id))

    const again = await request(server).get(`/api/giving-statements/issued/${issued.body.statement.id}`)
      .set(auth(par.token))
    expect(again.status).toBe(200)
    expect(again.body.statement.status).toBe('issued')
    expect(again.body.statement.snapshot_json).toEqual(before)
    expect(again.body.statement.superseded_at ?? null).toBeNull()

    const list = await request(server).get('/api/donations').set(auth(par.token))
    const listed = list.body.find(r => String(r.id) === String(g.id))
    expect(listed.books.statement_drift).toBe(true)
    expect(Number(listed.amount)).toBe(250)

    const preview = await request(server).get('/api/giving-statements/donor')
      .query({ key: email, year: 2026, by: 'email' }).set(auth(par.token))
    expect(preview.status).toBe(200)
    expect(Number(preview.body.total)).toBe(0)
    expect(Number(before.total)).toBe(250)
  })
})

describe('concurrent refunds cannot pass what remains', () => {
  let par
  beforeAll(async () => {
    par = await signup('race', 'Race Admin')
  }, 30_000)

  async function insertGift(amount) {
    const { rows } = await pool.query(
      `INSERT INTO ochr_donations (organization_id, donor_name, amount, category, method, date)
       VALUES ($1, 'Race Donor', $2, 'tithe', 'cash', CURRENT_DATE)
       RETURNING id`,
      [par.orgId, amount]
    )
    return rows[0].id
  }

  it('two concurrent $60 refunds on $100 post one fact', async () => {
    const donationId = await insertGift('100.00')
    const c1 = await pool.connect()
    const c2 = await pool.connect()
    const actor = { id: par.userId, name: par.name }
    try {
      await c2.query(`SET statement_timeout = '8s'`)
      const { rows: pidRows } = await c2.query('SELECT pg_backend_pid() AS pid')
      const pid = Number(pidRows[0].pid)
      await c1.query('BEGIN')
      const first = await postRecordedAdjustment(c1, {
        organizationId: par.orgId,
        donationId,
        kind: 'refund',
        amountCents: 6000,
        reason: 'First of the race',
        actor,
        idempotencyKey: `race-a-${RUN_ID}-${donationId}`,
      })
      expect(first.replayed).toBe(false)

      const secondP = (async () => {
        await c2.query('BEGIN')
        try {
          const reversal = await postRecordedAdjustment(c2, {
            organizationId: par.orgId,
            donationId,
            kind: 'refund',
            amountCents: 6000,
            reason: 'Second of the race',
            actor,
            idempotencyKey: `race-b-${RUN_ID}-${donationId}`,
          })
          await c2.query('COMMIT')
          return { ok: true, reversal }
        } catch (err) {
          await c2.query('ROLLBACK').catch(() => {})
          return { ok: false, err }
        }
      })()

      const started = Date.now()
      let blocked = false
      while (Date.now() - started < 4000) {
        const { rows } = await pool.query(
          `SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1`, [pid])
        if (rows[0]?.wait_event_type === 'Lock') { blocked = true; break }
        await new Promise(r => setTimeout(r, 20))
      }
      expect(blocked).toBe(true)
      await c1.query('COMMIT')
      const second = await secondP
      expect(second.ok).toBe(false)
      expect(second.err).toBeInstanceOf(AdjustmentError)
      expect(second.err.status).toBe(409)

      const { rows } = await pool.query(
        `SELECT count(*)::int AS n, COALESCE(SUM(amount), 0) AS total
           FROM ochr_donation_refunds
          WHERE donation_id = $1 AND status = 'posted'`,
        [donationId]
      )
      expect(rows[0].n).toBe(1)
      expect(Number(rows[0].total)).toBe(60)
    } finally {
      await c1.query('ROLLBACK').catch(() => {})
      await c2.query('ROLLBACK').catch(() => {})
      c1.release()
      c2.release()
    }
  }, 20_000)

  it('a refund larger than the gift posts nothing', async () => {
    const donationId = await insertGift('50.00')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await expect(postRecordedAdjustment(client, {
        organizationId: par.orgId,
        donationId,
        kind: 'refund',
        amountCents: 5001,
        reason: 'Over',
        actor: { id: par.userId, name: par.name },
        idempotencyKey: `over-${RUN_ID}-${donationId}`,
      })).rejects.toMatchObject({ status: 409 })
      await client.query('ROLLBACK')
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM ochr_donation_refunds WHERE donation_id = $1`, [donationId])
    expect(rows[0].n).toBe(0)
    const giftRow = await pool.query(`SELECT amount FROM ochr_donations WHERE id = $1`, [donationId])
    expect(Number(giftRow.rows[0].amount)).toBe(50)
  })
})
