// Financial truth — five places where a number that leaves the building
// could be wrong without anybody being told.
//
// Each block names the defect it closes, reproduced on 1 Sep against the
// real routes on local Postgres before anything was touched:
//
//   D1  Overlapping approved periods were SUMMED into the assessable base.
//       fiscalPeriod.js says in its own words that approved periods "must
//       be a partition", and the only thing enforcing it was a UNIQUE on
//       the exact (start, end) pair. FY + H2 + Q1 for one year: all three
//       accepted, all three approved, base 30,000 → 60,000.
//   D2  A gift the provider actually charged could be DELETED with no
//       refund, and a refunded gift's row — the only trace of the refund —
//       could be deleted too. A recurring-source gift, charged by the cron,
//       could not be refunded in-app at all.
//   D3  Deleting a fund SET NULL'd its gifts' fund_id, and the ledger view
//       fell back to the default account 4420 — assessable. A restricted
//       gift became diocesan revenue on one click.
//   D4  The billing webhook answered 200 to every non-signature failure,
//       citing a retry-from-our-side that does not exist anywhere in the
//       codebase. Money moved, the row failed, the provider was told "done".
//   D5  /api/health said payments_provider 'stub' both when someone chose
//       the stub and when nobody chose anything — which is production.
//
// Every block signs up its own orgs and shares nothing with the rest of
// the suite, in the pattern of diocese.test.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'
import crypto from 'node:crypto'

import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'

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
async function signup(payload) {
  const res = await createOrg(server, payload, `10.61.7.${++ipSeq}`)
  expect(res.status).toBe(201)
  cleanupOrgIds.push(res.body.user.organization.id)
  return { token: res.body.token, orgId: res.body.user.organization.id, slug: res.body.user.organization.slug }
}

// Diocese + parish, affiliated at 'detail'.
async function affiliatedPair(tag) {
  const email = `ft_${tag}_par_${RUN_ID}@example.com`
  const dio = await signup({ organizationName: `FT ${tag} Diocese ${RUN_ID}`, name: 'Canon',
    email: `ft_${tag}_dio_${RUN_ID}@example.com`, password: 'ft-pw-dio-1', organizationType: 'diocese' })
  const par = await signup({ organizationName: `FT ${tag} Parish ${RUN_ID}`, name: 'Parish Admin',
    email, password: 'ft-pw-par-1' })
  const inv = await request(server).post('/api/diocese/parishes/invite')
    .set('Authorization', `Bearer ${dio.token}`).send({ email })
  expect(inv.status).toBeLessThan(300)
  const acc = await request(server).post('/api/affiliation/accept')
    .set('Authorization', `Bearer ${par.token}`).send({ grant_level: 'detail' })
  expect(acc.status).toBe(200)
  return { dio, par }
}

const auth = t => ({ Authorization: `Bearer ${t}` })

// ─────────────────────────────────────────────────────────────────────────
// D1 — a parish's submitted/approved periods must not overlap
// ─────────────────────────────────────────────────────────────────────────
describe('D1 — overlapping period submissions are refused, so a parish is billed once', () => {
  let dio, par

  const submit = (start, end) => request(server).post('/api/finance/submissions')
    .set(auth(par.token)).send({ period_start: start, period_end: end })
  const review = (id, body) => request(server).patch(`/api/diocese/submissions/${id}`)
    .set(auth(dio.token)).send(body)
  const gift = (amount, date) => request(server).post('/api/donations')
    .set(auth(par.token)).send({ donor_name: 'Partition Donor', amount, date })

  beforeAll(async () => {
    ;({ dio, par } = await affiliatedPair('d1'))
    // 2023: 30,000 in June — the reproduced figure.
    expect((await gift(30000, '2023-06-15')).status).toBe(201)
    // 2020: two quarters that must be counted exactly once each.
    expect((await gift(10000, '2020-02-01')).status).toBe(201)
    expect((await gift(20000, '2020-05-01')).status).toBe(201)
  }, 30_000)

  it('FY approved, then H2 of the same year → 409 naming the approved period', async () => {
    const fy = await submit('2023-01-01', '2023-12-31')
    expect(fy.status).toBe(201)
    expect((await review(fy.body.id, { status: 'approved' })).status).toBe(200)

    const h2 = await submit('2023-07-01', '2023-12-31')
    expect(h2.status).toBe(409)
    expect(h2.body.error).toMatch(/overlaps/i)
    expect(h2.body.error).toContain('2023-01-01 – 2023-12-31')
    expect(h2.body.error).toContain('approved')

    // And a straddling period that merely touches it is refused too.
    const straddle = await submit('2023-12-01', '2024-02-28')
    expect(straddle.status).toBe(409)

    // Nothing extra reached the table.
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM ochr_report_submissions
        WHERE organization_id = $1 AND period_end >= '2023-01-01' AND period_start <= '2024-12-31'`,
      [par.orgId])
    expect(rows[0].n).toBe(1)
  })

  it('Q1 merely SUBMITTED (not approved), then FY → 409 naming the submitted period', async () => {
    const q1 = await submit('2022-01-01', '2022-03-31')
    expect(q1.status).toBe(201)
    const fy = await submit('2022-01-01', '2022-12-31')
    expect(fy.status).toBe(409)
    expect(fy.body.error).toContain('2022-01-01 – 2022-03-31')
    expect(fy.body.error).toContain('submitted')
  })

  it('a RETURNED period does not block — the chancery has said "not this one"', async () => {
    const { rows } = await pool.query(
      `SELECT id FROM ochr_report_submissions
        WHERE organization_id = $1 AND period_start = '2022-01-01' AND period_end = '2022-03-31'`,
      [par.orgId])
    expect((await review(rows[0].id, { status: 'returned', note: 'File the full year instead' })).status).toBe(200)

    const fy = await submit('2022-01-01', '2022-12-31')
    expect(fy.status).toBe(201)
  })

  it('the identical-period resubmit path is unchanged', async () => {
    const q1 = await submit('2021-01-01', '2021-03-31')
    expect(q1.status).toBe(201)
    // Same period again while submitted: the OLD message, from the ON CONFLICT path.
    const dupe = await submit('2021-01-01', '2021-03-31')
    expect(dupe.status).toBe(409)
    expect(dupe.body.error).toMatch(/already submitted or approved/)
    // Returned → resubmit in place.
    expect((await review(q1.body.id, { status: 'returned', note: 'Fix the memo line' })).status).toBe(200)
    const again = await submit('2021-01-01', '2021-03-31')
    expect(again.status).toBe(201)
    expect(again.body.id).toBe(q1.body.id)
    expect(again.body.status).toBe('submitted')
  })

  it('two non-overlapping quarters are both accepted and the base is their sum, once', async () => {
    const q1 = await submit('2020-01-01', '2020-03-31')
    const q2 = await submit('2020-04-01', '2020-06-30')
    expect(q1.status).toBe(201)
    expect(q2.status).toBe(201)
    expect((await review(q1.body.id, { status: 'approved' })).status).toBe(200)
    expect((await review(q2.body.id, { status: 'approved' })).status).toBe(200)

    const a = await request(server).post('/api/diocese/assessments')
      .set(auth(dio.token)).send({ fiscal_year: '2020', rate_bps: 1000 })
    expect(a.status).toBe(201)
    const line = a.body.lines.find(l => l.parish_org_id === par.orgId)
    expect(Number(line.base)).toBe(30000)
    expect(Number(line.assessed)).toBe(3000)

    const roll = await request(server).get('/api/diocese/financials?start=2020-01-01&end=2020-12-31')
      .set(auth(dio.token))
    const p = roll.body.parishes.find(x => x.parish_org_id === par.orgId)
    expect(p.periods).toBe(2)
    expect(Number(p.assessable_base)).toBe(30000)
  })

  // THIS TEST'S PREMISE EXPIRED, AND THAT IS THE POINT.
  //
  // It used to insert two overlapping 'submitted' rows directly — its own
  // comment said "a race, or data from before this guard" — and then assert
  // the chancery's approve refused the second. Migration 098 makes that
  // state unreachable: the exclusion constraint is partial on
  // status IN ('submitted','approved'), so the SECOND INSERT is refused by
  // the database, and the scenario the test constructed cannot occur.
  //
  // Rewritten to pin the stronger guarantee rather than deleted, because
  // "the app checks" and "the database cannot hold it" are different
  // promises and only the second survives a race, a psql session, or a
  // future route nobody has written yet.
  //
  // Worth recording plainly: with 098 in place, findOverlappingSubmission's
  // APPROVE-path call can no longer find anything, because two live
  // overlapping rows cannot coexist for it to find. That guard is now
  // redundant. It is left where it is — it costs one query and it is the
  // friendly sentence if the constraint is ever dropped — but this comment
  // is here so nobody later reads its presence as evidence that the
  // approve path is where the invariant lives. It is not. It lives in 098.
  it('the DATABASE refuses a second overlapping live period, not just the route', async () => {
    const mk = (s, e, status = 'submitted') => pool.query(
      `INSERT INTO ochr_report_submissions
         (organization_id, diocese_org_id, period_start, period_end, status, totals_json)
       VALUES ($1, $2, $3, $4, $5, '{"totals":{"assessable_base":"1000.00"}}')
       RETURNING id`,
      [par.orgId, dio.orgId, s, e, status]).then(r => r.rows[0].id)

    // Years used ONLY by this test. The first draft reused 2019/2020/2021
    // and collided with periods the tests above had already created — the
    // failure was a duplicate-key on the exact-pair UNIQUE, which looked
    // exactly like the constraint under test misfiring. A fixture that
    // shares a namespace with its neighbours cannot tell you which one
    // spoke.
    const fy = await mk('2031-01-01', '2031-12-31')
    expect((await review(fy, { status: 'approved' })).status).toBe(200)

    // A second live period overlapping the approved full year — refused by
    // the constraint, bypassing every route. Deliberately NOT the identical
    // range: an exact duplicate trips the older exact-pair UNIQUE (23505)
    // first, which would pass this test for the wrong reason.
    await expect(mk('2031-07-01', '2031-12-31')).rejects.toMatchObject({ code: '23P01' })

    // CONTROL 1: a NON-overlapping period is still perfectly acceptable.
    const q1 = await mk('2032-01-01', '2032-03-31')
    // pg returns BIGSERIAL as a string; Number() or this assertion lies.
    expect(Number(q1)).toBeGreaterThan(0)

    // CONTROL 2: the bounds are INCLUSIVE. Abutting periods are fine;
    // sharing a single day is an overlap. If daterange were '[)' the second
    // of these would be wrongly allowed.
    const abutting = await mk('2032-04-01', '2032-06-30')
    expect(Number(abutting)).toBeGreaterThan(0)
    await expect(mk('2032-06-30', '2032-09-30')).rejects.toMatchObject({ code: '23P01' })

    // CONTROL 3: a RETURNED period may overlap — that is the remedy the
    // 409 messages point at, and forbidding it would forbid the fix.
    const returned = await mk('2033-01-01', '2033-12-31', 'returned')
    const correction = await mk('2033-07-01', '2033-12-31')
    expect(Number(returned)).toBeGreaterThan(0)
    expect(Number(correction)).toBeGreaterThan(0)
  })

  it('the route still answers 409 rather than 500 when the constraint is what refused', async () => {
    // The race the constraint exists for: both requests pass the
    // check-then-write and the database refuses the loser. The parish must
    // read the same sentence either way, not "Failed to submit the period".
    const s1 = await submit('2034-01-01', '2034-12-31')
    expect(s1.status).toBe(201)
    const overlapping = await submit('2034-06-01', '2034-08-31')
    expect(overlapping.status).toBe(409)
    expect(overlapping.body.code).toBe('period_overlap')
  })
})

// ─────────────────────────────────────────────────────────────────────────
// D2 — a provider-charged gift is refunded, never deleted
// ─────────────────────────────────────────────────────────────────────────
describe('D2 — a charged gift cannot be deleted; refund is the only way back', () => {
  let par, fundId, onlineId, onlineRef
  const donorEmail = `ft_d2_donor_${RUN_ID}@example.com`
  const year = new Date().getUTCFullYear()

  const del = id => request(server).delete(`/api/donations/${id}`).set(auth(par.token))
  const refund = id => request(server).post(`/api/donations/${id}/refund`).set(auth(par.token))
  const summaryCount = async () => {
    const r = await request(server).get('/api/donations/summary').set(auth(par.token))
    return Number(r.body.total_count)
  }
  const previewHas = async () => {
    const r = await request(server).get(`/api/giving-statements/preview?year=${year}`).set(auth(par.token))
    return r.body.donors.some(d => d.donor_email === donorEmail)
  }

  beforeAll(async () => {
    process.env.PAYMENTS_PROVIDER = 'stub'
    par = await signup({ organizationName: `FT d2 Parish ${RUN_ID}`, name: 'Bookkeeper',
      email: `ft_d2_${RUN_ID}@example.com`, password: 'ft-pw-d2-1' })
    const f = await request(server).post('/api/funds').set(auth(par.token)).send({ name: `Roof ${RUN_ID}` })
    fundId = f.body.id
    const give = await request(server).post(`/api/public/${par.slug}/give`)
      .set('X-Forwarded-For', '10.61.8.1')
      .send({ fund_id: fundId, amount: 25.5, donor_name: 'Charged Donor', donor_email: donorEmail })
    expect(give.status).toBe(201)
    onlineRef = give.body.receipt.reference
    const { rows } = await pool.query('SELECT id FROM ochr_donations WHERE payment_ref = $1', [onlineRef])
    onlineId = rows[0].id
  }, 30_000)

  afterAll(() => { delete process.env.PAYMENTS_PROVIDER })

  it('a stub-charged public gift refuses DELETE with 409 and stays on the statement', async () => {
    expect(await previewHas()).toBe(true)
    const res = await del(onlineId)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/refund/i)
    const { rows } = await pool.query('SELECT payment_status FROM ochr_donations WHERE id = $1', [onlineId])
    expect(rows.length).toBe(1)
    expect(rows[0].payment_status).toBe('succeeded')
    expect(await previewHas()).toBe(true)
  })

  it('refunding it works, and the refunded row still refuses DELETE', async () => {
    const r = await refund(onlineId)
    expect(r.status).toBe(200)
    expect(r.body.payment_status).toBe('refunded')
    // Option A: the gift stays on the statement at live net 0.
    expect(await previewHas()).toBe(true)

    const res = await del(onlineId)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/refund/i)
    const { rows } = await pool.query('SELECT payment_status, amount FROM ochr_donations WHERE id = $1', [onlineId])
    expect(rows.length).toBe(1)
    expect(rows[0].payment_status).toBe('refunded')
    expect(Number(rows[0].amount)).toBe(25.5)
  })

  it('a manual gift (no payment_ref) deletes with 204 as before', async () => {
    const g = await request(server).post('/api/donations').set(auth(par.token))
      .send({ donor_name: 'Cash Donor', amount: 20, date: `${year}-03-01` })
    expect(g.status).toBe(201)
    expect((await del(g.body.id)).status).toBe(204)
    const { rows } = await pool.query('SELECT 1 FROM ochr_donations WHERE id = $1', [g.body.id])
    expect(rows.length).toBe(0)
  })

  it('a recurring-source gift the cron charged can be refunded, and stays on /summary at net 0', async () => {
    const before = await summaryCount()
    const { rows } = await pool.query(
      `INSERT INTO ochr_donations
         (organization_id, donor_name, amount, category, method, date, source, fund_id, payment_ref, payment_status)
       VALUES ($1, 'Monthly Donor', 40, 'Roof', 'online', CURRENT_DATE, 'recurring', $2, $3, 'succeeded')
       RETURNING id`,
      [par.orgId, fundId, `stub_rec_${RUN_ID}`])
    expect(await summaryCount()).toBe(before + 1)

    const r = await refund(rows[0].id)
    expect(r.status).toBe(200)
    expect(r.body.payment_status).toBe('refunded')
    expect(Number(r.body.amount)).toBe(40)
    expect(Number(r.body.live_amount)).toBe(0)
    // Option A: the gift remains in the count; live totals drop by the refund.
    expect(await summaryCount()).toBe(before + 1)
  })

  it("an 'online' row with no payment_ref is not sent to the provider — 400, pointing at delete", async () => {
    const { rows } = await pool.query(
      `INSERT INTO ochr_donations (organization_id, donor_name, amount, method, date, source)
       VALUES ($1, 'Imported Online Donor', 15, 'online', CURRENT_DATE, 'online') RETURNING id`,
      [par.orgId])
    const r = await refund(rows[0].id)
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/delet/i)
    const { rows: after } = await pool.query('SELECT payment_status FROM ochr_donations WHERE id = $1', [rows[0].id])
    expect(after[0].payment_status).not.toBe('refunded')
  })
})

// ─────────────────────────────────────────────────────────────────────────
// D3 — a fund with gifts is deactivated, never deleted
// ─────────────────────────────────────────────────────────────────────────
describe('D3 — deleting a fund with gifts is refused; deactivate instead', () => {
  let par, restrictedId, giftId
  const base = async () => {
    const r = await request(server).get('/api/finance/summary?start=2019-01-01&end=2019-12-31').set(auth(par.token))
    return Number(r.body.totals.assessable_base)
  }

  beforeAll(async () => {
    par = await signup({ organizationName: `FT d3 Parish ${RUN_ID}`, name: 'Treasurer',
      email: `ft_d3_${RUN_ID}@example.com`, password: 'ft-pw-d3-1' })
    const f = await request(server).post('/api/funds').set(auth(par.token))
      .send({ name: `Second Collection ${RUN_ID}` })
    restrictedId = f.body.id
    // Pass-through: not the parish's revenue, not assessable.
    const map = await request(server).put('/api/finance/mappings').set(auth(par.token))
      .send({ mappings: [{ source_type: 'fund', source_key: String(restrictedId), account_code: '4510' }] })
    expect(map.status).toBe(200)
    const g = await request(server).post('/api/donations').set(auth(par.token))
      .send({ donor_name: 'Restricted Donor', amount: 5000, date: '2019-06-15', fund_id: restrictedId })
    expect(g.status).toBe(201)
    giftId = g.body.id
    expect(await base()).toBe(0)
  }, 30_000)

  it('DELETE on a fund with gifts → 409; the gift keeps its fund and the base does not move', async () => {
    const res = await request(server).delete(`/api/funds/${restrictedId}`).set(auth(par.token))
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/1 gift/)
    expect(res.body.error).toMatch(/deactivate/i)

    const { rows } = await pool.query('SELECT fund_id FROM ochr_donations WHERE id = $1', [giftId])
    expect(Number(rows[0].fund_id)).toBe(Number(restrictedId))
    expect(await base()).toBe(0)   // was 5000 after the delete: SET NULL → default 4420, assessable
  })

  it('a fund with no gifts still deletes with 204', async () => {
    const f = await request(server).post('/api/funds').set(auth(par.token)).send({ name: `Empty ${RUN_ID}` })
    const res = await request(server).delete(`/api/funds/${f.body.id}`).set(auth(par.token))
    expect(res.status).toBe(204)
  })

  it('deactivating the fund works and the public give page stops listing it', async () => {
    const pub0 = await request(server).get(`/api/public/${par.slug}/funds`)
    expect(pub0.body.funds.some(f => f.id === restrictedId)).toBe(true)

    const patch = await request(server).patch(`/api/funds/${restrictedId}`).set(auth(par.token)).send({ active: false })
    expect(patch.status).toBe(200)
    expect(patch.body.active).toBe(false)

    const pub1 = await request(server).get(`/api/public/${par.slug}/funds`)
    expect(pub1.body.funds.some(f => f.id === restrictedId)).toBe(false)
    expect(await base()).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// D4 — a webhook we failed to process is NOT acknowledged
// ─────────────────────────────────────────────────────────────────────────
describe('D4 — a non-signature webhook failure returns 500 so the provider retries', () => {
  let par
  const WH_SECRET = 'whsec_ft_secret'
  const signed = (bodyStr, secret = WH_SECRET, t = Math.floor(Date.now() / 1000)) =>
    `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${bodyStr}`).digest('hex')}`
  const post = (body, sig) => request(server).post('/api/billing/webhook')
    .set('Content-Type', 'application/json').set('stripe-signature', sig).send(body)

  beforeAll(async () => {
    par = await signup({ organizationName: `FT d4 Parish ${RUN_ID}`, name: 'Admin',
      email: `ft_d4_${RUN_ID}@example.com`, password: 'ft-pw-d4-1' })
    process.env.BILLING_PROVIDER_SECRET = 'sk_test_ft'
    process.env.BILLING_WEBHOOK_SECRET = WH_SECRET
  })
  afterAll(() => {
    delete process.env.BILLING_PROVIDER_SECRET
    delete process.env.BILLING_WEBHOOK_SECRET
  })

  // THE FIXTURE THIS TEST USED IS NO LONGER A FAILURE — and that is a fix,
  // not a regression. It used to drive the INSERT into FK 23503 with a
  // fund id that does not exist, and assert 500 + no row. That 500 was
  // the honest answer to "we could not record it" — but a fund deleted
  // between Checkout and the webhook stays deleted, so the 500 repeated
  // on every redelivery until Stripe stopped trying, and the gift was
  // lost for good (falseSuccessMoney.test.js D4). A missing fund is now
  // resolved BEFORE the INSERT and the gift recorded undesignated.
  //
  // The property this test exists for — a processing failure is answered
  // 5xx, never 200 — is kept, with a failure that is still a failure: the
  // INSERT itself refused by a trigger. The provider must be told to
  // redeliver, and no row may exist to make the redelivery a no-op.
  it('a donation whose INSERT fails → 500, no row (the provider must redeliver)', async () => {
    await pool.query(`
      CREATE OR REPLACE FUNCTION zz_ft_boom_donation() RETURNS trigger AS $$
      BEGIN
        IF NEW.donor_name = 'FT Lost Donor' THEN RAISE EXCEPTION 'chaos: donation insert refused'; END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS zz_ft_boom_donation ON ochr_donations;
      CREATE TRIGGER zz_ft_boom_donation BEFORE INSERT ON ochr_donations FOR EACH ROW EXECUTE FUNCTION zz_ft_boom_donation();
    `)
    try {
      const body = JSON.stringify({
        type: 'checkout.session.completed',
        data: { object: {
          id: `cs_ft_${RUN_ID}`, mode: 'payment', payment_intent: `pi_ft_${RUN_ID}`, amount_total: 4000,
          metadata: { kind: 'donation', organization_id: String(par.orgId), donor_name: 'FT Lost Donor', fund: 'Gone' },
        } },
      })
      const res = await post(body, signed(body))
      expect(res.status).toBe(500)
      expect(res.body.received).toBe(false)
      const { rows } = await pool.query('SELECT 1 FROM ochr_donations WHERE payment_ref = $1', [`pi_ft_${RUN_ID}`])
      expect(rows.length).toBe(0)
    } finally {
      await pool.query(`
        DROP TRIGGER IF EXISTS zz_ft_boom_donation ON ochr_donations;
        DROP FUNCTION IF EXISTS zz_ft_boom_donation();
      `)
    }
  })

  it('a fund id that no longer exists is no longer a failure: 200, row recorded undesignated', async () => {
    const body = JSON.stringify({
      type: 'checkout.session.completed',
      data: { object: {
        id: `cs_ft_gone_${RUN_ID}`, mode: 'payment', payment_intent: `pi_ft_gone_${RUN_ID}`, amount_total: 4000,
        metadata: { kind: 'donation', organization_id: String(par.orgId), fund_id: '999999999', donor_name: 'Lost Donor', fund: 'Gone' },
      } },
    })
    const res = await post(body, signed(body))
    expect(res.status).toBe(200)
    expect(res.body.handled).toBe('donation')
    const { rows } = await pool.query(
      'SELECT fund_id, category FROM ochr_donations WHERE payment_ref = $1', [`pi_ft_gone_${RUN_ID}`])
    expect(rows.length).toBe(1)
    expect(rows[0].fund_id).toBeNull()
    expect(rows[0].category).toBe('Gone')
  })

  it('a bad signature is still 400', async () => {
    const body = JSON.stringify({ type: 'invoice.finalized', data: { object: {} } })
    expect((await post(body, signed(body, 'whsec_wrong'))).status).toBe(400)
  })

  it('a handled event is still 200', async () => {
    const body = JSON.stringify({
      type: 'checkout.session.completed',
      data: { object: { id: `cs_ft_sub_${RUN_ID}`, mode: 'subscription', customer: `cus_ft_${RUN_ID}`,
        subscription: `sub_ft_${RUN_ID}`, metadata: { organization_id: String(par.orgId), plan: 'pro' } } },
    })
    const res = await post(body, signed(body))
    expect(res.status).toBe(200)
    expect(res.body.handled).toBe('checkout.session.completed')
  })
})

// ─────────────────────────────────────────────────────────────────────────
// D5 — /api/health tells "stub chosen" from "nothing chosen" apart
// ─────────────────────────────────────────────────────────────────────────
describe('D5 — /api/health reports payments_configured', () => {
  const saved = { p: process.env.PAYMENTS_PROVIDER, s: process.env.PAYMENTS_PROVIDER_SECRET }
  afterAll(() => {
    if (saved.p === undefined) delete process.env.PAYMENTS_PROVIDER; else process.env.PAYMENTS_PROVIDER = saved.p
    if (saved.s === undefined) delete process.env.PAYMENTS_PROVIDER_SECRET; else process.env.PAYMENTS_PROVIDER_SECRET = saved.s
  })

  it('nothing configured → provider "stub" but payments_configured false', async () => {
    delete process.env.PAYMENTS_PROVIDER
    delete process.env.PAYMENTS_PROVIDER_SECRET
    const res = await request(server).get('/api/health')
    expect(res.status).toBe(200)
    expect(res.body.payments_provider).toBe('stub')
    expect(res.body.payments_configured).toBe(false)
  })

  it("PAYMENTS_PROVIDER='stub' is a choice → payments_configured true", async () => {
    process.env.PAYMENTS_PROVIDER = 'stub'
    const res = await request(server).get('/api/health')
    expect(res.body.payments_provider).toBe('stub')
    expect(res.body.payments_configured).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// D6 — ledger money on a code that is no longer effective (the diocese
//      removed it, or the parish left the diocese that defined it) must be
//      SURFACED as unmapped, never silently dropped from the totals. The old
//      INNER JOIN in computePeriodTotals zeroed it: $12,000 of real ledger
//      money reported as $5,000 with no line and no error.
// ─────────────────────────────────────────────────────────────────────────
describe('D6 — money on a no-longer-effective code is surfaced as unmapped, not silently dropped', () => {
  let dio, par
  const summary = (start, end) =>
    request(server).get(`/api/finance/summary?start=${start}&end=${end}`).set(auth(par.token))

  beforeAll(async () => {
    ;({ dio, par } = await affiliatedPair('d6'))
    // The diocese defines a revenue code; the parish books $7,000 to it while
    // affiliated, plus $5,000 on a template code every parish's chart has.
    await pool.query(
      `INSERT INTO ochr_coa_accounts (organization_id, code, name, acct_type, rollup_group, assessable, sort_order, active)
       VALUES ($1, '4950', 'Diocesan Special Collection', 'revenue', 'offerings', TRUE, 950, TRUE)
       ON CONFLICT DO NOTHING`,
      [dio.orgId])
    await pool.query(
      `INSERT INTO ochr_ledger_entries (organization_id, entry_date, account_code, amount, source_type, memo)
       VALUES ($1, '2024-05-01', '4110', 5000, 'manual', 'control: template code'),
              ($1, '2024-05-01', '4950', 7000, 'manual', 'money on the diocese-defined code')`,
      [par.orgId])
  }, 30_000)

  it('while affiliated, both codes count and nothing is unmapped', async () => {
    const res = await summary('2024-01-01', '2024-12-31')
    expect(res.status).toBe(200)
    expect(res.body.totals.revenue).toBe('12000.00')
    expect(res.body.totals.assessable_base).toBe('12000.00')
    expect(res.body.totals.unmapped).toBe('0.00')
  })

  it('after the parish leaves the diocese, the diocese-coded money is unmapped, not gone', async () => {
    await pool.query(`UPDATE ochr_diocese_affiliations SET status = 'ended' WHERE parish_org_id = $1`, [par.orgId])
    const res = await summary('2024-01-01', '2024-12-31')
    expect(res.status).toBe(200)
    // Classified revenue is only the template code the parish still owns…
    expect(res.body.totals.revenue).toBe('5000.00')
    expect(res.body.totals.assessable_base).toBe('5000.00')
    // …but the $7,000 did NOT vanish — it is surfaced as unmapped, with a line.
    expect(res.body.totals.unmapped).toBe('7000.00')
    const line = res.body.accounts.find(a => a.code === '4950')
    expect(line, 'the stale-coded money must still appear as an account line').toBeTruthy()
    expect(line.unmapped).toBe(true)
    expect(line.total).toBe('7000.00')
    // Every dollar in the raw ledger is still accounted for somewhere.
    const shown = Number(res.body.totals.revenue) + Number(res.body.totals.expense) + Number(res.body.totals.unmapped)
    expect(shown).toBe(12000)
  })
})
