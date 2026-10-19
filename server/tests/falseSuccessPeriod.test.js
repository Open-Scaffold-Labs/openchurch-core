// False success on a frozen period — four places where the system said
// "done" about a figure that was not the one it froze, or promised a way
// out that did not exist.
//
// Each block names the defect it closes, reproduced on 4 Sep against the
// real routes on local Postgres before anything was touched (probes under
// the audit's fsp/ directory):
//
//   D1  POST /api/finance/submissions computed the totals in one autocommit
//       SELECT and wrote the row in a second statement. A gift committed
//       between the two was inside the period and outside the frozen
//       totals, while the row's submitted_at said it should be in.
//   D2  PATCH /api/diocese/submissions/:id approved whatever the row held
//       at that instant. Returned → +$500,000 → resubmitted (same id) →
//       the chancery's click approved figures it had never seen.
//   D3  Publishing an assessment froze lines computed at draft time. An
//       approval landing after the draft was silently missing from the
//       bill, and the base could not be corrected once published.
//   D4  The overlap 409s told the parish to "ask the chancery to return
//       that period" — but an APPROVED period cannot be returned (the
//       review UPDATE requires status = 'submitted'; return → 404).
//
// Every block signs up its own orgs and shares nothing with the rest of
// the suite, in the pattern of financialTruth.test.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'
import * as fiscalPeriod from '../src/finance/fiscalPeriod.js'

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
  const res = await createOrg(server, payload, `10.62.9.${++ipSeq}`)
  expect(res.status).toBe(201)
  cleanupOrgIds.push(res.body.user.organization.id)
  return { token: res.body.token, orgId: res.body.user.organization.id, slug: res.body.user.organization.slug }
}

const auth = t => ({ Authorization: `Bearer ${t}` })

// Diocese + parish, affiliated at 'detail'.
async function affiliatedPair(tag) {
  const email = `fsp_${tag}_par_${RUN_ID}@example.com`
  const dio = await signup({ organizationName: `FSP ${tag} Diocese ${RUN_ID}`, name: 'Canon',
    email: `fsp_${tag}_dio_${RUN_ID}@example.com`, password: 'fsp-pw-dio-1', organizationType: 'diocese' })
  const par = await signup({ organizationName: `FSP ${tag} Parish ${RUN_ID}`, name: 'Parish Admin',
    email, password: 'fsp-pw-par-1' })
  const inv = await request(server).post('/api/diocese/parishes/invite').set(auth(dio.token)).send({ email })
  expect(inv.status).toBeLessThan(300)
  const acc = await request(server).post('/api/affiliation/accept').set(auth(par.token)).send({ grant_level: 'detail' })
  expect(acc.status).toBe(200)
  return { dio, par }
}

const submit = (par, start, end) => request(server).post('/api/finance/submissions')
  .set(auth(par.token)).send({ period_start: start, period_end: end })
const review = (dio, id, body) => request(server).patch(`/api/diocese/submissions/${id}`)
  .set(auth(dio.token)).send(body)
const gift = (par, amount, date) => request(server).post('/api/donations')
  .set(auth(par.token)).send({ donor_name: 'Snapshot Donor', amount, date })
const listSubs = dio => request(server).get('/api/diocese/submissions').set(auth(dio.token))
const frozen = id => pool.query(
  `SELECT status, submitted_at, totals_json->'totals'->>'revenue' AS revenue
     FROM ochr_report_submissions WHERE id = $1`, [id]).then(r => r.rows[0])

// ─────────────────────────────────────────────────────────────────────────
// D1 — the frozen totals and submitted_at describe the same instant
// ─────────────────────────────────────────────────────────────────────────
describe('D1 — a submission freezes exactly what had committed at submitted_at', () => {
  let dio, par
  const P = ['2024-01-01', '2024-12-31']

  // The window is opened by the totals query itself: whichever connection
  // runs the "FROM ochr_parish_ledger … GROUP BY l.account_code" SELECT is
  // paused the moment it returns, a gift is committed on ANOTHER
  // connection, and only then is the request allowed to continue. Under
  // the old code the pause sits between the autocommit SELECT and the
  // INSERT, which is precisely the gap the defect lived in; under the fix
  // the pause is inside one REPEATABLE READ transaction, so the gift is
  // after the snapshot AND after NOW(). Both the query on the pool and the
  // query on a checked-out client are wrapped, because the fix moves the
  // SELECT from one to the other.
  const isTotalsSql = sql => /FROM ochr_parish_ledger l/.test(sql) && /GROUP BY l\.account_code/.test(sql)
  // The route's FIRST read — the affiliation lookup. A window opened here
  // sits after the transaction has begun and before the totals are read.
  const isFirstReadSql = sql => /FROM ochr_diocese_affiliations/.test(sql) && /parish_org_id = \$1 AND status = 'active'/.test(sql)
  function armTotalsWindow(isTarget = isTotalsSql) {
    const state = { armed: true, opened: null, release: null, restore: [] }
    const windowOpen = new Promise(r => { state.opened = r })
    const released = new Promise(r => { state.release = r })
    const wrap = (target) => {
      const orig = target.query
      state.restore.push(() => { target.query = orig })
      target.query = async function (text, ...rest) {
        const result = await orig.call(this, text, ...rest)
        const sql = typeof text === 'string' ? text : text?.text ?? ''
        if (state.armed && isTarget(sql)) { state.armed = false; state.opened(); await released }
        return result
      }
    }
    wrap(pool)
    const origConnect = pool.connect
    state.restore.push(() => { pool.connect = origConnect })
    pool.connect = function (...args) {
      // pg's own pool.query() uses the callback form of connect; only the
      // promise form hands the app a client to wrap.
      if (typeof args[args.length - 1] === 'function') return origConnect.apply(this, args)
      return origConnect.apply(this, args).then(client => { if (state.armed) wrap(client); return client })
    }
    return {
      windowOpen,
      release: () => state.release(),
      restore: () => { for (const fn of state.restore.reverse()) fn() },
    }
  }

  beforeAll(async () => {
    ;({ dio, par } = await affiliatedPair('d1'))
  }, 30_000)

  it('control: a gift committed BEFORE the submit is in the frozen totals', async () => {
    expect((await gift(par, 1000, '2024-03-15')).status).toBe(201)
    const sub = await submit(par, ...P)
    expect(sub.status).toBe(201)
    expect(sub.body.totals.revenue).toBe('1000.00')
    const row = await frozen(sub.body.id)
    expect(row.revenue).toBe('1000.00')
    // Reset for the race below: same period, returned, so it resubmits in place.
    expect((await review(dio, sub.body.id, { status: 'returned', note: 'race fixture' })).status).toBe(200)
  })

  it('a gift committed AFTER the snapshot is outside the totals AND after submitted_at', async () => {
    const win = armTotalsWindow()
    let g
    try {
      // supertest is lazy: the request is not sent until something awaits it.
      const pending = submit(par, ...P).then(r => r)
      await Promise.race([win.windowOpen,
        new Promise((_, j) => setTimeout(() => j(new Error('the totals query never ran')), 8000))])
      // The submit is now paused with its totals in hand. Commit a gift
      // inside the period on another connection.
      g = await gift(par, 777, '2024-06-01')
      expect(g.status).toBe(201)
      win.release()
      const sub = await pending
      expect(sub.status).toBe(201)
    } finally {
      win.restore()
    }

    const { rows: [sub] } = await pool.query(
      `SELECT id FROM ochr_report_submissions
        WHERE organization_id = $1 AND period_start = $2 AND period_end = $3`, [par.orgId, ...P])
    const row = await frozen(sub.id)
    expect(row.status).toBe('submitted')
    // The gift is genuinely inside the period — the live view has it…
    const live = await request(server).get(`/api/finance/summary?start=${P[0]}&end=${P[1]}`).set(auth(par.token))
    expect(live.body.totals.revenue).toBe('1777.00')
    // …and the frozen totals do not, which is only honest if the row's own
    // timestamp agrees: everything committed before submitted_at is in,
    // everything after is out. Under the old code this row said 1000.00
    // with a submitted_at LATER than the gift it excluded.
    expect(row.revenue).toBe('1000.00')
    const { rows: [order] } = await pool.query(
      `SELECT s.submitted_at <= d.created_at AS consistent, s.submitted_at, d.created_at
         FROM ochr_report_submissions s, ochr_donations d
        WHERE s.id = $1 AND d.id = $2`, [sub.id, g.body.id])
    expect(order.consistent, `submitted_at ${order.submitted_at.toISOString()} must not be after the excluded gift's created_at ${order.created_at.toISOString()}`).toBe(true)
  }, 30_000)

  it('the inverse lie is closed too: a gift committed after the transaction began is not INCLUDED either', async () => {
    // The first test pins "excluded ⇒ not before submitted_at". This one
    // pins "after submitted_at ⇒ excluded": the snapshot is the
    // transaction's, taken at its first read, not the totals query's own.
    // A route that stamped submitted_at at BEGIN but read the totals on a
    // separate autocommit connection — or at READ COMMITTED — would
    // freeze a gift its own timestamp says arrived later.
    const { rows: [{ id }] } = await pool.query(
      `SELECT id FROM ochr_report_submissions WHERE organization_id = $1 AND period_start = $2`, [par.orgId, P[0]])
    expect((await review(dio, id, { status: 'returned', note: 'race fixture 2' })).status).toBe(200)

    const win = armTotalsWindow(isFirstReadSql)
    let g
    try {
      const pending = submit(par, ...P).then(r => r)
      await Promise.race([win.windowOpen,
        new Promise((_, j) => setTimeout(() => j(new Error('the affiliation read never ran')), 8000))])
      g = await gift(par, 555, '2024-09-01')
      expect(g.status).toBe(201)
      win.release()
      const sub = await pending
      expect(sub.status).toBe(201)
      expect(sub.body.id).toBe(id)
    } finally {
      win.restore()
    }
    const row = await frozen(id)
    // 1000 + 777 had committed before this transaction began; 555 had not.
    expect(row.revenue).toBe('1777.00')
    const { rows: [order] } = await pool.query(
      `SELECT s.submitted_at <= d.created_at AS consistent
         FROM ochr_report_submissions s, ochr_donations d WHERE s.id = $1 AND d.id = $2`, [id, g.body.id])
    expect(order.consistent).toBe(true)
  }, 30_000)

  it('the resubmit-in-place and overlap refusals still work inside the transaction', async () => {
    // Overlap with the live 2024 period → 409, nothing written.
    const ov = await submit(par, '2024-06-01', '2024-08-31')
    expect(ov.status).toBe(409)
    expect(ov.body.code).toBe('period_overlap')
    // Identical period while submitted → the ON CONFLICT 409.
    const dupe = await submit(par, ...P)
    expect(dupe.status).toBe(409)
    expect(dupe.body.error).toMatch(/already submitted or approved/)
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM ochr_report_submissions WHERE organization_id = $1`, [par.orgId])
    expect(rows[0].n).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// D2 — the chancery approves the figures it loaded, or is told to reload
// ─────────────────────────────────────────────────────────────────────────
describe('D2 — approve carries what the chancery saw; a resubmit in between is a 409', () => {
  let dio, par
  const P = ['2025-01-01', '2025-12-31']
  const seen = async id => (await listSubs(dio)).body.submissions.find(s => s.id === id)

  beforeAll(async () => {
    ;({ dio, par } = await affiliatedPair('d2'))
    expect((await gift(par, 1000, '2025-03-15')).status).toBe(201)
  }, 30_000)

  it('stale expected_submitted_at → 409 submission_changed, row still submitted', async () => {
    const s1 = await submit(par, ...P)
    expect(s1.status).toBe(201)
    const loaded = await seen(s1.body.id)
    expect(loaded.submitted_at).toBeTruthy()
    expect(loaded.totals.revenue).toBe('1000.00')

    // The parish is returned, adds $500,000, and resubmits under the SAME id.
    expect((await review(dio, s1.body.id, { status: 'returned', note: 'please check' })).status).toBe(200)
    expect((await gift(par, 500000, '2025-10-01')).status).toBe(201)
    const s2 = await submit(par, ...P)
    expect(s2.status).toBe(201)
    expect(s2.body.id).toBe(s1.body.id)

    // The chancery clicks Approve on the row it loaded before all that.
    const apr = await review(dio, s1.body.id, { status: 'approved', expected_submitted_at: loaded.submitted_at })
    expect(apr.status).toBe(409)
    expect(apr.body.code).toBe('submission_changed')
    expect(apr.body.error).toMatch(/resubmitted/i)
    expect(apr.body.error).toMatch(/reload/i)
    const row = await frozen(s1.body.id)
    expect(row.status).toBe('submitted')
    expect(row.revenue).toBe('501000.00')
  })

  it('current expected_submitted_at → 200, even though JSON carries milliseconds and Postgres microseconds', async () => {
    const { rows: [{ id }] } = await pool.query(
      `SELECT id FROM ochr_report_submissions WHERE organization_id = $1 AND period_start = $2`, [par.orgId, P[0]])
    // Make the precision gap real rather than probable: a stored value with
    // a non-zero microsecond tail can never equal its millisecond rendering.
    await pool.query(
      `UPDATE ochr_report_submissions
          SET submitted_at = date_trunc('milliseconds', submitted_at) + interval '123 microseconds'
        WHERE id = $1`, [id])
    const loaded = await seen(id)
    expect(loaded.status).toBe('submitted')
    const apr = await review(dio, id, { status: 'approved', expected_submitted_at: loaded.submitted_at })
    expect(apr.status).toBe(200)
    expect(apr.body.status).toBe('approved')
  })

  it('no expected_submitted_at → 200 as before (other callers are not broken)', async () => {
    expect((await gift(par, 250, '2026-02-01')).status).toBe(201)
    const s = await submit(par, '2026-01-01', '2026-12-31')
    expect(s.status).toBe(201)
    const apr = await review(dio, s.body.id, { status: 'approved' })
    expect(apr.status).toBe(200)
    expect(apr.body.status).toBe('approved')
  })

  it('an unparseable expected_submitted_at is a 400, not a silent pass', async () => {
    const s = await submit(par, '2027-01-01', '2027-12-31')
    expect(s.status).toBe(201)
    const apr = await review(dio, s.body.id, { status: 'approved', expected_submitted_at: 'yesterday-ish' })
    expect(apr.status).toBe(400)
    expect((await frozen(s.body.id)).status).toBe('submitted')
  })
})

// ─────────────────────────────────────────────────────────────────────────
// D3 — a bill is published only if it is still true
// ─────────────────────────────────────────────────────────────────────────
describe('D3 — publish refuses a bill whose bases have moved since it was computed', () => {
  const asmt = (dio, body) => request(server).post('/api/diocese/assessments').set(auth(dio.token)).send(body)
  const patchA = (dio, id, body) => request(server).patch(`/api/diocese/assessments/${id}`).set(auth(dio.token)).send(body)
  const recompute = (dio, id) => request(server).post(`/api/diocese/assessments/${id}/recompute`).set(auth(dio.token))

  it('draft → another approval for the year → publish 409 assessment_stale; recompute → publish 200', async () => {
    const { dio, par } = await affiliatedPair('d3')
    expect((await gift(par, 10000, '2019-02-01')).status).toBe(201)
    expect((await gift(par, 20000, '2019-09-01')).status).toBe(201)

    const h1 = await submit(par, '2019-01-01', '2019-06-30')
    expect((await review(dio, h1.body.id, { status: 'approved' })).status).toBe(200)
    const a = await asmt(dio, { fiscal_year: 2019, rate_bps: 1000 })
    expect(a.status).toBe(201)
    expect(a.body.lines[0].base).toBe('10000.00')

    // H2 is approved AFTER the draft was computed.
    const h2 = await submit(par, '2019-07-01', '2019-12-31')
    expect((await review(dio, h2.body.id, { status: 'approved' })).status).toBe(200)

    const pub = await patchA(dio, a.body.id, { status: 'published' })
    expect(pub.status).toBe(409)
    expect(pub.body.code).toBe('assessment_stale')
    expect(pub.body.error).toMatch(/recompute/i)
    expect(pub.body.changed.map(c => c.parish_org_id)).toContain(par.orgId)
    // Nothing was frozen.
    const { rows: [st] } = await pool.query('SELECT status FROM ochr_assessments WHERE id = $1', [a.body.id])
    expect(st.status).toBe('draft')
    const { rows: [line] } = await pool.query(
      'SELECT base FROM ochr_assessment_lines WHERE assessment_id = $1', [a.body.id])
    expect(line.base).toBe('10000.00')

    const rc = await recompute(dio, a.body.id)
    expect(rc.status).toBe(200)
    expect(rc.body.lines[0].base).toBe('30000.00')
    const pub2 = await patchA(dio, a.body.id, { status: 'published' })
    expect(pub2.status).toBe(200)
    expect(pub2.body.status).toBe('published')
    expect(pub2.body.lines[0].base).toBe('30000.00')
    expect(pub2.body.lines[0].assessed).toBe('3000.00')
  }, 30_000)

  it('control: no change since the draft → publish 200', async () => {
    const { dio, par } = await affiliatedPair('d3c')
    expect((await gift(par, 5000, '2018-04-01')).status).toBe(201)
    const fy = await submit(par, '2018-01-01', '2018-12-31')
    expect((await review(dio, fy.body.id, { status: 'approved' })).status).toBe(200)
    const a = await asmt(dio, { fiscal_year: 2018, rate_bps: 1000 })
    expect(a.status).toBe(201)
    const pub = await patchA(dio, a.body.id, { status: 'published' })
    expect(pub.status).toBe(200)
    expect(pub.body.status).toBe('published')
    expect(pub.body.lines[0].base).toBe('5000.00')
  }, 30_000)
})

// ─────────────────────────────────────────────────────────────────────────
// D4 — the 409 promises only remedies that exist
// ─────────────────────────────────────────────────────────────────────────
describe('D4 — the overlap 409 names a remedy that is actually available', () => {
  let dio, par
  beforeAll(async () => {
    ;({ dio, par } = await affiliatedPair('d4'))
  }, 30_000)

  it('overlapping an APPROVED period: says it cannot be reopened, never "return"', async () => {
    const fy = await submit(par, '2030-01-01', '2030-12-31')
    expect(fy.status).toBe(201)
    expect((await review(dio, fy.body.id, { status: 'approved' })).status).toBe(200)
    // The remedy the old sentence offered does not exist:
    const ret = await review(dio, fy.body.id, { status: 'returned', note: 'undo' })
    expect(ret.status).toBe(404)

    const h2 = await submit(par, '2030-07-01', '2030-12-31')
    expect(h2.status).toBe(409)
    expect(h2.body.code).toBe('period_overlap')
    expect(h2.body.error).toContain('approved')
    expect(h2.body.error).not.toMatch(/return/i)
    expect(h2.body.error).toMatch(/cannot be reopened/i)
    expect(h2.body.error).toMatch(/contact the chancery/i)
  })

  it('overlapping a merely SUBMITTED period: the return remedy is real and is offered', async () => {
    const fy = await submit(par, '2031-01-01', '2031-12-31')
    expect(fy.status).toBe(201)
    const h2 = await submit(par, '2031-07-01', '2031-12-31')
    expect(h2.status).toBe(409)
    expect(h2.body.error).toContain('submitted')
    expect(h2.body.error).toMatch(/ask the chancery to return/i)
    expect(h2.body.error).not.toMatch(/reopened/i)
  })

  it("the chancery's side of the sentence follows the same rule", () => {
    // The approve-path 409 is unreachable while migration 098 holds (two
    // live overlapping rows cannot coexist), so its sentence is pinned
    // directly: it must never tell a chancery to return an approved period.
    const approved = fiscalPeriod.overlapRemedy({ status: 'approved' }, 'chancery')
    expect(approved).not.toMatch(/return the approved/i)
    expect(approved).toMatch(/cannot be reopened/i)
    const submitted = fiscalPeriod.overlapRemedy({ status: 'submitted' }, 'chancery')
    expect(submitted).toMatch(/return/i)
  })
})
